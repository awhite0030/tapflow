import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Two facts about `packages/protocol/src/index.ts` that no type can state about itself.
//
// **1. Which interface owns which `type` literal.** `Equals<Union, UnionOld>` — the net L1 used to
// prove the conversion preserved every union — compares union *contents*, and a union is a set. Which
// name got which literal is not part of the comparison. `AgentToBrowser` has seven members whose shape
// is identical apart from the literal (`{ type: <literal>; sessionId: string }`), so swapping two of
// them passes `Equals`, passes `browserInboundRouting` (which compares membership, so the literal set
// is unchanged) and passes `protocolPayloadTypes`. Measured: the swap produced zero errors from the
// nine `Equals` assertions and two from the bindings.
//
// The bindings in `typeAssertions.ts` (`export const _InputDone: InputDone['type'] = 'input:done'`)
// are what catch it, and this file asserts every message interface has one — a guard you can forget an
// entry of is a guard with 57-of-58 coverage, and the missing one is invisible.
//
// **2. That a session-scoped failure declares `extends SessionScoped`.** This cannot be asserted with a
// type: every object with `{ sessionId, message }` is assignable to `SessionError`, so the assignment
// succeeds whether or not the interface declares the inheritance. And `extends` is transparent to
// `Equals` — inherited members arrive in the resolved member set, so an error written inline instead
// passes every type-level check. The inheritance exists for the family relation, which is source text,
// so the check reads source text.

const root = join(import.meta.dirname, '../..')
const src = readFileSync(join(root, 'packages/protocol/src/index.ts'), 'utf8')
const assertionsRaw = readFileSync(join(root, 'packages/protocol/src/typeAssertions.ts'), 'utf8')
// Comments out before anything looks for declarations. The bindings' own note explains what `Equals<>`
// did and did not catch, and the "net is gone" assertion below read that prose as the net still being
// there. Same shape as the bug in `browserInboundRouting`, where a comment mentioning `{ type: 'error' }`
// was counted as an eleventh union member.
const assertions = assertionsRaw.replace(/^\s*\/\/.*$/gm, '')

/** Every `export interface` that declares a `type: '<literal>'` — i.e. every wire message.
 *
 *  Bodies are found by counting braces, not by matching a run of two-space lines. The regex version
 *  skipped any interface with a blank line in its body — and `expect(messages.size).toBe(65)` was then
 *  satisfied *because* of the skip, so a new message with no binding passed all seventeen assertions.
 *  A count is only coverage if the parser cannot lose a declaration. */
function messageInterfaces(text) {
  const out = new Map()
  for (const m of text.matchAll(/export interface (\w+)(?: extends (\w+))? \{/g)) {
    let depth = 0
    let end = m.index + m[0].length - 1
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++
      else if (text[end] === '}' && --depth === 0) break
    }
    const body = text.slice(m.index + m[0].length, end)
    const lit = body.match(/^ {2}type: '([^']+)';?$/m)
    if (lit) out.set(m[1], { literal: lit[1], extends: m[2] ?? null, body })
  }
  return out
}

/** The interface name a `type` literal implies: PascalCase over its `:`/`-` segments.
 *
 *  This is the only assertion here that a regeneration cannot satisfy. The bindings in
 *  `typeAssertions.ts` compare two copies of one fact — the interface's literal and the binding's — so
 *  they catch an author who edits one. They do not catch an author who edits both, and since the names
 *  were *derived* mechanically, "regenerate the table" is the natural response to a rename in progress:
 *  it re-derives from the declarations it is meant to check. Measured — swapping two literals in
 *  `index.ts` *and* their two binding lines left all 228 script assertions green.
 *
 *  A derivation rule is independent of both copies. */
function derivedName(literal) {
  return literal.split(/[:-]/).map((p) => p[0].toUpperCase() + p.slice(1)).join('')
}

// Names that deliberately do not follow the derivation, each because the literal alone cannot name the
// interface. Two literals travel in both directions with different shapes, so each needs two names; and
// `Error` would shadow the global.
const NAME_EXCEPTIONS = new Map([
  ['GenericError', 'error'],
  // `agent:resources` derives `AgentResources`, which protocol already exports — as the *payload* shape
  // this message carries. Renaming that one is a breaking change to a published type that `agent-core`,
  // `relay` and `dashboard` all re-export, so the message takes a different name instead.
  ['AgentResourceReport', 'agent:resources'],
  ['AppInstallToAgent', 'app:install'],
  ['AppInstallToRelay', 'app:install'],
  ['AppLaunchToAgent', 'app:launch'],
  ['AppLaunchToRelay', 'app:launch'],
])

const messages = messageInterfaces(src)

