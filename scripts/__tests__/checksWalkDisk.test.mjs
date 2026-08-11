import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { sources, SKIP_DIRS } from './sourceFiles.mjs'

// #522. Three static checks asked git which files exist. `git ls-files` reports **tracked** files only, and a
// file that was just created is exactly the state a new violation is in — so each of those checks was blind to
// the one file it existed to look at. Measured on `agentSendTyped`: an offender planted in
// `packages/ios-agent/src` left all 6 of its tests passing while untracked, and failed the moment `git add -N`
// made it visible.
//
// Fixing the three instances is worth less than this file, because the pattern is what recurs: asking git is
// the obvious way to enumerate a package, it reads as more authoritative than a directory walk, and the hole
// it opens is invisible — the check goes green.
//
// The cost was never a bypass, and saying so plainly matters for judging this: pre-commit runs lint and
// typecheck rather than vitest, and by push time the file is tracked, so CI catches it. What was lost is the
// local signal — green on the machine that introduced the offender, red in CI, and nothing in the failure to
// say the two runs disagreed about which files existed.
//
// **The first version of this guard was defeated four ways in review**, and each defeat shaped an assertion
// below rather than being patched where it landed:
//
//  1. It scanned only `*.test.mjs` at the top of `scripts/__tests__`. Moving the git call into a sibling
//     helper module put it out of reach — and this change *created* that idiom by adding `sourceFiles.mjs`,
//     so the next person writes `trackedFiles.mjs`. One new file plus one changed import reopened the hole
//     with all three tests green.
//  2. Its regex required a quote on each side of the literal, so `` execSync(`git ls-files ${pkg}`) `` and
//     `'git ls-files ' + pkg` walked past it, as did `git ls-tree -r HEAD --name-only`, which lists tracked
//     files without containing the string at all.
//  3. `readdirSync` does not recurse, while vitest's include is `scripts/__tests__/**/*.test.mjs`. A check in
//     a subdirectory was run by vitest and unknown to the guard.
//  4. (Not a defeat of this file, but found with it.) The extraction had quietly dropped `.d.ts` from the
//     walk — see `sourceFiles.mjs`.

const root = join(import.meta.dirname, '../..')
const scriptsDir = join(root, 'scripts')
const SELF = relative(root, import.meta.filename)

/** Comments stripped, so prose *about* this rule — which every file involved contains — cannot trip it. */
const code = (path) =>
  readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** Every `.mjs` under `scripts/`, recursively: checks, helpers a check imports, and checks in subdirectories.
 *  Walked rather than listed by git, for the reason this whole file is about — a guard against a listing that
 *  cannot see new files, built on that listing, is blind to the new file, which is the case it exists for.
 *
 *  **Not `SKIP_DIRS`**, which is for walks over *sources* and therefore skips `__tests__` — where every check
 *  lives. Reusing it here reduced this walk to the 7 top-level scripts and was caught only by the floor
 *  assertion below, which is the case that assertion exists for. */
const NOT_MODULES = new Set(['node_modules', 'dist', 'coverage'])
function scriptModules(dir = scriptsDir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!NOT_MODULES.has(e.name) && !e.name.startsWith('.')) scriptModules(join(dir, e.name), out)
    } else if (e.name.endsWith('.mjs')) {
      out.push(join(dir, e.name))
    }
  }
  return out
}

