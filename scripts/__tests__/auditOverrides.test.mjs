// The audit's judgement, tested without running a resolve.
//
// Cases are the real defects it was written to find — #469's inherited lower bound, #471's
// advisory with three patched lines, shell-quote's floor that a later advisory overtook — because
// a checker whose tests are invented inputs only proves it is self-consistent.
import { describe, it, expect } from 'vitest'
import {
  parseKey,
  cmp,
  major,
  judgeKey,
  floorsByPackage,
  belowFloor,
  resolvedVersions,
  neededVerdict,
  publishedReachers,
  publishedWorkspaceNames,
} from '../audit-overrides.mjs'

const kinds = (r) => r.faults.map((f) => f.kind)
const noteKinds = (r) => r.notes.map((n) => n.kind)

describe('parseKey', () => {
  it('splits on the LAST @, so scoped names survive', () => {
    expect(parseKey('fast-uri@>=3.0.0 <3.1.5')).toEqual({ name: 'fast-uri', range: '>=3.0.0 <3.1.5' })
    expect(parseKey('@hono/node-server@<2.0.5')).toEqual({ name: '@hono/node-server', range: '<2.0.5' })
  })
})

describe('cmp / major', () => {
  it('orders by numeric component, not lexically', () => {
    expect(cmp('1.9.0', '1.8.4')).toBeGreaterThan(0)
    expect(cmp('1.10.0', '1.9.0')).toBeGreaterThan(0) // '1.10.0' < '1.9.0' as strings
    expect(cmp('3.1.5', '3.1.5')).toBe(0)
  })
  it('reads the major of a bare or partial version', () => {
    expect(major('4.12.34')).toBe(4)
    expect(major('0.28.1')).toBe(0)
  })
})

describe('judgeKey — unbounded key lower bound', () => {
  // pnpm matches by range INTERSECTION, so `<X` reaches every major below and the replacement
  // would force a cross-major jump. Fixed for undici in #469, still present on four keys.
  it('flags a bare upper-bound key', () => {
    const r = judgeKey({ key: 'dompurify@<3.4.12', replacement: '>=3.4.12 <4' }, [])
    expect(kinds(r)).toContain('unbounded-key-lower')
  })

  it('accepts a key scoped to its major', () => {
    const r = judgeKey({ key: 'dompurify@>=3.0.0 <3.4.12', replacement: '>=3.4.12 <4' }, [])
    expect(kinds(r)).not.toContain('unbounded-key-lower')
  })
})

describe('judgeKey — unbounded replacement', () => {
  it('flags a replacement with no cap', () => {
    const r = judgeKey({ key: 'esbuild@>=0.27.3 <0.28.1', replacement: '>=0.28.1' }, [])
    expect(kinds(r)).toContain('unbounded-replacement')
  })

  it('accepts an explicit cap, and accepts caret as its own cap', () => {
    expect(kinds(judgeKey({ key: 'esbuild@>=0.27.3 <0.28.1', replacement: '>=0.28.1 <0.29.0' }, [])))
      .not.toContain('unbounded-replacement')
    expect(kinds(judgeKey({ key: 'hono@>=4.0.0 <4.12.34', replacement: '^4.12.34' }, [])))
      .not.toContain('unbounded-replacement')
  })
})

describe('judgeKey — stale replacement floor', () => {
  // shell-quote's real history: the override targeted GHSA-w7jw (patched 1.8.4), then GHSA-395f
  // landed ON 1.8.4 and the replacement floor was never raised.
  const shellQuote = [
    { ghsa: 'GHSA-w7jw-789q-3m8p', range: '>= 1.1.0, <= 1.8.3', patched: '1.8.4' },
    { ghsa: 'GHSA-395f-4hp3-45gv', range: '<= 1.8.4', patched: '1.9.0' },
  ]

  it('flags a floor a later advisory overtook', () => {
    const r = judgeKey({ key: 'shell-quote@>=1.0.0 <1.8.4', replacement: '^1.8.4' }, shellQuote)
    expect(kinds(r)).toContain('stale-replacement-floor')
    expect(r.faults.find((f) => f.kind === 'stale-replacement-floor').detail).toContain('1.9.0')
  })

  it('clears once the floor is raised', () => {
    const r = judgeKey({ key: 'shell-quote@>=1.0.0 <1.9.0', replacement: '>=1.9.0 <2' }, shellQuote)
    expect(kinds(r)).not.toContain('stale-replacement-floor')
  })
})

