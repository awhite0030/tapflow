import { describe, it, expect } from 'vitest'
import { getPackages } from '@manypkg/get-packages'
import path from 'node:path'
import { SHIPS_DESPITE_PRIVATE, ignoredPackages } from '../check-changeset.mjs'

// `.changeset/config.json`'s `ignore` has to name every `private: true` workspace package, and until
// now nothing checked that it did. The list fell behind twice in one week:
//
//  - #537 wrote a changeset naming `@tapflowio/test-utils`, absent from `ignore`. `changeset version`
//    would have versioned an unpublished package and written it a CHANGELOG while **no published
//    package got a release note**, with the CI `changeset` job green. Caught in review.
//  - The follow-up added `test-utils` and left `@tapflowio/docs`, also private, also missing. Caught
//    by the next review.
//
// Nothing downstream objects on its own: `privatePackages.version` defaults to `true`, so a private
// package that is not ignored appears in `pnpm changeset` like any other, and config validation only
// errors when a *non-private* unskipped package depends on a skipped one.
const REPO = path.resolve(import.meta.dirname, '../..')

// **The same enumerator changesets uses**, rather than a glob over `pnpm-workspace.yaml`. Two of the
// four private packages (`docs`, `playground`) are not under `packages/`, so a check that walked
// `packages/*` would have declared the list complete while missing half of what it is about — and
// reimplementing the tool's discovery to guard the tool's behaviour is the shape
// `contributing/test-and-guard-coverage.md` §3 calls a floor rather than a fence. `getPackages`
// excludes the workspace root, which is also correct here: the root is `private` and changesets never
// offers it.
const workspace = await getPackages(REPO)
// **Through the gate's own reader, not a second copy of it.** A first draft read the config here
// directly, which is green under exactly the conditions that break the gate: `ignoredPackages` used a
// relative path and a bare catch, so any cwd but the repo root turned the mixed-changeset check off
// with nothing to say so. A guard that duplicates the reader cannot observe the reader failing.
//
// Entries are compared as literal names. `@changesets/config` micromatch-expands them, so a glob
// entry would be reported by both assertions below — loudly and wrongly. No glob is in use and the
// failure direction is safe, so this is a constraint rather than a hole; stated here so the next
// person does not read the assertions as glob-aware.
const byName = new Map(workspace.packages.map((p) => [p.packageJson.name, p.packageJson]))
const ignored = ignoredPackages()
// Truthiness, matching changesets' own `shouldSkipPackage` (`packageJson.private && …`) and this
// repo's `packagePublishesAt` (`!m.private`). `=== true` was stricter than all three: a manifest with
// `"private": "true"` is private to pnpm, to npm publish and to changesets, and would have been
// invisible here while `changeset version` bumped and changelogged something unpublishable.
const privateNames = workspace.packages
  .filter((p) => Boolean(p.packageJson.private))
  .map((p) => p.packageJson.name)

describe('.changeset/config.json ignore covers every private package', () => {
  // Found by inspection, not from a list. A hardcoded list of expected names is satisfied by not being
  // edited, which is exactly how the two misses above survived: `changesetGateAccuracy.test.mjs`
  // carries `const IGNORED = new Set([...])` as a unit fixture and did not move when the real list did.
  it('names every private workspace package', () => {
    // **Four, not "more than zero".** A floor of zero is satisfied by an enumerator that finds almost
    // nothing, and the specific way this check can go vacuous is the one its header warns about:
    // swapping `getPackages` for a `packages/*` walk finds 2 of the 4, and every assertion below still
    // passes. The measured count is what makes that mutation fail (test-and-guard-coverage.md §3).
    expect(privateNames.length).toBeGreaterThanOrEqual(4)
    const missing = privateNames.filter((n) => !ignored.has(n))
    expect(missing, `private but not ignored: ${missing.join(', ')}`).toEqual([])
  })

  // The other direction, and it is not symmetry for its own sake. An entry naming a package that was
  // published since, or renamed, or deleted, silently exempts nothing while reading as deliberate — and
  // the failure it hides is the expensive one: a package that should get release notes, quietly not
  // getting them.
  it('names nothing that is not a private workspace package (literal names only)', () => {
    const stale = [...ignored].filter((n) => !byName.get(n)?.private)
    expect(stale, `ignored but not a private workspace package: ${stale.join(', ')}`).toEqual([])
  })

  // `check-changeset.mjs` keeps its own list for a different question — which packages still need a
  // release note despite being private, because they ship inside another package's tarball. Both
  // questions are true of `dashboard` at once: it must be ignored (changesets cannot publish it) *and*
  // a change to it must be noted (it is built into the relay's `public/`). Read from that module rather
  // than restated, so the two cannot drift; asserted here because if a name there stops being private,
  // that set is exempting a package the gate should be asking about.
  it('agrees with the ships-despite-private set in check-changeset.mjs', () => {
    for (const name of SHIPS_DESPITE_PRIVATE) {
      expect(Boolean(byName.get(name)?.private), `${name} is named as shipping despite private, but is not private`).toBe(true)
      expect(ignored.has(name), `${name} is private and must be ignored`).toBe(true)
    }
  })
})
