import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { sources, SKIP_DIRS } from './sourceFiles.mjs'

// #522. Three static checks asked git which files exist. `git ls-files` reports **tracked** files only, and a
// file that was just created is exactly the state a new violation is in — so each of those checks was blind to
// the one file it existed to look at. Measured on `agentSendTyped`: an offender planted in
// `packages/ios-agent/src` left all 6 of its tests passing while untracked, and failed the moment `git add -N`
// made it visible.
//
// Fixing the three instances is worth less than this file, because the pattern is what recurs: `git ls-files`
// is the obvious way to enumerate a package, it reads as more authoritative than a directory walk, and the
// resulting hole is invisible — the check goes green.
//
// The cost was never a bypass, and saying so plainly matters for judging this: pre-commit runs lint and
// typecheck rather than vitest, and by push time the file is tracked, so CI catches it. What was lost is the
// local signal — green on the machine that introduced the offender, red in CI, and nothing in the failure to
// say the two runs disagreed about which files existed.

const root = join(import.meta.dirname, '../..')
const SELF = 'checksWalkDisk.test.mjs'

describe('static checks enumerate the tree from disk, not from git', () => {
  it('no check derives a file list from git', () => {
    // Deliberately a property of the *checks*, not of one call site: the three that had this were found by
    // reading them, and the fourth will be written by someone who has not read this file.
    //
    // Enumerated with `readdirSync`, not `git ls-files`. A guard against a listing that cannot see new files,
    // built on that same listing, would be blind to the new check — which is the case it exists for.
    const checks = readdirSync(import.meta.dirname)
      .filter((f) => f.endsWith('.test.mjs') && f !== SELF)
    expect(checks.length).toBeGreaterThan(10) // derivation broke ⇒ everything below passes vacuously

    const offenders = checks.filter((f) =>
      /['"]ls-files['"]/.test(readFileSync(join(import.meta.dirname, f), 'utf8')))

    expect(
      offenders,
      `these checks enumerate files with 'git ls-files', which cannot see an untracked offender — ` +
      `import { sources } from './sourceFiles.mjs' instead (#522)`,
    ).toEqual([])
  })

  it('the walk sees a file git has never heard of', () => {
    // The assertion above is about spelling. This one is about behaviour, and the pair is what makes the rule
    // real: alone, the first would still pass if `sources` were rewritten to shell out to git.
    const dir = mkdtempSync(join(root, 'packages', '.walkprobe-'))
    try {
      writeFileSync(join(dir, 'brandNew.ts'), 'export const x = 1\n')
      const rel = dir.slice(root.length + 1)

      expect(sources(rel)).toContain(join(rel, 'brandNew.ts'))
      // And git genuinely cannot see it, so the two disagree — which is the whole finding.
      expect(execFileSync('git', ['ls-files', rel], { cwd: root, encoding: 'utf8' }).trim()).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips the directories a source check never wants, tests included', () => {
    // `__tests__` is in the skip set because all three callers filtered it by hand. Dropping it widens every
    // one of them — measured: three tests fail, two of them the consumer checks themselves reporting their own
    // fixtures as offenders. So the set is load-bearing and the failure is loud, which is why this case asserts
    // the membership as well as the behaviour: a caller that needs tests should walk them deliberately rather
    // than by editing this set. `dist` likewise — a built copy of an offender would be reported at a path
    // nobody can fix.
    const dir = mkdtempSync(join(root, 'packages', '.walkprobe-'))
    try {
      for (const d of ['__tests__', 'dist', 'node_modules']) {
        mkdirSync(join(dir, d))
        writeFileSync(join(dir, d, 'hidden.ts'), 'export const y = 1\n')
      }
      writeFileSync(join(dir, 'visible.ts'), 'export const z = 1\n')
      writeFileSync(join(dir, 'types.d.ts'), 'export declare const w: number\n')

      const rel = dir.slice(root.length + 1)
      expect(sources(rel)).toEqual([join(rel, 'visible.ts')])
      expect(SKIP_DIRS.has('__tests__')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
