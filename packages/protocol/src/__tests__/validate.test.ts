/**
 * `parseInbound` / `directionOf` — the runtime half of the door.
 *
 * The type-level half lives beside the schemas in `validate/index.ts` and is mutation-tested: eight
 * mutations were run against it and eight were caught (a payload added to an Envelope schema as
 * `z.unknown()`, `z.any()` and `z.custom<T>()`; an envelope emptied to `z.object({})`; a Validated
 * schema swapped for `z.custom`; a member dropped from the map; an envelope losing its correlator; an
 * optional field made required).
 *
 * **Two survived, and they are what this file exists for.** `.min(1)` and `.default([])` are runtime
 * behaviour that does not change what `z.output` infers — by design, since that is exactly why they
 * cost the tier assertions nothing — so no type-level assertion can hold them. Removing either leaves
 * the whole static suite green. `rejects an empty sessionId` and `accepts an agent that predates
 * capabilities` are the tests that fail instead; the rest of the file covers the door's own branches.
 */
import { describe, expect, it } from 'vitest'

import { directionOf, parseInbound } from '../validate/index.js'

/** The narrowing every test does. Written once because `parseInbound` returns a union and each test
 *  would otherwise repeat the same four lines to reach `msg`. */
function ok(raw: unknown) {
  const r = parseInbound(raw)
  if (!r.ok) throw new Error(`expected a parse, got ${r.reason}`)
  return r
}

function fail(raw: unknown) {
  const r = parseInbound(raw)
  if (r.ok) throw new Error('expected a rejection, got a parse')
  return r
}

describe('the door rejects what it cannot name', () => {
  // `JSON.parse` returns bare `null`, numbers and strings without throwing, and the caller reads
  // `.type` off whatever it is handed.
  it.each([null, 42, 'a string', true, []])('refuses %p as not-an-object', (raw) => {
    expect(fail(raw).reason).toBe('not-an-object')
  })

  it('refuses a frame with no type', () => {
    expect(fail({ sessionId: 's' }).reason).toBe('unknown-type')
  })

  it('refuses a type nothing declares', () => {
    const r = fail({ type: 'input:teleport', sessionId: 's' })
    expect(r.reason).toBe('unknown-type')
    if (r.reason === 'unknown-type') expect(r.type).toBe('input:teleport')
  })

  // **The universe is the inbound map, not every literal the protocol declares.** Eleven types are
  // relay-produced and belong to no inbound direction. A browser that sends one is inert today — it
  // reaches the switch and matches no case. Classifying it as a *direction* violation instead would
  // route it to the 1008 close, disconnecting a dashboard over a frame that does nothing.
  it.each(['session:joined', 'error', 'agents:listed', 'session:terminated', 'stream:registered'])(
    'reads the relay-produced %s as unknown rather than as a direction violation',
    (type) => {
      expect(fail({ type, sessionId: 's' }).reason).toBe('unknown-type')
    },
  )

  it('reports the type it refused on a shape failure, so a log can name it', () => {
    const r = fail({ type: 'device:boot', sessionId: 's', requestId: 'r' })
    expect(r.reason).toBe('bad-shape')
    if (r.reason === 'bad-shape') {
      expect(r.type).toBe('device:boot')
      expect(r.detail).toMatch(/payload/i)
    }
  })
})

describe('an empty correlator is not a correlator', () => {
  // The predicates this replaced (`isAddressed` / `isCorrelated`) rejected `''` as well as absence,
  // and a bare `z.string()` accepts it. Losing that half is invisible to every type-level assertion:
  // `.min(1)` does not change what `z.output` infers. What it costs is concrete — a `device:boot`
  // with `requestId: ''` would pass the door, fail at `dispatchTarget`, and be answered with a
  // `device:boot-error` carrying `requestId: ''`, a frame whose required correlator is
  // present-but-empty and which every correlating consumer discards.
  it('rejects an empty sessionId', () => {
    expect(fail({ type: 'session:start', sessionId: '' }).reason).toBe('bad-shape')
  })

  it('rejects an empty requestId', () => {
    const raw = { type: 'device:boot', sessionId: 's', requestId: '', payload: { deviceId: 'd' } }
    expect(fail(raw).reason).toBe('bad-shape')
  })

  it('rejects a non-string sessionId', () => {
    expect(fail({ type: 'session:start', sessionId: 7 }).reason).toBe('bad-shape')
  })

  // The mirror. Without it, a schema that rejected *every* sessionId would pass the two above.
  it('accepts a real one', () => {
    expect(ok({ type: 'session:start', sessionId: 's' }).msg).toEqual({ type: 'session:start', sessionId: 's' })
  })
})

