import { readdirSync } from 'node:fs'
import { join } from 'node:path'

// Shared by every static check that asks "which files are in this part of the tree".
//
// **Walked from disk, never `git ls-files`.** That listing reports tracked files only, and a file that was
// just created is exactly the state a new violation is in — so a completeness check built on it reports
// nothing about the one file it exists to look at. Measured on `agentSendTyped`: a module calling
// `ws.send(JSON.stringify(…))` planted in `packages/ios-agent/src` left all 6 tests passing while it was
// untracked, and failed the moment `git add -N` made it visible.
//
// The cost was never a bypass — pre-commit runs lint and typecheck rather than vitest, and by push time the
// file is tracked, so CI catches it. What it cost was the **local signal**: green on the machine that
// introduced the offender, red in CI, and nothing in the failure to say the two runs disagreed about which
// files existed. `clientOutboundTyped` was moved off `git` for this reason and its comment named the two
// checks still on it; this module is that fix generalised, and `checksWalkDisk.test.mjs` is what stops a
// fourth check reintroducing the pattern. See #522.

/** Directories a source-completeness check never wants. `__tests__` is here because every current caller
 *  filtered it out by hand, and a caller that wants tests should walk them deliberately. Load-bearing rather
 *  than tidy: removing it makes both consumer checks report their own fixtures as offenders. */
export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', '__tests__', '.turbo'])

const repoRoot = join(import.meta.dirname, '../..')

/**
 * Every `.ts`/`.tsx` source file under `dir`, as **repo-root-relative** paths — the same shape
 * `git ls-files` produced, so call sites keep their existing filters and comparisons.
 *
 * `dir` may be absolute or repo-root-relative.
 *
 * **`.d.ts` files are included**, because excluding them narrowed a check that needs them. A first version
 * dropped them on the reasoning that a declaration file cannot contain a call site — true for
 * `agentSendTyped`, false for `browserInboundRouting`, whose subject is `export type X = { type: '…' } | …`
 * and which walks `packages/dashboard`, where two tracked `.d.ts` files live. Measured: a planted union in a
 * `.d.ts` was reported before the extraction and silently not after, and renaming it to `.ts` brought the
 * detection back — so the extension, not the content, decided it. The three call sites' original filters
 * (`endsWith('.ts')` and `/\.(ts|tsx)$/`) both admitted `.d.ts`, and this helper reproduces that exactly.
 */
export function sources(dir, out = []) {
  const abs = dir.startsWith(repoRoot) ? dir : join(repoRoot, dir)
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) sources(join(abs, e.name), out)
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(join(abs, e.name).slice(repoRoot.length + 1))
    }
  }
  return out
}
