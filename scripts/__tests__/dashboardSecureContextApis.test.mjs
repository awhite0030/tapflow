import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sources } from './sourceFiles.mjs'

// **A LAN deployment is plain HTTP, and the dashboard is the thing served over it.** That is not an edge
// case: it is the primary manual-testing path, and the reason `pickDecoder` carries a WASM tier at all.
// Several Web Crypto entry points are *secure-context only* — they are simply absent on `http://<mac-ip>`
// — so calling one is a `TypeError` on the deployment this project exists for.
//
// Nothing else can catch it. Dev runs on `localhost`, which **is** a secure context; vitest runs in jsdom
// and node, where these exist unconditionally. A green suite and a working dev server both agree the code
// is fine, and the first report is a blank page from a tester on someone else's Mac.
//
// It has now happened twice. `lib/requestId.ts` was written the first time and says so in its own doc:
// *"a second `randomUUID` would have looked correct in every dev environment and thrown only on the
// deployment tapflow is for."* The second was a per-document client id in `useRelay` — a module every
// route loads, so the failure would have been the whole dashboard rather than one socket. It was caught by
// review. This is the check that means the third does not need to be.

const root = join(import.meta.dirname, '../..')

/**
 * Secure-context-only Web Crypto surfaces, with what to use instead.
 *
 * `getRandomValues` is deliberately **not** here: it has no such restriction, which is what makes
 * `newRequestId` the answer rather than a workaround.
 */
const FORBIDDEN = [
  { pattern: /\bcrypto\.randomUUID\s*\(/, use: '`newRequestId()` from `lib/requestId.ts`' },
  { pattern: /\bcrypto\.subtle\b/, use: 'a non-crypto approach, or move the work to the relay' },
]

const FILES = sources('packages/dashboard').filter((f) => !f.includes('__tests__'))

/** Comments blanked, line count preserved — this file's own header names both APIs, and so does the doc
 *  block on `requestId.ts` that exists to warn about them. A check that read prose would fail on the
 *  warning. */
const code = (path) =>
  readFileSync(join(root, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')

describe('the dashboard bundle calls nothing that needs a secure context', () => {
  it('the file walk found the bundle', () => {
    // Anti-vacuity from the measurement: an empty list makes every assertion below hold for nothing, and
    // this program's parser failures were all partial losses that left a non-empty result behind.
    expect(FILES.length).toBeGreaterThanOrEqual(80)
    expect(FILES.some((f) => f.endsWith('hooks/useRelay.ts'))).toBe(true)
  })

  for (const { pattern, use } of FORBIDDEN) {
    it(`no call to ${String(pattern)}`, () => {
      const offenders = FILES
        .filter((f) => pattern.test(code(f)))
        .map((f) => `${f} — secure-context only, absent over plain HTTP. Use ${use}.`)
      expect(offenders).toEqual([])
    })
  }

  it('the patterns match a call, and prose about it does not count as one', () => {
    // The check's own strictness, which nothing else holds. Two independent things keep the file that
    // *warns* about this API from being reported as breaking it, and both are load-bearing: the pattern
    // requires a call (`(`), so a backticked mention is not one, and comments are blanked, so a
    // commented-out call is not one either. A version missing both would fail on `requestId.ts` — the file
    // written to prevent the failure — and the check would be deleted rather than the call.
    const [uuid] = FORBIDDEN
    expect(uuid.pattern.test('const id = crypto.randomUUID()')).toBe(true)
    expect(uuid.pattern.test('`crypto.randomUUID` is not available here'), 'a mention is not a call')
      .toBe(false)
    expect(uuid.pattern.test(code('packages/dashboard/lib/requestId.ts')), 'the warning file is clean')
      .toBe(false)
  })
})
