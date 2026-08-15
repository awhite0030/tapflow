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
// The member set is **derived** from the protocol, so an eighth correlated request added later fails here
// rather than being noticed by whoever reads the comment.
//
// **Where the gate lives moved, and this file moved with it.** It used to be `isCorrelated(msg)` written
// into each `case`, or a dispatch to a handler whose parameter was narrowed to `{ requestId: string }`.
// Since #444 the door is a parse: `@tapflowio/protocol/validate` refuses a frame whose schema declares
// `requestId` before `route` ever runs. So the property to check is that each correlated request's
// **schema** demands the correlator — the same claim, one layer earlier, and now covering the empty
// string as well as the absent field without either being spelled out at a call site.
//
// Checking the schema rather than the case body is also why this survives the next refactor of the
// switch: the gate is no longer something a `case` can forget to write.

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

/**
 * For each literal in the inbound schema map, the **top-level** `requestId` property of its schema.
 *
 * Parsed rather than grepped, and the difference is the whole check. A first draft matched
 * `/(^|[^.\w])requestId\b/` against the schema's source text, which passes on a `requestId` nested
 * inside a payload, on the word appearing in a comment, and — the one that matters — on an inline
 * `requestId: z.string()` written in place of the shared `.min(1)` constant. That last one is
 * invisible to every other gate in the repo: `SchemaExact` cannot see it, because `.min(1)` does not
 * change what `z.output` infers, which is exactly why it costs the tier assertions nothing. The
 * empty-string half would have gone back to being unguarded per message while the whole suite stayed
 * green, reproducing the `clipboard:error` defect this file exists for.
 *
 * Returns `null` when there is no `requestId` property, and otherwise the initializer's text.
 */
function correlatorOf(sf) {
  const out = new Map()
  const visit = (node) => {
    // `'app:install': z.object({ … })` — a string-literal key whose value is a call.
    if (!ts.isPropertyAssignment(node) || !ts.isStringLiteral(node.name)) return ts.forEachChild(node, visit)
    const shape = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : undefined
    if (!shape || !ts.isObjectLiteralExpression(shape)) {
      out.set(node.name.text, { present: false, init: null })
      return ts.forEachChild(node, visit)
    }
    const prop = shape.properties.find(
      (p) =>
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        p.name && ts.isIdentifier(p.name) && p.name.text === 'requestId',
    )
    out.set(node.name.text, {
      present: prop !== undefined,
      // A shorthand `requestId,` *is* the shared constant; a longhand carries its own expression.
      init: prop === undefined ? null : ts.isShorthandPropertyAssignment(prop) ? 'requestId' : prop.initializer.getText(sf),
    })
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

describe('every correlated browser request is gated at the relay door', () => {
  const proto = read('packages/protocol/src/index.ts')
  const validatePath = 'packages/protocol/src/validate/index.ts'
  const validateSrc = read(validatePath)
  const sf = sourceOf(validatePath, validateSrc)

  const types = correlatedRequestTypes(proto)
  const bodies = correlatorOf(sf)

  it('finds the correlated request set, derived rather than listed', () => {
    // If this drops to zero the derivation broke and every assertion below would vacuously pass — the
    // failure mode a count assertion exists for. The floor is raised as pairs land, so removing a
    // required `requestId` from a request already in the set fails here too, not only where it is used:
    // 6 after the app commands, 7 once `device:boot` joined.
    expect(types.length).toBeGreaterThanOrEqual(7)
  })

  for (const type of types) {
    it(`${type} is gated`, () => {
      const entry = bodies.get(type)
      expect(entry, `${type} has no schema in the inbound map — the door would refuse it as unknown-type`)
        .toBeDefined()

      expect(
        entry.present,
        `${type} declares a required requestId but its schema has no top-level requestId, so the door ` +
        `forwards an uncorrelatable request and the reply it produces cannot be attributed`,
      ).toBe(true)

      // The shared constant, or something that carries its `.min(1)` — and never `.optional()`.
      // Both halves matter: absence lets the request through uncorrelated, and `''` produces a reply
      // whose required correlator is present-but-empty, which every correlating consumer discards.
      expect(
        entry.init === 'requestId' || /\.min\(1\)/.test(entry.init),
        `${type}'s schema declares requestId as \`${entry.init}\`, which does not carry the non-empty ` +
        `constraint. Use the shared \`requestId\` constant — an inline z.string() accepts '' and no ` +
        `type-level assertion can see the difference.`,
      ).toBe(true)
      expect(
        /\.optional\(\)|\.nullish\(\)/.test(entry.init),
        `${type} declares a required requestId and its schema makes it optional — the two disagree, and ` +
        `the schema is the one the wire obeys`,
      ).toBe(false)
    })
  }

  it('the shared constants carry the non-empty half', () => {
    // The per-type assertions above accept the shared constant by name, so this is what gives that name
    // its meaning. Weakening the constant fails here; weakening one call site fails above.
    expect(validateSrc).toMatch(/^const requestId = z\.string\(\)\.min\(1\)$/m)
    expect(validateSrc).toMatch(/^const sessionId = z\.string\(\)\.min\(1\)$/m)
  })
})
