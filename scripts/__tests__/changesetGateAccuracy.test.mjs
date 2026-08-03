import { describe, it, expect } from 'vitest'
import { packagesNamedIn, mixedChangesets, manifestChangeShips, shipsToUsers, packagePublishesAt } from '../check-changeset.mjs'

const IGNORED = new Set(['@tapflowio/dashboard', '@tapflowio/playground'])
const cs = (body) => `---\n${body}\n---\n\nsome note.\n`

describe('changeset frontmatter', () => {
  it('reads the packages a changeset bumps', () => {
    expect(packagesNamedIn(cs('"@tapflowio/relay": patch\n"@tapflowio/protocol": minor')))
      .toEqual(['@tapflowio/relay', '@tapflowio/protocol'])
  })
  it('returns nothing for a file with no frontmatter', () => {
    expect(packagesNamedIn('just prose\n')).toEqual([])
  })
})

describe('mixing an ignored package with a published one', () => {
  // What stopped the v0.18.0 release. `changeset version` rejects it outright, and until this
  // check the PR gate never opened a changeset to notice.
  const read = (f) => ({
    'mixed.md': cs('"@tapflowio/protocol": patch\n"@tapflowio/dashboard": patch'),
    'clean.md': cs('"@tapflowio/protocol": patch\n"@tapflowio/relay": patch'),
    'only-ignored.md': cs('"@tapflowio/dashboard": patch'),
  })[f]

  it('flags the mix, naming both sides', () => {
    const [hit] = mixedChangesets(['mixed.md'], IGNORED, read)
    expect(hit.file).toBe('mixed.md')
    expect(hit.ignored).toEqual(['@tapflowio/dashboard'])
    expect(hit.published).toEqual(['@tapflowio/protocol'])
  })
  it('leaves a published-only changeset alone', () => {
    expect(mixedChangesets(['clean.md'], IGNORED, read)).toEqual([])
  })
  it('leaves an ignored-only changeset alone — changesets accepts it', () => {
    expect(mixedChangesets(['only-ignored.md'], IGNORED, read)).toEqual([])
  })
})

describe('a package.json edit that ships', () => {
  const withDev = (dev) => JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { a: '1' }, devDependencies: dev })
  it('ignores a devDependencies-only change', () => {
    // #453: wiring a private test helper into three consumers. The audit called it a missing
    // changeset while the PR gate had said the opposite about the same commit.
    expect(manifestChangeShips(withDev({}), withDev({ '@tapflowio/test-utils': 'workspace:*' }))).toBe(false)
  })
  it('catches a real dependency change', () => {
    const before = JSON.stringify({ name: 'x', dependencies: { a: '1' } })
    const after = JSON.stringify({ name: 'x', dependencies: { a: '2' } })
    expect(manifestChangeShips(before, after)).toBe(true)
  })
  it('treats an added or unparseable manifest as shipping', () => {
    expect(manifestChangeShips(null, withDev({}))).toBe(true)
    expect(manifestChangeShips('{ not json', withDev({}))).toBe(true)
  })

  it('ignores a pure key reordering', () => {
    // A formatter or `npm pkg set` can rewrite a manifest without changing a value. Compared as
    // raw JSON text those differ, and the gate would ask for a changeset nothing earned — the same
    // spurious signal this file exists to remove, arriving from the other side.
    const a = JSON.stringify({ name: 'x', version: '1', dependencies: { b: '1', a: '1' } })
    const b = JSON.stringify({ dependencies: { a: '1', b: '1' }, version: '1', name: 'x' })
    expect(manifestChangeShips(a, b)).toBe(false)
  })

  it('still sees a nested value change under reordered keys', () => {
    // Sorting must not be allowed to hide a real edit that happens to travel with a reorder.
    const a = JSON.stringify({ name: 'x', dependencies: { b: '1', a: '1' } })
    const b = JSON.stringify({ dependencies: { a: '2', b: '1' }, name: 'x' })
    expect(manifestChangeShips(a, b)).toBe(true)
  })

  it('still says shipping when BOTH sides are unparseable', () => {
    // The case the two above miss. Have the failure fall back to a placeholder instead of null
    // and they keep passing — the placeholder differs from the parsed side, so the comparison is
    // "changed" for the wrong reason. Only when both sides collapse to the same placeholder does
    // the answer flip to "nothing shipped", which is the dangerous direction. Measured.
    expect(manifestChangeShips('{ not json', 'also { not json')).toBe(true)
  })
})

describe('which packages ship', () => {
  // Read at a revision, never from disk: the audit walks history, so a package deleted since —
  // or introduced by the merge being examined — has to be judged as it was then. Reading the
  // working tree instead made every package that does not exist today look unpublished, which
  // broke eight existing cases at once, the new-package one among them.
  const manifest = (obj) => () => obj === null ? null : JSON.stringify(obj)

  it('excludes a private package', () => {
    expect(packagePublishesAt(manifest({ name: '@tapflowio/test-utils', private: true }), 'test-utils')).toBe(false)
  })
  it('includes the dashboard, which ships inside relay', () => {
    expect(packagePublishesAt(manifest({ name: '@tapflowio/dashboard', private: true }), 'dashboard')).toBe(true)
  })
  it('includes an ordinary published package', () => {
    expect(packagePublishesAt(manifest({ name: '@tapflowio/relay' }), 'relay')).toBe(true)
  })
  it('assumes a package it cannot read publishes — a new one must stay visible', () => {
    expect(packagePublishesAt(manifest(null), 'flow-capture')).toBe(true)
    expect(packagePublishesAt(() => '{ not json', 'relay')).toBe(true)
  })

  it('still excludes a directory under packages/ that is not a package', () => {
    expect(shipsToUsers('packages/docs/guide/requirements.md')).toBe(false)
  })
})