describe('judgeKey — uncovered advisory line', () => {
  // The #471 failure exactly: one advisory patched 4.1.2, 3.1.5 and 2.4.4 within fourteen minutes,
  // and the key derived from the Dependabot alert covered only 3.x.
  const fastUri = [
    { ghsa: 'GHSA-7p8r-x3mc-p8w7', range: '>= 4.0.0, < 4.1.2', patched: '4.1.2' },
    { ghsa: 'GHSA-7p8r-x3mc-p8w7', range: '>= 3.0.0, < 3.1.5', patched: '3.1.5' },
    { ghsa: 'GHSA-7p8r-x3mc-p8w7', range: '< 2.4.4', patched: '2.4.4' },
  ]

  it('notices the current line left unguarded by a single key', () => {
    const r = judgeKey({ key: 'fast-uri@>=3.0.0 <3.1.5', replacement: '>=3.1.5 <4' }, fastUri, '3')
    expect(noteKinds(r)).toContain('uncovered-line')
    expect(r.notes.map((n) => n.detail).join(' ')).toContain('4.x')
  })

  it('is silent once a sibling key covers that line', () => {
    // Judged per package. Without this the three fast-uri keys each reported the other two.
    const r = judgeKey({ key: 'fast-uri@>=3.0.0 <3.1.5', replacement: '>=3.1.5 <4' }, fastUri, '3', [
      { key: 'fast-uri@>=2.0.0 <2.4.4', replacement: '>=2.4.4 <3' },
      { key: 'fast-uri@>=4.0.0 <4.1.2', replacement: '>=4.1.2 <5' },
    ])
    expect(noteKinds(r)).not.toContain('uncovered-line')
  })

  it('is a note, never a fault — whether the line is worth a key is a human call', () => {
    const r = judgeKey({ key: 'fast-uri@>=3.0.0 <3.1.5', replacement: '>=3.1.5 <4' }, fastUri, '3')
    expect(kinds(r)).not.toContain('uncovered-line')
  })

  it('ignores lines below what the tree resolves', () => {
    // Nothing can drift down into 2.x when 3.1.5 is installed.
    const r = judgeKey({ key: 'fast-uri@>=3.0.0 <3.1.5', replacement: '>=3.1.5 <4' }, fastUri, '3')
    expect(r.notes.map((n) => n.detail).join(' ')).not.toContain('2.x')
  })

  it('ignores a different advisory on an older major', () => {
    // protobufjs produced seven of these — 5.x and 6.x advisories against a 7.x key.
    const protobuf = [
      { ghsa: 'GHSA-current', range: '>= 7.5.0, <= 7.6.4', patched: '7.6.5' },
      { ghsa: 'GHSA-ancient', range: '>= 6.0.0, < 6.8.6', patched: '6.8.6' },
    ]
    const r = judgeKey({ key: 'protobufjs@>=7.5.0 <=7.6.4', replacement: '>=7.6.5 <8' }, protobuf, '7')
    expect(noteKinds(r)).toEqual([])
  })
})

describe('judgeKey — a line with no patch is reported, not blamed', () => {
  it('separates unrescuable ranges from faults', () => {
    // hono 3.x: last release 3.12.12 in 2024, only patch is 4.12.34. An override cannot fix that
    // line — forcing a 3.x consumer to ^4 is a break, not a remedy.
    const r = judgeKey({ key: 'hono@>=4.0.0 <4.12.34', replacement: '^4.12.34' }, [
      { ghsa: 'GHSA-8j4g-w8fx-2239', range: '< 4.12.34', patched: '4.12.34' },
      { ghsa: 'GHSA-old', range: '< 3.0.0', patched: null },
    ])
    expect(r.unrescuable).toEqual(['< 3.0.0'])
    expect(kinds(r)).toEqual([])
  })
})

