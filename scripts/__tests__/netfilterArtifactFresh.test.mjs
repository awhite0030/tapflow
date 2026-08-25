import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { computeRecord, readRecord, collectSources, collectAppFiles } from '../lib/netfilter-artifact.mjs'

/**
 * The network-filter extension is the one artifact in this repo that a contributor cannot rebuild:
 * ad-hoc signing does not load (measured `code=4`), so it is signed and notarized on a maintainer's
 * Mac and committed. That makes one mistake possible and invisible — editing the Swift and shipping
 * the old binary — and this is what catches it.
 *
 * **Read the failure message before assuming your change is wrong.** If you edited the extension's
 * sources, this failing is correct and expected: the artifact has to be rebuilt and re-recorded by
 * someone who can sign it. Say so on the PR; it is a handoff, not a defect in your change.
 */
const REPO = path.resolve(import.meta.dirname, '../..')

// Measured floors. A glob that matches nothing hashes to a constant, and every assertion below then
// passes while checking nothing — the shape `contributing/test-and-guard-coverage.md` calls a guard
// that certifies its own absence.
const MIN_SOURCE_FILES = 8
const MIN_APP_FILES = 6

describe('the shipped network filter matches what it was recorded against', () => {
  it('has a record at all', () => {
    expect(
      readRecord(REPO),
      'packages/ios-agent/ios-netfilter/shipped.json is missing — run scripts/record-netfilter-artifact.mjs',
    ).not.toBeNull()
  })

  it('sees enough files to be checking anything', () => {
    expect(collectSources(REPO).length, 'the source glob matched almost nothing').toBeGreaterThanOrEqual(MIN_SOURCE_FILES)
    expect(collectAppFiles(REPO).length, 'the app bundle looks empty').toBeGreaterThanOrEqual(MIN_APP_FILES)
  })

  it('still matches the sources it was built from', () => {
    const now = computeRecord(REPO)
    const recorded = readRecord(REPO)
    expect(
      now.sources,
      'The extension sources changed since the shipped app was built.\n'
      + '  A contributor cannot fix this: the app is Developer-ID signed and notarized on a\n'
      + '  maintainer\'s Mac, because ad-hoc signing does not load. Say on the PR that the\n'
      + '  extension needs rebuilding, and a maintainer runs ios-netfilter/build.sh — which\n'
      + '  rebuilds, installs into the package, and rewrites this record in one step.',
    ).toBe(recorded.sources)
  })

  it('is the same app that was recorded', () => {
    // The half that makes the check work at all. Recording only the sources fails in a way correlated
    // with the mistake: whoever forgets to rebuild forgets to re-record, both values stay consistent,
    // and the guard passes.
    const now = computeRecord(REPO)
    expect(now.app, 'the committed app is not the one in the record — re-run build.sh').toBe(readRecord(REPO).app)
  })

  it('carries the build version the app declares', () => {
    // `CFBundleVersion` is what activation compares. A rebuild that does not raise it is replaced
    // silently by macOS — the README marks that with a star — and the CLI's version check would then
    // compare two identical numbers across different binaries.
    const now = computeRecord(REPO)
    expect(now.bundleVersion).toBe(readRecord(REPO).bundleVersion)
    expect(now.bundleVersion, 'the app declares no build version').toBeTruthy()
  })
})
