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

/** Generated trees no name can reach, because the name belongs to something real.
 *
 *  `packages/relay/public` is a copy of `packages/dashboard/dist` — the dashboard build ends with
 *  `rm -rf ../relay/public && mkdir -p ../relay/public && cp -r dist/. ../relay/public/` — so a walk
 *  that skips `dist` by name and descends into this one is applying the rule to one of two copies.
 *  `public` cannot join `SKIP_DIRS`: `docs/public` holds `robots.txt` and `llms.txt`, which
 *  `agentReadableDocs.test.mjs` asserts on by name.
 *
 *  **It also makes a walk race that build.** `dashboardFirstLoadBudget.test.mjs` runs it in the same
 *  `pnpm test:scripts` invocation, in a parallel worker, so a walker inside this directory during the
 *  `rm -rf` dies on ENOENT. One real run failed that way, and a loop measured 2 failures in 1,718
 *  walks — both at the moment the copy was replaced — against 0 after the skip.
 *
 *  Exported because two different walkers reach it: this module's `sources()` (through
 *  `clientOutboundTyped.test.mjs`, the only caller that walks all of `packages/`) and
 *  `agentReadableDocs.test.mjs`, which walks the repo root with its own extension set. Fixing one
 *  and not the other left half the race in place. */
export const SKIP_PATHS = new Set([join(repoRoot, 'packages', 'relay', 'public')])

/** Where `SKIP_PATHS` comes from, so a check can fail loudly when the build stops producing it
 *  rather than passing vacuously against a path nothing writes any more. */
export const SKIP_PATHS_SOURCE = {
  manifest: join(repoRoot, 'packages', 'dashboard', 'package.json'),
  script: 'build',
  mentions: '../relay/public',
}

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
      const child = join(abs, e.name)
      if (!SKIP_DIRS.has(e.name) && !SKIP_PATHS.has(child)) sources(child, out)
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(join(abs, e.name).slice(repoRoot.length + 1).replaceAll('\\', '/'))
    }
  }
  return out
}