describe('protocol message interfaces', () => {
  it('found every message interface — the parser is not quietly empty', () => {
    // Without this the two assertions below pass on an empty map. The count is pinned rather than
    // derived so that a parser that stops matching says so, instead of reporting full coverage of
    // nothing. L2 shipped that exact failure in the other direction. 58 is 57 from L1's conversion plus
    // `InputKey`, which was already named and is a message like any other. L4a added the seven agent→relay
    // messages, the last direction that had none.
    expect(messages.size).toBe(65)
    // `InputKey` predates L1 and has always been named; it must be in here too.
    expect(messages.has('InputKey')).toBe(true)
  })

  it('every message interface has a name↔literal binding', () => {
    const missing = []
    const wrong = []
    for (const [name, { literal }] of messages) {
      const line = assertions.match(new RegExp(`^export const _${name}: ${name}\\['type'\\] = '([^']+)'$`, 'm'))
      if (!line) missing.push(name)
      // The compiler already rejects a binding whose value disagrees with the interface. This catches
      // the other direction — a binding whose literal drifted along *with* the interface, which
      // compiles and asserts nothing about what the wire carries.
      else if (line[1] !== literal) wrong.push(`_${name} says '${line[1]}', interface says '${literal}'`)
    }
    expect(missing).toEqual([])
    expect(wrong).toEqual([])
  })

  it('every message name is derivable from its literal', () => {
    const offenders = []
    for (const [name, { literal }] of messages) {
      const expected = NAME_EXCEPTIONS.get(name)
      if (expected !== undefined) {
        // An exception still has to name the right message.
        if (literal !== expected) offenders.push(`${name} is listed for '${expected}' but declares '${literal}'`)
        continue
      }
      if (name !== derivedName(literal)) offenders.push(`${name} declares '${literal}', which derives ${derivedName(literal)}`)
    }
    expect(offenders).toEqual([])
    // Pinned so an exception cannot be added quietly to make a rename compile.
    expect(NAME_EXCEPTIONS.size).toBe(6)
  })

  // Failures addressed to a *request*, not to a session: the relay resolves both by `requestId` alone
  // (`RelayServer.ts:1293-1312`). Listing them draws the boundary of `SessionError` rather than widening it —
  // the base is for a failure a session is waiting on.
  const REQUEST_SCOPED = new Set(['screenshot:error', 'ui:tree:error'])

  it('a session-scoped failure declares extends SessionScoped', () => {
    const offenders = []
    for (const [name, { literal, extends: base, body }] of messages) {
      const isFailure = /error$/.test(literal) && !REQUEST_SCOPED.has(literal)
      const hasSession = /^ {2}sessionId[?]?:/m.test(body) || base === 'SessionScoped'
      // `error` used to be excluded here, on the grounds that it was the escape hatch for a failure that
      // could not be attributed to a session — "the member's nature, not an exception". L5d replaced that
      // nature: a request naming no session is dropped at the relay's door, so every producer of `error`
      // answers one specific join, and it joins the family like every other session-scoped failure. The
      // predicate needed no change; what changed is that `error` now satisfies it.
      if (!isFailure || !hasSession) continue
      if (base !== 'SessionScoped') offenders.push(`${name} ('${literal}')`)
    }
    expect(offenders).toEqual([])
    expect([...messages].filter(([, m]) => m.extends === 'SessionScoped')).toHaveLength(9)
    // `error` is the ninth, as of L5d. Pinned by name rather than only by the count, because the count alone
    // would be satisfied by any new member and this is the one whose membership was argued.
    expect(messages.get('GenericError')).toMatchObject({ literal: 'error', extends: 'SessionScoped' })
    // #491 moved `message` off the base onto each member that requires it, so the family relation is no
    // longer implied by the shared pair — the `extends` is the only thing left saying these nine are one
    // kind. That makes this assertion load-bearing in a way it was not when the base carried two fields.
    for (const [name, { body, extends: base }] of messages) {
      if (base !== 'SessionScoped' || name === 'InputError') continue
      expect(/^ {2}message: string$/m.test(body), `${name} lost its message declaration`).toBe(true)
    }
    expect(REQUEST_SCOPED.size).toBe(2)
    for (const literal of REQUEST_SCOPED) {
      const entry = [...messages].find(([, m]) => m.literal === literal)
      expect(entry, `${literal} is gone`).toBeDefined()
      expect(entry[1].extends, `${literal} now extends something`).toBeNull()
      // What makes them request-scoped is `requestId`, not a weak `sessionId`. An earlier draft asserted
      // the field was *optional* and took that as the evidence — but every producer has one, so declaring
      // it optional described a message nobody sends. Required, and out of the family.
      expect(entry[1].body).toMatch(/^ {2}sessionId: string$/m)
      expect(entry[1].body).toMatch(/^ {2}requestId: string$/m)
    }
    // What the base carries, pinned. `browserInboundRouting`'s signatures resolve `extends` and sort,
    // so they cannot tell an inherited field from an own-declared one: moving `sessionId` out of the
    // base and into all nine subclasses leaves every signature identical and every check green.
    // Measured. This line is what makes the inheritance mean something.
    //
    // It carried `message` too until #491, which demoted prose to optional on `input:error` alone —
    // TypeScript cannot narrow an inherited required member, so the field moved onto each of the nine.
    // That left the base with the one thing all nine actually share, and the name followed the shape.
    const base = readFileSync(join(root, 'packages/protocol/src/index.ts'), 'utf8')
      .match(/export interface SessionScoped \{([^}]*)\}/)
    expect(base, 'SessionScoped is gone').not.toBeNull()
    expect([...base[1].matchAll(/^ {2}(\w+)(\??):/gm)].map((m) => m[1] + m[2]).sort()).toEqual(['sessionId'])
  })

  it('the L1 conversion net is gone', () => {
    // `Equals` and the `…Old` snapshots were the conversion-window net and were deleted with it. If
    // they come back, they are being mistaken for lasting protection — they compare unions that no
    // longer have an "old" to compare against, so a fresh snapshot would be taken from the same
    // declarations it is meant to check.
    expect(assertions).not.toMatch(/type \w+Old =/)
    expect(assertions).not.toMatch(/Equals</)
  })
})