describe('static checks enumerate the tree from disk, not from git', () => {
  const modules = scriptModules().filter((p) => relative(root, p) !== SELF)

  it('no script module asks git which files exist', () => {
    // `ls-tree` as well as `ls-files`: both report tracked paths only, and the second is the natural
    // substitute once the first is forbidden. Unanchored, so a template literal or a concatenated command
    // matches — the spelling that defeated the first version of this assertion.
    //
    // What this does not catch is deliberate obfuscation (`'ls' + '-files'`), and it is not trying to. The
    // failure mode being guarded is someone reaching for the obvious tool, not someone hiding it. The import
    // assertion below is the structural half that does not depend on spelling at all.
    expect(modules.length).toBeGreaterThan(15) // derivation broke ⇒ everything below passes vacuously

    const offenders = modules.filter((p) => /\bls-(files|tree)\b/.test(code(p))).map((p) => relative(root, p))
    expect(
      offenders,
      `these modules ask git which files exist, which cannot see an untracked offender — ` +
      `import { sources } from './sourceFiles.mjs' instead (#522)`,
    ).toEqual([])
  })

  it('every module that enumerates files gets the walk from sourceFiles.mjs', () => {
    // The structural half, and the one that catches the defeat the spelling check was designed around: the
    // review reopened the hole by adding `trackedFiles.mjs` exporting its own `sources()` and changing one
    // import line. The call site read identically, so nothing about the call could tell the difference.
    const wrong = []
    for (const p of modules) {
      const src = code(p)
      if (!/\bsources\s*\(/.test(src)) continue
      if (relative(root, p) === 'scripts/__tests__/sourceFiles.mjs') continue // it *is* the walk
      if (!/from\s+'\.\/sourceFiles\.mjs'/.test(src)) wrong.push(relative(root, p))
    }
    expect(
      wrong,
      `these modules call sources() but do not import it from './sourceFiles.mjs' — a second walk is how ` +
      `the git listing comes back under a name this check does not know (#522)`,
    ).toEqual([])
  })

  it('the walk sees a file git has never heard of', () => {
    // The assertions above are about how the checks are written. This one is about what the walk does, and the
    // pair is what makes the rule real: alone, the others would still pass if `sources` itself were rewritten
    // to shell out.
    //
    // The probe lives under `scripts/`, deliberately not under `packages/`. Nothing walks `scripts/` for
    // sources, whereas three checks walk `packages/` — and vitest runs files in parallel, so a probe there
    // shares a namespace with a tree another worker is enumerating. A leaked directory would then be reported
    // as a real path by `clientOutboundTyped`, and a removal mid-walk would break it with an ENOENT that has
    // nothing to do with its subject.
    const dir = mkdtempSync(join(scriptsDir, '__tests__', '.walkprobe-'))
    try {
      writeFileSync(join(dir, 'brandNew.ts'), 'export const x = 1\n')
      const rel = relative(root, dir)

      expect(sources(rel)).toContain(join(rel, 'brandNew.ts'))
      // And git genuinely cannot see it, so the two disagree — which is the whole finding.
      expect(execFileSync('git', ['ls-files', rel], { cwd: root, encoding: 'utf8' }).trim()).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips the directories a source check never wants, and keeps .d.ts', () => {
    // `__tests__` is in the skip set because all three callers filtered it by hand. Dropping it widens every
    // one of them — measured: three tests fail, two of them the consumer checks reporting their own fixtures
    // as offenders. So the set is load-bearing and the failure is loud, which is why membership is asserted
    // here as well as behaviour. `dist` likewise: a built copy of an offender would be reported at a path
    // nobody can fix.
    //
    // `.d.ts` is asserted **present**, which is the inverse of what this case first claimed. Excluding them
    // narrowed `browserInboundRouting`, whose subject is exactly what a declaration file holds — see
    // `sourceFiles.mjs`.
    const dir = mkdtempSync(join(scriptsDir, '__tests__', '.walkprobe-'))
    try {
      for (const d of ['__tests__', 'dist', 'node_modules']) {
        mkdirSync(join(dir, d))
        writeFileSync(join(dir, d, 'hidden.ts'), 'export const y = 1\n')
      }
      writeFileSync(join(dir, 'visible.ts'), 'export const z = 1\n')
      writeFileSync(join(dir, 'types.d.ts'), 'export declare const w: number\n')

      const rel = relative(root, dir)
      expect(sources(rel).sort()).toEqual([join(rel, 'types.d.ts'), join(rel, 'visible.ts')])
      expect(SKIP_DIRS.has('__tests__')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
