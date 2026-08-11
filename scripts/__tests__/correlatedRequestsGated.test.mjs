import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

// Every browser request that declares a **required** `requestId` must be gated at the relay's door, because
// every reply it can produce declares the correlator required too — so an ungated request means the relay
// either ships a frame with an absent required field, or forwards one whose reply nobody can attribute.
// Both were live defects: `requestId: msg.requestId!` in `clipboard:error` and, one slice earlier, in
// `open-url:error`. The second was fixed and the first survived next door for a whole slice.
//
// The claim "one policy at the door" was prose in a comment until this file. It is checkable because the
// property is **presence of a gate** — unlike the echo obligation, where the property is provenance and no
// check can see it (see the note above `OpenUrlReplyBody`).
//
// The member set is **derived** from the protocol, so a seventh correlated request added later fails here
// rather than being noticed by whoever reads the comment. Two gate forms count, and both are real:
//
//  - `isCorrelated(msg)` inside the `case` — the inline form.
//  - dispatch to a handler whose parameter is narrowed to `{ requestId: string }` — then the **compiler**
//    enforces the gate, since an ungated `msg` does not satisfy the signature.

const root = join(import.meta.dirname, '../..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const sourceOf = (path, src) =>
  ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

/** `BrowserToRelay` members whose declaration carries a required `requestId`. */
function correlatedRequestTypes(proto) {
  const rhs = proto.match(/export type BrowserToRelay =([\s\S]*?)\n\n/)
  expect(rhs, 'BrowserToRelay is gone').not.toBeNull()
  const members = rhs[1].split('|').map((s) => s.trim()).filter(Boolean)

  const out = []
  const seen = new Set()
  // Members can be nested unions — `ClipboardRequest` is `ClipboardRead | ClipboardWrite`, and the first
  // version of this file missed both because it only looked for an `export interface` of that name. The
  // count assertion below is what caught it.
  const resolve = (name) => {
    if (seen.has(name)) return
    seen.add(name)
    const decl = proto.match(new RegExp(String.raw`^export interface ${name}(?: extends \w+)? \{([\s\S]*?)\n\}`, 'm'))
    if (decl) {
      // `requestId?: string` does not count — the point is the required ones.
      if (!/^ {2}requestId: string$/m.test(decl[1])) return
      const lit = decl[1].match(/^ {2}type: '([^']+)'/m)
      expect(lit, `${name} has no literal type`).not.toBeNull()
      out.push(lit[1])
      return
    }
    const alias = proto.match(new RegExp(String.raw`^export type ${name} =([\s\S]*?)(?=\n\n|\nexport )`, 'm'))
    if (!alias) return
    for (const n of alias[1].split('|').map((x) => x.trim()).filter(Boolean)) resolve(n)
  }
  for (const name of members) resolve(name)
  return out
}

/** Handlers whose `msg` parameter is narrowed to carry the correlator — the compiler-enforced gate form. */
function narrowedHandlers(sf) {
  const names = new Set()
  const visit = (node) => {
    if (ts.isMethodDeclaration(node) && node.name) {
      const p = node.parameters.find((x) => x.name.getText(sf) === 'msg')
      if (p?.type && /requestId:\s*string/.test(p.type.getText(sf))) names.add(node.name.getText(sf))
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return names
}

/** For each `case '<type>':` in the relay's message switch, the text of its clause. */
function caseBodies(sf) {
  const bodies = new Map()
  const visit = (node) => {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
      // Fall-through clauses (`case 'a': case 'b': { … }`) have an empty statement list; the following
      // clause carries the body, so accumulate until one is non-empty.
      bodies.set(node.expression.text, node.statements.map((s) => s.getText(sf)).join('\n'))
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  // Resolve fall-through: an empty clause shares the next non-empty one.
  const entries = [...bodies.entries()]
  for (let i = 0; i < entries.length; i++) {
    if (entries[i][1] !== '') continue
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j][1] !== '') { bodies.set(entries[i][0], entries[j][1]); break }
    }
  }
  return bodies
}

describe('every correlated browser request is gated at the relay door', () => {
  const proto = read('packages/protocol/src/index.ts')
  const relayPath = 'packages/relay/src/RelayServer.ts'
  const relaySrc = read(relayPath)
  const sf = sourceOf(relayPath, relaySrc)

  const types = correlatedRequestTypes(proto)
  const handlers = narrowedHandlers(sf)
  const bodies = caseBodies(sf)

  it('finds the correlated request set, derived rather than listed', () => {
    // If this drops to zero the derivation broke and every assertion below would vacuously pass — the
    // failure mode a count assertion exists for.
    expect(types.length).toBeGreaterThanOrEqual(6)
  })

  for (const type of types) {
    it(`${type} is gated`, () => {
      const body = bodies.get(type)
      expect(body, `${type} has no case in the relay's switch`).toBeDefined()

      const inline = body.includes('isCorrelated(msg)')
      const viaHandler = [...handlers].some((h) => body.includes(`this.${h}(`))
      expect(
        inline || viaHandler,
        `${type} reaches the relay with no correlator gate: no isCorrelated(msg), and no dispatch to a ` +
        `handler whose msg parameter requires requestId (candidates: ${[...handlers].join(', ') || 'none'})`,
      ).toBe(true)
    })
  }

  it('the gate tests both halves — absent and empty', () => {
    // A gate that only checked `!== undefined` would let `''` through, and one that only checked `typeof`
    // would let `''` through too. Both halves have a relay test behind them; this pins the predicate the
    // derivation above trusts.
    const decl = relaySrc.match(/function isCorrelated\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)
    expect(decl, 'isCorrelated is gone').not.toBeNull()
    expect(decl[1]).toMatch(/typeof msg\.requestId === 'string'/)
    expect(decl[1]).toMatch(/msg\.requestId !== ''/)
  })
})