describe('floorsByPackage / belowFloor', () => {
  it('keeps the highest patch per compatibility line', () => {
    const floors = floorsByPackage({
      'fast-uri': [
        { range: '>= 3.0.0, < 3.1.4', patched: '3.1.4' },
        { range: '>= 3.0.0, < 3.1.5', patched: '3.1.5' },
        { range: '>= 4.0.0, < 4.1.2', patched: '4.1.2' },
      ],
    })
    expect(floors['fast-uri']).toEqual({ 3: '3.1.5', 4: '4.1.2' })
  })

  it('keeps 0.x minors apart, since each is its own compatibility line', () => {
    const floors = floorsByPackage({
      esbuild: [
        { range: '>= 0.21.0, < 0.21.6', patched: '0.21.6' },
        { range: '>= 0.28.0, < 0.28.1', patched: '0.28.1' },
      ],
    })
    expect(floors.esbuild).toEqual({ '0.21': '0.21.6', '0.28': '0.28.1' })
  })

  it('judges each version against its OWN line', () => {
    const floors = { 3: '3.1.5', 4: '4.1.2' }
    // 4.1.0 is below the 4.x floor even though it is above the 3.x one.
    expect(belowFloor(['3.1.5', '4.1.0'], floors)).toEqual(['4.1.0'])
    expect(belowFloor(['3.1.5', '4.1.2'], floors)).toEqual([])
  })

  it('reports nothing when the package has no known advisories', () => {
    expect(belowFloor(['1.0.0'], undefined)).toEqual([])
  })
})

describe('resolvedVersions', () => {
  const lock = [
    'packages:',
    '',
    "  '@hono/node-server@2.0.12':",
    '  fast-uri@3.1.5:',
    '  fast-uri-other@9.9.9:',
    '  hono@4.13.0:',
  ].join('\n')

  it('reads versions for a scoped and an unscoped name', () => {
    expect(resolvedVersions(lock, 'fast-uri')).toEqual(['3.1.5'])
    expect(resolvedVersions(lock, '@hono/node-server')).toEqual(['2.0.12'])
  })

  it('does not match a package whose name merely starts the same', () => {
    // `fast-uri` must not pick up `fast-uri-other`.
    expect(resolvedVersions(lock, 'fast-uri')).not.toContain('9.9.9')
  })
})

// ── regressions the first round of tests could not have caught ────────────────

describe('resolvedVersions — peer-suffixed and rangeless shapes', () => {
  const lock = [
    "  '@hono/node-server@2.0.12(hono@4.13.0)':",
    '  axios@1.18.1(debug@4.4.3):',
    '  esbuild@0.25.12(patch_hash=abc123):',
    '  fast-uri@3.1.5:',
  ].join('\n')

  it('reads the package version, not the peer it is suffixed with', () => {
    // The peer's `@` is the LAST one, so slicing there reported hono's version as node-server's.
    expect(resolvedVersions(lock, '@hono/node-server')).toEqual(['2.0.12'])
    expect(resolvedVersions(lock, 'axios')).toEqual(['1.18.1'])
    expect(resolvedVersions(lock, 'esbuild')).toEqual(['0.25.12'])
  })

  it('returns nothing for an empty name instead of matching every scoped line', () => {
    expect(resolvedVersions(lock, '')).toEqual([])
  })
})

describe('parseKey / judgeKey — rangeless and exact-version keys', () => {
  it('keeps the name intact when the key carries no range', () => {
    // `"esbuild": ">=0.28.1"` is pnpm's documented default form.
    expect(parseKey('esbuild')).toEqual({ name: 'esbuild', range: '' })
    expect(parseKey('@hono/node-server')).toEqual({ name: '@hono/node-server', range: '' })
  })

  it('faults a rangeless key rather than mangling it', () => {
    expect(kinds(judgeKey({ key: 'esbuild', replacement: '>=0.28.1' }, []))).toContain('rangeless-key')
  })

  it('does not call an exact version unbounded, in the key or the replacement', () => {
    const r = judgeKey({ key: 'shell-quote@1.8.4', replacement: '1.9.0' }, [])
    expect(kinds(r)).not.toContain('unbounded-key-lower')
    expect(kinds(r)).not.toContain('unbounded-replacement')
  })
})

