import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The two browser-role clients — `mcp-server` and `flow-runner` — construct their outbound literals directly,
// so typing the send function is a real compile-time check, unlike narrowing a relay *forward* (which checks
// nothing, because no literal is constructed there; see the L4b retirement in `.work/WIRE-CONTRACT-PLAN.md`).
//
// Both are typed now. Neither produced a single compile error when the type went on, which is worth stating
// plainly: **the value of this layer is regression defence, not a bug found.** Every `sessionId` in these files
// comes from a required `string` parameter, so the root cause that produced 30 errors on the agent side (#509)
// does not exist here.
//
// That makes this file the layer's only lasting artefact, so it has to be hard to walk past.
//
// It does **not** match a spelling of `send(`. `scripts/__tests__/agentSendTyped.test.mjs` was bypassed three
// times in review by exactly that: renaming the socket, aliasing it, or serializing on the previous line all
// walked past a pattern keyed on a name. Here the thing to protect is a *signature*, so the check reads the
// signature — and separately refuses `Record<string, unknown>` anywhere it could reach an outbound path.

const root = join(import.meta.dirname, '../..')

const CLIENTS = {
  'mcp-server': 'packages/mcp-server/src/client.ts',
  'flow-runner': 'packages/flow-runner/src/RelayClient.ts',
}

/** Comments out, `/* … *\/` blocks included: a commented-out signature satisfying a positive assertion is the
 *  failure that let an agent's real helper take `msg: object` while its check stayed green. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('client outbound is typed against the wire contract', () => {
  for (const [name, path] of Object.entries(CLIENTS)) {
    const src = stripComments(readFileSync(join(root, path), 'utf8'))

    it(`${name} sends through a BrowserToRelay signature`, () => {
      expect(src).toMatch(/private send\(msg: BrowserToRelay\): void/)
    })

    it(`${name} declares exactly one send`, () => {
      // Two would mean one of them is untyped, and the assertion above would still pass on the typed one.
      expect([...src.matchAll(/private send\(/g)]).toHaveLength(1)
    })

    it(`${name} keeps Record<string, unknown> off the outbound path`, () => {
      // The inbound alias may be loose — that is #512, deferred with a reason. What must not happen is an
      // outbound helper reacquiring it, which is how both of these files started.
      for (const m of src.matchAll(/type (\w+) = Record<string, unknown>/g)) {
        const alias = m[1]
        expect(
          new RegExp(String.raw`private send\(msg: ${alias}\)`).test(src),
          `${name}: send() takes ${alias}, which is Record<string, unknown>`,
        ).toBe(false)
      }
    })
  }

  it('app:clear-state requires its bundleId, at both levels', () => {
    // The one real defect this layer found. Both clients are the only producers and both send a string; both
    // agents answer `app:clear-state-error` with 'bundleId missing' when it is absent; the relay forwards
    // without filling it in. So `payload?: { bundleId?: string }` described a message whose only outcome was
    // that error, and it compiled.
    const proto = readFileSync(join(root, 'packages/protocol/src/index.ts'), 'utf8')
    const decl = proto.match(/export interface AppClearState \{([\s\S]*?)\n\}/)
    expect(decl, 'AppClearState is gone').not.toBeNull()
    expect(decl[1]).toMatch(/^ {2}payload: \{ bundleId: string \}$/m)
  })
})
