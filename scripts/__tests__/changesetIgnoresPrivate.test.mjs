import { describe, it, expect } from 'vitest'
import { getPackages } from '@manypkg/get-packages'
import fs from 'node:fs'
import path from 'node:path'
import { SHIPS_DESPITE_PRIVATE } from '../check-changeset.mjs'

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
const config = JSON.parse(fs.readFileSync(path.join(REPO, '.changeset/config.json'), 'utf8'))
const ignored = new Set(config.ignore ?? [])
const byName = new Map(workspace.packages.map((p) => [p.packageJson.name, p.packageJson]))
const privateNames = workspace.packages
  .filter((p) => p.packageJson.private === true)
  .map((p) => p.packageJson.name)

describe('.changeset/config.json ignore covers every private package', () => {
  // Found by inspection, not from a list. A hardcoded list of expected names is satisfied by not being
  // edited, which is exactly how the two misses above survived: `changesetGateAccuracy.test.mjs`
  // carries `const IGNORED = new Set([...])` as a unit fixture and did not move when the real list did.
  it('names every private workspace package', () => {
    expect(privateNames.length).toBeGreaterThan(0) // the enumerator found something to judge
    const missing = privateNames.filter((n) => !ignored.has(n))
    expect(missing, `private but not ignored: ${missing.join(', ')}`).toEqual([])
  })

  // The other direction, and it is not symmetry for its own sake. An entry naming a package that was
  // published since, or renamed, or deleted, silently exempts nothing while reading as deliberate — and
  // the failure it hides is the expensive one: a package that should get release notes, quietly not
  // getting them.
  it('names nothing that is not a private workspace package', () => {
    const stale = [...ignored].filter((n) => byName.get(n)?.private !== true)
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
      expect(byName.get(name)?.private, `${name} is named as shipping despite private, but is not private`).toBe(true)
      expect(ignored.has(name), `${name} is private and must be ignored`).toBe(true)
    }
  })
})