describe('0.x lines are compatibility boundaries, not one bucket', () => {
  const esbuild = [
    { ghsa: 'GHSA-x', range: '>= 0.27.3, < 0.28.1', patched: '0.28.1' },
    { ghsa: 'GHSA-x', range: '>= 0.29.0, < 0.29.4', patched: '0.29.4' },
  ]

  it('notices a second 0.x line the key does not cover', () => {
    // Bucketing every 0.x into major 0 made `guarded` always contain the key's own line, so this
    // note could never fire for a 0.x package — the one kind where each minor is breaking.
    const r = judgeKey({ key: 'esbuild@>=0.27.3 <0.28.1', replacement: '>=0.28.1 <0.29.0' }, esbuild, '0.27')
    expect(noteKinds(r)).toContain('uncovered-line')
    expect(r.notes.map((n) => n.detail).join(' ')).toContain('0.29')
  })

  it('ignores a 0.x line below what the tree resolves', () => {
    // The filter compared majors, which is `0 < 0` for every 0.x package — so it could not fire
    // for exactly the packages `line()` exists for. With the tree on 0.29, an advisory patching
    // an ancient 0.21 was still reported as an uncovered line nothing could reach.
    const old = [
      { ghsa: 'G1', range: '>= 0.29.0, < 0.29.4', patched: '0.29.4' },
      { ghsa: 'G1', range: '>= 0.21.0, < 0.21.3', patched: '0.21.3' },
    ]
    const r = judgeKey({ key: 'esbuild@>=0.29.0 <0.29.4', replacement: '>=0.29.4 <0.30.0' }, old, '0.29')
    expect(noteKinds(r)).toEqual([])
  })

  it('is silent once a sibling key covers the other 0.x line', () => {
    const r = judgeKey(
      { key: 'esbuild@>=0.27.3 <0.28.1', replacement: '>=0.28.1 <0.29.0' },
      esbuild,
      '0.27',
      [{ key: 'esbuild@>=0.29.0 <0.29.4', replacement: '>=0.29.4 <0.30.0' }],
    )
    expect(noteKinds(r)).toEqual([])
  })
})

describe('neededVerdict', () => {
  // Keyed by compatibility line, which for a 0.x package is `0.<minor>`.
  const floors = { '0.21': '0.21.6', '0.25': '0.25.13', '0.28': '0.28.1' }

  it('RETIRE when removing it changes nothing — esbuild is below floor either way', () => {
    const both = ['0.21.5', '0.25.12', '0.28.1']
    expect(neededVerdict(both, both, floors).verdict).toBe('RETIRE')
  })

  it('KEEP only when removing it newly drops something below its floor', () => {
    const r = neededVerdict(['0.28.1'], ['0.27.5'], { ...floors, '0.27': '0.27.6' })
    expect(r.verdict).toBe('KEEP')
    expect(r.newlyLow).toEqual(['0.27.5'])
  })

  it('does not judge one 0.x minor against another minor\'s floor', () => {
    // Bucketing every 0.x under major `0` gave the whole line the newest patch anywhere in it, so
    // 0.21.5 was measured against 0.28.1 and looked vulnerable to an advisory about a different
    // compatibility line entirely.
    expect(belowFloor(['0.21.6'], floors)).toEqual([])
    expect(neededVerdict(['0.21.6'], ['0.21.6'], floors).verdict).toBe('RETIRE')
  })

  it('still catches a version below its OWN 0.x line floor', () => {
    expect(belowFloor(['0.21.5'], floors)).toEqual(['0.21.5'])
    expect(neededVerdict(['0.21.6'], ['0.21.5'], floors).verdict).toBe('KEEP')
  })
})

describe('publishedReachers / publishedWorkspaceNames', () => {
  const ls = JSON.stringify([
    { name: '@tapflowio/relay', private: false },
    { name: '@tapflowio/playground', private: true },
    { name: 'tapflow', private: false },
  ])
  const why = ['@tapflowio/relay@0.18.0 /repo/packages/relay', '@tapflowio/playground@0.1.0 /repo/playground', 'dependencies:'].join('\n')

  it('reads only the publishing workspace packages', () => {
    expect(publishedWorkspaceNames(ls).sort()).toEqual(['@tapflowio/relay', 'tapflow'])
  })

  it('excludes a private package that pnpm why still lists', () => {
    // Counting playground would report a dev-only override as reaching users.
    expect(publishedReachers(why, publishedWorkspaceNames(ls))).toEqual(['@tapflowio/relay'])
  })
})
