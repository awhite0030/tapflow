import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The browser-role producers construct their outbound literals directly, so typing the send function is a real
// compile-time check — unlike narrowing a relay *forward*, which checks nothing because no literal is constructed
// there (see the L4b retirement in `.work/WIRE-CONTRACT-PLAN.md`).
//
// All three are typed now, and none produced a compile error when the type went on. Worth stating plainly: **the
// value here is regression defence, not a bug found.** Every `sessionId` in these files comes from a required
// `string` parameter, so the root cause that produced 30 errors on the agent side (#509) does not exist.
//
// It matches **serialization**, not a spelling of `send(`. The first draft of this file asserted
// `/private send\(msg: BrowserToRelay\)/` and was defeated in review by the bypass its own header claimed to
// prevent: a second helper `private sendRaw(msg: RelayMsg)` writing to `this.ws` passed all seven assertions with
// tsc and the package suite green, and put `session:leaev` on the wire. `agentSendTyped.test.mjs` had already
// learned this — three of its drafts died to a renamed socket — and this file was written worse than its sibling.
//
// So the rule is the sibling's: **`JSON.stringify` appears once per file, and the function enclosing it takes
// `BrowserToRelay`.** That constrains the sink rather than its name, so a rename passes and a second untyped
// path cannot. It also stops keying on syntactic form — `useRelay`'s send is a `useCallback` arrow, and a check
// pinned to `private send(` both missed it and would have failed on a harmless refactor of the other two.

const root = join(import.meta.dirname, '../..')

/** Comments out, `/* … *\/` blocks included: a commented-out signature satisfying a positive assertion is the
 *  failure that let an agent's real helper take `msg: object` while its check stayed green. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** The files that hold a relay socket and serialize to it. Completeness is checked below, by inspection. */
const FILES = {
  'mcp-server': 'packages/mcp-server/src/client.ts',
  'flow-runner': 'packages/flow-runner/src/RelayClient.ts',
  dashboard: 'packages/dashboard/hooks/useRelay.ts',
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', '__tests__', '.turbo'])

/** Every source file under `packages/`, walked from disk rather than `git ls-files`. Measured: a new sender file
 *  that serializes escapes the completeness check below while it is untracked, and "I just added it" is exactly
 *  when it is untracked. `agentSendTyped.test.mjs` has the same hole for the same reason. */
function sources(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) sources(join(dir, e.name), out)
    } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      out.push(join(dir, e.name).slice(root.length + 1))
    }
  }
  return out
}

/** A function signature taking a single named message parameter, capturing the declared type. Covers both the
 *  method form (`private send(msg: BrowserToRelay)`) and the hook form (`const send = useCallback((msg: …)`),
 *  and deliberately captures whatever the type *is* rather than asserting a spelling. */
const SIGNATURE = /(?:\b\w+\s*\(|\(\s*)(?:msg|m|message)\s*:\s*([\w.]+(?:<[^)]*>)?)\s*\)/g

/** The type of the function that encloses `JSON.stringify` — the nearest signature declared before it. */
function sinkParamType(src) {
  const at = src.indexOf('JSON.stringify')
  if (at === -1) return null
  let found = null
  for (const m of src.matchAll(SIGNATURE)) {
    if (m.index > at) break
    found = m[1]
  }
  return found
}

describe('browser-role outbound is typed against the wire contract', () => {
  for (const [name, path] of Object.entries(FILES)) {
    const src = stripComments(readFileSync(join(root, path), 'utf8'))

    it(`${name} serializes exactly once`, () => {
      // A second serializer is the bypass this file exists for: it needs no rename to defeat a signature
      // assertion, because the assertion keeps passing on the helper that is still typed.
      expect([...src.matchAll(/JSON\.stringify/g)]).toHaveLength(1)
    })

    it(`${name} serializes inside a BrowserToRelay sink`, () => {
      expect(sinkParamType(src)).toBe('BrowserToRelay')
    })

    it(`${name} takes BrowserToRelay from protocol, not a local alias`, () => {
      // `type BrowserToRelay = RelayMsg` in-file passed the first draft's every assertion. The name proves
      // nothing on its own; where it resolves from does.
      expect(src).toMatch(/import type \{[^}]*\bBrowserToRelay\b[^}]*\} from '@tapflowio\/protocol'/)
      expect(src).not.toMatch(/(?:type|interface)\s+BrowserToRelay\b/)
    })
  }

  it('every socket-writing file in the browser-role packages is accounted for', () => {
    // Derived, not listed: a browser-role package is one whose source imports `BrowserToRelay`. So a new such
    // package, or a new sender inside an existing one, shows up here as an omission instead of going unnoticed —
    // the first draft hardcoded two paths and silently excluded the dashboard, the busiest producer of the three.
    const tracked = sources(join(root, 'packages'))
    const pkgOf = (f) => f.split('/')[1]
    const browserRole = new Set(
      tracked
        .filter((f) => pkgOf(f) !== 'protocol')
        .filter((f) => /BrowserToRelay/.test(readFileSync(join(root, f), 'utf8')))
        .map(pkgOf),
    )
    expect([...browserRole].sort()).toEqual(['dashboard', 'flow-runner', 'mcp-server'])

    const offenders = tracked.filter((f) => {
      if (!browserRole.has(pkgOf(f)) || Object.values(FILES).includes(f)) return false
      const body = stripComments(readFileSync(join(root, f), 'utf8'))
      return /\.send\(/.test(body) && /JSON\.stringify/.test(body)
    })
    expect(offenders).toEqual([])
  })

  it('BrowserToRelay is a union of named messages only', () => {
    // The check above binds the sinks to this union's *name*. Nothing bound its contents, and appending
    // `| Record<string, unknown>` to it passed all 250 static assertions while making every literal in all
    // three files accept anything — the guard pointing at this declaration raised nothing.
    const proto = readFileSync(join(root, 'packages/protocol/src/index.ts'), 'utf8')
    const rhs = proto.match(/export type BrowserToRelay =([\s\S]*?)\n\n/)
    expect(rhs, 'BrowserToRelay is gone').not.toBeNull()
    const members = rhs[1].split('|').map((s) => s.trim()).filter(Boolean)
    expect(members.length).toBeGreaterThan(10)
    for (const m of members) expect(m, `not a named message: ${m}`).toMatch(/^[A-Z]\w*$/)
  })

  it('app:clear-state requires its bundleId, at both levels', () => {
    // The one real defect this layer found: `payload?: { bundleId?: string }` was looser than every producer
    // *and* every consumer, so it described a message whose only outcome was `'bundleId missing'`.
    //
    // Required does not make that branch dead, and the agents keep it: `bundleId: ''` type-checks, and
    // `runFlow` is exported without `parseFlow`, so an out-of-repo caller can hand it a `Flow` with no `appId`
    // at all. `engine.ts` now refuses that rather than sending `payload: {}` for the device to reject.
    const proto = readFileSync(join(root, 'packages/protocol/src/index.ts'), 'utf8')
    const decl = proto.match(/export interface AppClearState \{([\s\S]*?)\n\}/)
    expect(decl, 'AppClearState is gone').not.toBeNull()
    expect(decl[1]).toMatch(/^ {2}payload: \{ bundleId: string \}$/m)

    const engine = stripComments(readFileSync(join(root, 'packages/flow-runner/src/engine.ts'), 'utf8'))
    expect(engine).not.toMatch(/clearState\(step\.appId \?\? flow\.appId!\)/)
  })
})