describe('an agent older than a field still registers', () => {
  // `AgentRegister` declares `capabilities` and `devices` required, and an agent that predates either
  // sends neither — which is how a viewer tells them apart. The relay carried `msg.capabilities ?? []`
  // for exactly this. The `.default([])` moves that tolerance into the schema, where it is visible,
  // and it is invisible to the type assertions because `z.output` is `string[]` either way.
  it('accepts an agent that predates capabilities', () => {
    const raw = { type: 'agent:register', platform: 'ios', agentName: 'mac-1', devices: [] }
    expect(ok(raw).msg).toMatchObject({ capabilities: [], devices: [] })
  })

  it('accepts an agent that reports no devices', () => {
    const raw = { type: 'agent:register', platform: 'ios', agentName: 'mac-1', capabilities: ['clipboard'] }
    expect(ok(raw).msg).toMatchObject({ capabilities: ['clipboard'], devices: [] })
  })

  // **The most expensive rejection in the protocol, so the most tolerant schema.** A first draft
  // required `platform` and `agentName` — both declared required, both sent by both agents here — and
  // the relay reads each through a `??`. An agent omitting either would have had its frame refused, so
  // no `agent:registered` goes back, so its handshake promise never resolves: the whole Mac and every
  // device on it absent from the dashboard, with one relay-side warn as the only trace.
  it('registers an agent that sends neither a platform nor a name', () => {
    const r = ok({ type: 'agent:register', devices: [] })
    expect(r.msg).toMatchObject({ platform: '', agentName: '', capabilities: [], devices: [] })
  })

  // `''` and not `undefined` is what lets `z.output` match the interface, and it has to stay falsy:
  // the relay's eviction runs only `if (identity)`, where identity is `agentId ?? agentName`. A
  // placeholder like `'unknown'` there would make every nameless agent evict every other one.
  it('leaves a defaulted name falsy, because identity keys on it', () => {
    const r = ok({ type: 'agent:register', devices: [] })
    expect((r.msg as { agentName: string }).agentName).toBeFalsy()
  })

  // The tolerance is for *absence*, not for a wrong shape — otherwise `.default()` would be
  // indistinguishable from not checking the field at all.
  it('still refuses capabilities that are not strings', () => {
    const raw = { type: 'agent:register', platform: 'ios', agentName: 'm', capabilities: [{}] }
    expect(fail(raw).reason).toBe('bad-shape')
  })

  it('defaults a screenshot format the way the relay used to', () => {
    const raw = { type: 'screenshot:done', sessionId: 's', requestId: 'r', data: 'AAA' }
    expect(ok(raw).msg).toMatchObject({ format: 'png' })
  })
})

describe('the Envelope tier hands back no payload', () => {
  // The tier's whole claim, at runtime. The static half is TC15's mutation — adding `payload` to an
  // envelope schema — which the assertion catches at compile time; this is what a reader can see.
  it('drops a chrome payload from the parse product while keeping it on the raw frame', () => {
    const payload = { buttons: [], streamType: 'h264' }
    const r = ok({ type: 'session:chrome', sessionId: 's', payload })
    expect(r.msg).toEqual({ type: 'session:chrome', sessionId: 's' })
    expect(r.raw['payload']).toBe(payload)
  })

  // Why the tier exists: `ChromePayload` is a closed two-member union while `AgentRegister.platform`
  // is open by OCP, so a third-party platform has no valid variant to send. Validating this message
  // would cost that platform its bezel and buttons for the life of the session — the message arrives
  // once per boot, and a rejection skips the cache the re-join replay reads.
  it('accepts a chrome payload belonging to neither declared variant', () => {
    const payload = { kind: 'some-third-platform', frameSvg: '<svg/>' }
    const r = ok({ type: 'session:chrome', sessionId: 's', payload })
    expect(r.raw['payload']).toBe(payload)
  })

  it('accepts an unknown field on a forwarded reply, so a newer agent is not broken by an older relay', () => {
    const raw = { type: 'input:done', sessionId: 's', requestId: 'r', hapticsApplied: true }
    const r = ok(raw)
    expect(r.msg).toEqual({ type: 'input:done', sessionId: 's', requestId: 'r' })
    expect(r.raw['hapticsApplied']).toBe(true)
  })

  // The envelope is still an envelope: the fields it does declare are checked.
  it('refuses a forwarded reply whose correlator is missing', () => {
    expect(fail({ type: 'input:done', sessionId: 's' }).reason).toBe('bad-shape')
  })
})

