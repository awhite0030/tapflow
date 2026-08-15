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
 * For each literal in the inbound schema map, the text of its schema expression.
 *
 * Parsed rather than grepped: a `z.object({ … })` spans lines and nests, so a line-based match would
 * stop at the first `}` and read a request's gate off its payload's shape.
 */
function schemaBodies(sf) {
  const out = new Map()
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) {
      out.set(node.name.text, node.initializer.getText(sf))
    }
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
  const bodies = schemaBodies(sf)

  it('finds the correlated request set, derived rather than listed', () => {
    // If this drops to zero the derivation broke and every assertion below would vacuously pass — the
    // failure mode a count assertion exists for. The floor is raised as pairs land, so removing a
    // required `requestId` from a request already in the set fails here too, not only where it is used:
    // 6 after the app commands, 7 once `device:boot` joined.
    expect(types.length).toBeGreaterThanOrEqual(7)
  })

  for (const type of types) {
    it(`${type} is gated`, () => {
      const body = bodies.get(type)
      expect(body, `${type} has no schema in the inbound map — the door would refuse it as unknown-type`)
        .toBeDefined()

      expect(
        /(^|[^.\w])requestId\b/.test(body),
        `${type} declares a required requestId but its schema does not demand one, so the door forwards ` +
        `an uncorrelatable request and the reply it produces cannot be attributed`,
      ).toBe(true)
      expect(
        body.includes('requestId: requestId.optional()'),
        `${type} declares a required requestId and its schema makes it optional — the two disagree, and ` +
        `the schema is the one the wire obeys`,
      ).toBe(false)
    })
  }

  it('the gate tests both halves — absent and empty', () => {
    // The predicate this replaced rejected `''` as well as absence, and a bare `z.string()` accepts it.
    // Nothing type-level can hold that: `.min(1)` does not change what `z.output` infers, which is
    // exactly why it costs the tier assertions nothing — so it is checked here and exercised in
    // `protocol`'s own `rejects an empty requestId`.
    expect(validateSrc).toMatch(/^const requestId = z\.string\(\)\.min\(1\)$/m)
    expect(validateSrc).toMatch(/^const sessionId = z\.string\(\)\.min\(1\)$/m)
  })
})
