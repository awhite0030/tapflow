import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { sources } from './sourceFiles.mjs'
import { join } from 'node:path'
import ts from 'typescript'

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
// So the rule is the sibling's: **`JSON.stringify` appears once per file, and it serializes a parameter declared
// `BrowserToRelay` by the function enclosing it.** That constrains the sink rather than its name, so a rename
// passes and a second untyped path cannot. It also stops keying on syntactic form — `useRelay`'s send is a
// `useCallback` arrow, and a check pinned to `private send(` both missed it and would have failed on a harmless
// refactor of the other two.
//
// **"Enclosing" is resolved on the AST, not by scanning backwards for the nearest signature.** The second draft
// did scan, and review broke that too:
//
//     function send(msg: BrowserToRelay) {}
//     function sendRaw(payload: RelayMsg, audit: boolean) { socket.send(JSON.stringify(payload)) }
//
// The scan walks straight past `sendRaw`'s boundary and reports `BrowserToRelay`, because the parameter name is
// outside the pattern's allowlist. Which means the difference between caught and not caught was *what the
// parameter happened to be called* — in a file whose header disclaims exactly that brittleness. This program has
// now shipped five region parsers that did not know where their region ended, so this one uses the real one.

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

const isFn = (n) =>
  ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)

/** Every `JSON.stringify(x)` in a file, described by what it serializes and how the innermost enclosing function
 *  declares that name. `{ arg, declaredType }`, the latter `null` when `arg` is not one of its parameters — which
 *  is the case a scan cannot see: serializing something the enclosing signature never promised anything about. */
function serializationSites(src, path) {
  const sf = ts.createSourceFile(
    path, src, ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const sites = []
  const visit = (node, fn) => {
    const enclosing = isFn(node) ? node : fn
    if (ts.isCallExpression(node) && node.expression.getText(sf) === 'JSON.stringify') {
      const arg = node.arguments[0]?.getText(sf) ?? null
      const param = enclosing?.parameters.find((p) => p.name.getText(sf) === arg)
      sites.push({ arg, declaredType: param?.type?.getText(sf) ?? null })
    }
    ts.forEachChild(node, (c) => visit(c, enclosing))
  }
  visit(sf, undefined)
  return sites
}

describe('browser-role outbound is typed against the wire contract', () => {
  for (const [name, path] of Object.entries(FILES)) {
    const src = stripComments(readFileSync(join(root, path), 'utf8'))

    it(`${name} serializes exactly once`, () => {
      // A second serializer is the bypass this file exists for: it needs no rename to defeat a signature
      // assertion, because the assertion keeps passing on the helper that is still typed.
      expect(serializationSites(src, path)).toHaveLength(1)
    })

    it(`${name} serializes a BrowserToRelay parameter of the function it sits in`, () => {
      // `declaredType` is non-null only when the serialized name is one of the enclosing function's parameters,
      // so this says "it serializes its own promise" without pinning what that parameter is called.
      const [site] = serializationSites(src, path)
      expect(
        site.declaredType,
        `serializes \`${site.arg}\`, which the enclosing function does not declare as BrowserToRelay`,
      ).toBe('BrowserToRelay')
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
    // The assertions above bind the sinks to this union's *name*. Nothing bound its contents, and appending
    // `| Record<string, unknown>` to it passed all 250 static assertions while making every literal in all
    // three files accept anything — the guard pointing at this declaration raised nothing.
    //
    // Checking the members look like type names is not enough either: `| UnsafeOutbound` is capitalised, and
    // `type UnsafeOutbound = Record<string, unknown>` beside it reopens the hole through one indirection. So each
    // member is resolved to its declaration, which must be an exported `interface` carrying a literal `type`.
    const proto = readFileSync(join(root, 'packages/protocol/src/index.ts'), 'utf8')
    const rhs = proto.match(/export type BrowserToRelay =([\s\S]*?)\n\n/)
    expect(rhs, 'BrowserToRelay is gone').not.toBeNull()
    const members = rhs[1].split('|').map((s) => s.trim()).filter(Boolean)
    expect(members.length).toBeGreaterThan(10)

    // Members may be nested unions of interfaces — `ClipboardRequest` is `ClipboardRead | ClipboardWrite`, and
    // `RelayOrAgentToBrowser` is referenced by two directions on purpose. So resolve to leaves and judge those.
    const leaves = []
    const seen = new Set()
    const resolve = (name, from) => {
      expect(name, `${from}: not a named message: ${name}`).toMatch(/^[A-Z]\w*$/)
      if (seen.has(name)) return
      seen.add(name)
      const iface = proto.match(new RegExp(String.raw`^export interface ${name}(?: extends \w+)? \{([\s\S]*?)\n\}`, 'm'))
      if (iface) {
        expect(iface[1], `${name} has no literal type field`).toMatch(/^ {2}type: '[^']+'/m)
        leaves.push(name)
        return
      }
      const alias = proto.match(new RegExp(String.raw`^export type ${name} =([\s\S]*?)(?=\n\n|\nexport )`, 'm'))
      expect(alias, `${name} resolves to neither an interface nor a union of them — an alias can widen the union`)
        .not.toBeNull()
      const nested = alias[1].split('|').map((s) => s.trim()).filter(Boolean)
      expect(nested.length, `${name} is an alias, not a union`).toBeGreaterThan(1)
      for (const n of nested) resolve(n, name)
    }
    for (const m of members) resolve(m, 'BrowserToRelay')
    expect(leaves.length).toBeGreaterThan(10)
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