describe('a browser frame is stripped, because its product is what gets forwarded', () => {
  // The browser direction is the attacker-controllable one, and `z.object` strips rather than
  // rejects — so what makes an appended key harmless is that the relay forwards `msg` here and not
  // `raw`. If that ever flips, this test still passes and the relay's own test is what fails, which
  // is why the relay carries one too.
  it('removes a key the schema does not declare', () => {
    const raw = {
      type: 'input:key', sessionId: 's', requestId: 'r',
      payload: { code: 'KeyA', modifiers: 0, injected: 'rm -rf /' },
      extra: 'appended',
    }
    const r = ok(raw)
    expect(r.msg).toEqual({ type: 'input:key', sessionId: 's', requestId: 'r', payload: { code: 'KeyA', modifiers: 0 } })
    expect(r.raw['extra']).toBe('appended')
  })

  it('keeps an optional payload absent rather than inventing one', () => {
    const r = ok({ type: 'input:touch:end', sessionId: 's', requestId: 'r' })
    expect(r.msg).toEqual({ type: 'input:touch:end', sessionId: 's', requestId: 'r' })
  })

  // **`buildId` is carried through as `NaN` rather than refused, and that is deliberate.** It is the one
  // browser-side shape failure the relay *answers*: the handler checks `Number.isInteger` and replies
  // `Build not found`, so a caller learns why instead of waiting out its deadline. Refusing the frame
  // here deleted that answer — the door has no socket and no correlator policy, so it cannot answer in
  // the handler's place, and six relay tests asserting "answers … without going silent" went silent.
  //
  // What the schema still buys is that better-sqlite3 never sees the object or array that made it
  // *throw* — an exception the message loop swallowed, which is the silence `Number.isInteger` was
  // added to remove in the first place.
  it('turns an unusable buildId into NaN rather than refusing the frame', () => {
    for (const buildId of [{}, [], '3', 1.5, null, undefined]) {
      const r = ok({ type: 'app:install', sessionId: 's', requestId: 'r', buildId })
      expect(r.msg).toMatchObject({ type: 'app:install' })
      expect(Number.isInteger((r.msg as { buildId: number }).buildId)).toBe(false)
    }
  })

  it('keeps a real buildId', () => {
    expect(ok({ type: 'app:install', sessionId: 's', requestId: 'r', buildId: 3 }).msg).toMatchObject({ buildId: 3 })
  })
})

describe('directionOf replaces the hand-written agent list', () => {
  it('routes the handshake messages that decide a role', () => {
    expect(directionOf('agent:register')).toBe('agent')
    expect(directionOf('stream:register')).toBe('stream')
    expect(directionOf('session:start')).toBe('browser')
  })

  it.each(['screenshot:done', 'ui:tree:response', 'session:chrome', 'clipboard:data', 'input:error'] as const)(
    'calls %s an agent message, as the 1008 gate did',
    (type) => { expect(directionOf(type)).toBe('agent') },
  )

  it.each(['agents:list', 'device:boot', 'input:touch:move', 'clipboard:read', 'session:leave'] as const)(
    'calls %s a browser message',
    (type) => { expect(directionOf(type)).toBe('browser') },
  )

  // The first frame of an agent connection is the case that broke the first design of this module:
  // the role does not exist until this message is parsed, so a parser selecting a schema *by* role
  // could never validate it. Parsing first is what makes the answer available at all.
  it('answers for a type parsed before any role exists', () => {
    const r = ok({ type: 'agent:register', platform: 'ios', agentName: 'm', capabilities: [], devices: [] })
    expect(directionOf(r.msg.type)).toBe('agent')
  })
})
