import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import type { RelayMessage } from '../types'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'

// #492. The relay answers a terminal input it cannot dispatch, and it was the last producer of
// `input:error` sending no `reason` — while being the one that knows the answer with the most
// certainty, since it is looking at the socket rather than inferring from its own state.
//
// Two situations reach that reply and only one is the agent's fault, so the prose split matters too:
// a session held with a closed socket really is an absent agent, but no session at all can mean an
// evicted id in front of a perfectly healthy agent.
describe('input:error from the relay carries a reason (#492)', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-input-reason-test-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(async () => {
    server = new RelayServer({ port: 0 })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.stop()
  })

  async function joinedSession() {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register',
      devices: [{ id: 'dev-1', name: 'iPhone', platform: 'ios', status: 'booted' }],
    }))
    const reply = await waitForType<RelayMessage>(agent, 'agent:registered')
    const sessionId = reply.registeredSessions![0].sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    return { agent, browser, sessionId }
  }

  /** Leaves the session in the relay with a socket that is no longer open — the reconnect grace holds
   *  the id, which is what makes this the branch where "the agent is gone" is the true statement. */
  async function agentGone() {
    const { agent, browser, sessionId } = await joinedSession()
    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed
    return { browser, sessionId }
  }

  const terminals: Array<[string, Record<string, unknown>]> = [
    ['input:touch:end', { x: 0.5, y: 0.5 }],
    ['input:pinch:end', { f0: { x: 0.4, y: 0.4 }, f1: { x: 0.6, y: 0.6 } }],
    ['input:key', { code: 'KeyA' }],
    ['input:button', { name: 'home' }],
  ]

  for (const [type, payload] of terminals) {
    it(`answers ${type} with reason channel-unavailable when the agent's socket is gone`, async () => {
      const { browser, sessionId } = await agentGone()

      browser.send(JSON.stringify({ type, sessionId, requestId: 'rq-terminal', payload }))
      // By type, not "the next message": losing the agent also produces a `session:agent-away`, and
      // whichever lands first is not this test's subject. (Not `session:terminated` — that waits for
      // the 15s grace to expire, long after this test is over.)
      const err = await waitForType(browser, 'input:error')
      expect(err.sessionId).toBe(sessionId)
      expect(err.reason).toBe('channel-unavailable')
      expect(err.message).toBe('agent offline')

      browser.close()
    })
  }

  // The other branch. `agent offline` was a wrong diagnosis here — the relay has no session for this
  // id, which says nothing about any agent's health — and `device:boot` already answered this pair
  // with these two strings before this change.
  it('says the session is not found, rather than blaming an agent, for an unknown session', async () => {
    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)

    browser.send(JSON.stringify({
      type: 'input:touch:end', sessionId: 'no-such-session', requestId: 'rq-unknown', payload: { x: 0.5, y: 0.5 },
    }))
    const err = await waitForType(browser, 'input:error')
    expect(err.sessionId).toBe('no-such-session')
    expect(err.reason).toBe('channel-unavailable')
    expect(err.message).toBe('Session not found')
    expect(err.message).not.toBe('agent offline')

    browser.close()
  })

  // The reason is deliberately the same for both branches: the set is derived from what a consumer
  // must do differently, and a reconnect or re-join answers both. Pinning the equality keeps a future
  // change from splitting the wire vocabulary when only the wording needed to differ.
  it('uses one reason for both branches while the wording differs', async () => {
    const { browser, sessionId } = await agentGone()

    browser.send(JSON.stringify({ type: 'input:touch:end', sessionId, requestId: 'rq-held', payload: { x: 0.5, y: 0.5 } }))
    const held = await waitForType(browser, 'input:error')

    browser.send(JSON.stringify({ type: 'input:touch:end', sessionId: 'nope', requestId: 'rq-nope', payload: { x: 0.5, y: 0.5 } }))
    const unknown = await waitForType(browser, 'input:error')

    // Named, not merely equal: two absent reasons are also equal, and that is the state this whole
    // change exists to end.
    expect(held.reason).toBe('channel-unavailable')
    expect(held.reason).toBe(unknown.reason)
    expect(held.message).not.toBe(unknown.message)

    browser.close()
  })

  // ── the door, and who is allowed through it (L5c) ─────────────────────────────────────────────
  //
  // These were the mutation-round survivors: with the correlator gate deleted and again with the ownership
  // check deleted, all 600 relay tests passed. Nothing here had ever sent an id-less acked input, and
  // nothing had ever sent input from a socket that did not hold the session — so the two guards that make
  // this layer mean anything were held by their own absence of counterexamples.

  /** Opens a second browser socket that has **not** joined `sessionId`. */
  async function outsider() {
    const ws = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(ws)
    return ws
  }

  /** A joined browser, a live agent, and the session they share. */
  async function live() {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register',
      devices: [{ id: 'dev-1', name: 'iPhone', platform: 'ios', status: 'booted' }],
    }))
    const reg = await waitForType<RelayMessage>(agent, 'agent:registered')
    const sessionId = reg.registeredSessions![0]!.sessionId
    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    return { agent, browser, sessionId }
  }

  for (const bad of [undefined, ''] as Array<string | undefined>) {
    it(`drops an acked input whose correlator is ${bad === undefined ? 'absent' : 'the empty string'}`, async () => {
      // Both halves of the shared predicate. A gate written as `!== undefined` lets `''` through, and
      // `mcp-server`'s tool schemas are bare `z.string()` so a model can produce it.
      const { agent, browser, sessionId } = await live()

      browser.send(JSON.stringify({
        type: 'input:touch:end', sessionId, ...(bad === undefined ? {} : { requestId: bad }),
        payload: { x: 0.5, y: 0.5 },
      }))
      await barrier(browser)
      await barrier(agent)

      // Not forwarded, and not answered either: answering would ship a reply whose required correlator
      // `JSON.stringify` erases, which every correlating consumer then discards.
      expect(await waitForTypeOrNull(agent, 'input:touch:end', 0)).toBeNull()
      expect(await waitForTypeOrNull(browser, 'input:error', 0)).toBeNull()

      agent.close(); browser.close()
    })
  }

  it('forwards an acked input from the socket that holds the session', async () => {
    // The control for the two below: the ownership check must not refuse the normal path.
    const { agent, browser, sessionId } = await live()

    const fwd = waitForType<RelayMessage>(agent, 'input:touch:end')
    browser.send(JSON.stringify({
      type: 'input:touch:end', sessionId, requestId: 'rq-own', payload: { x: 0.5, y: 0.5 },
    }))
    expect((await fwd).requestId).toBe('rq-own')

    agent.close(); browser.close()
  })

  it('refuses an acked input from a socket that does not hold the session', async () => {
    // `session:start` is exclusive, so a second socket cannot *join* — but until L5c it could still drive
    // the device, because the input branch resolved the session and forwarded without asking who was
    // asking. `clipboard:data` asks the mirror question one branch up. The agent's ack went to the session
    // holder, never to the injector, so the tester watching the screen saw input they did not send.
    const { agent, browser, sessionId } = await live()
    const other = await outsider()

    other.send(JSON.stringify({
      type: 'input:touch:end', sessionId, requestId: 'rq-inject', payload: { x: 0.5, y: 0.5 },
    }))
    const err = await waitForType<RelayMessage>(other, 'input:error')

    expect(err.reason).toBe('not-session-owner')
    expect(err.requestId).toBe('rq-inject')
    // **Answered, not dropped**, and that is the point rather than a nicety: `awaitInputAck` reports
    // silence from a session that has never acked as *success*, so a silent refusal would report an input
    // that never left the relay as landed — worse than the misrouting it replaced.
    await barrier(other)
    await barrier(agent)
    expect(await waitForTypeOrNull(agent, 'input:touch:end', 0)).toBeNull()

    agent.close(); browser.close(); other.close()
  })

  it('refuses input for a session nobody holds, and says which of the two it is', async () => {
    // `ownsSession` is `browserSocket === ws`, so an **unheld** session is refused too — and every other
    // outsider case here runs against a held one, so relaxing the check to `session?.browserSocket &&`
    // survived all 607 tests in review. That relaxation is a "nobody is holding it, so anybody may drive
    // it" policy for precisely the window the check exists to close, and `session:leave` is forwarded with
    // no ownership check of its own, so an outsider can *create* the unheld state and then use it.
    //
    // One reason, two prose strings — the treatment #492 settled for `agent offline` / `Session not found`.
    // Telling a caller the session is in use when it is idle steers it off a device it could have had.
    const { agent, browser, sessionId } = await live()
    browser.send(JSON.stringify({ type: 'session:leave', sessionId }))
    await barrier(browser)

    const other = await outsider()
    other.send(JSON.stringify({
      type: 'input:touch:end', sessionId, requestId: 'rq-unheld', payload: { x: 0.5, y: 0.5 },
    }))
    const err = await waitForType<RelayMessage>(other, 'input:error')

    expect(err.reason).toBe('not-session-owner')
    expect(err.message).toBe('session not joined')
    await barrier(agent)
    expect(await waitForTypeOrNull(agent, 'input:touch:end', 0)).toBeNull()

    agent.close(); browser.close(); other.close()
  })

  it('names the held case differently from the unheld one', async () => {
    const { agent, browser, sessionId } = await live()
    const other = await outsider()

    other.send(JSON.stringify({
      type: 'input:key', sessionId, requestId: 'rq-held-prose', payload: { code: 'KeyA' },
    }))
    const err = await waitForType<RelayMessage>(other, 'input:error')

    expect(err.reason).toBe('not-session-owner')
    expect(err.message).toBe('session held by another client')

    agent.close(); browser.close(); other.close()
  })

  it('refuses an outsider input:type in the shape its waiters read', async () => {
    const { agent, browser, sessionId } = await live()
    const other = await outsider()

    other.send(JSON.stringify({ type: 'input:type', sessionId, requestId: 'rq-t', payload: { text: 'hi' } }))
    const err = await waitForType<RelayMessage>(other, 'input:type-error')

    expect(err.requestId).toBe('rq-t')
    // The reason rides this shape too. Without it, `not-session-owner` was unreachable for one of the five
    // requests the relay can refuse — the only reason that promises nothing reached the device, delivered as
    // a string the caller would have to branch on (#492). `InputTypeError` gained `reason?` for this.
    expect(err.reason).toBe('not-session-owner')
    expect(await waitForTypeOrNull(other, 'input:error', 100)).toBeNull()

    agent.close(); browser.close(); other.close()
  })

  it('drops an outsider frame that no ack answers, without inventing a reply', async () => {
    // The asymmetry the split clause exists for: refusing means answering, and a move frame has no waiter
    // to answer. `clipboard:data`'s silent break is the precedent that fits here and not above.
    const { agent, browser, sessionId } = await live()
    const other = await outsider()

    other.send(JSON.stringify({ type: 'input:touch:move', sessionId, payload: { x: 0.5, y: 0.5 } }))
    await barrier(other)
    await barrier(agent)

    expect(await waitForTypeOrNull(agent, 'input:touch:move', 0)).toBeNull()
    expect(await waitForTypeOrNull(other, 'input:error', 0)).toBeNull()

    agent.close(); browser.close(); other.close()
  })

  // ── the same gate on every other browser→agent command (L5c, widened) ─────────────────────────
  //
  // Input was one branch of ten. Review found the rest still forwarding on the strength of the session
  // existing — `clipboard:write` pastes attacker text into the victim's device and `clipboard:read` with
  // `press: 'cut'` presses cut on it, with the reply landing on **that** tester's host OS clipboard;
  // `session:end` deletes their session. Each is refused in the shape its own waiter reads, and the two
  // session commands are dropped because neither has one.
  //
  // Table-driven so a command added later is a visible omission rather than an invisible one.
  const gated: Array<[string, Record<string, unknown>, string]> = [
    ['device:boot', { payload: { deviceId: 'dev-1' } }, 'device:boot-error'],
    ['open-url', { payload: { url: 'x://y' } }, 'open-url:error'],
    ['app:clear-state', { payload: { bundleId: 'com.example' } }, 'app:clear-state-error'],
    ['clipboard:read', { payload: { press: 'copy' } }, 'clipboard:error'],
    ['clipboard:write', { payload: { text: 'stolen', pasteAfter: true } }, 'clipboard:error'],
  ]

  for (const [type, extra, errType] of gated) {
    it(`refuses ${type} from a socket that does not hold the session`, async () => {
      const { agent, browser, sessionId } = await live()
      const other = await outsider()

      other.send(JSON.stringify({ type, sessionId, requestId: `rq-${type}`, ...extra }))
      const err = await waitForType<RelayMessage>(other, errType)

      expect(err.message).toBe('session held by another client')
      // The correlator rides the refusal, or the caller cannot attribute it and waits out its deadline —
      // the defect this file's sibling tests record as having shipped twice.
      expect(err.requestId).toBe(`rq-${type}`)

      await barrier(other)
      await barrier(agent)
      expect(await waitForTypeOrNull(agent, type, 0)).toBeNull()

      agent.close(); browser.close(); other.close()
    })
  }

  it('refuses app:install from a non-owner before it reads the build', async () => {
    // Ownership is checked ahead of the build lookup but **after** the session lookup, deliberately: the
    // resolver used by the cases above also decides agent liveness, and using it here would move
    // `agent offline` ahead of `Build not found`, changing which of two simultaneous problems is reported.
    const { agent, browser, sessionId } = await live()
    const other = await outsider()

    other.send(JSON.stringify({ type: 'app:install', sessionId, requestId: 'rq-inst', buildId: 999999 }))
    const err = await waitForType<RelayMessage>(other, 'app:install-error')

    // Not `Build not found`, which is what an owner would get for this buildId.
    expect(err.message).toBe('session held by another client')
    expect(err.requestId).toBe('rq-inst')

    agent.close(); browser.close(); other.close()
  })

  it('ignores session:leave and session:end from a non-owner, and answers nothing', async () => {
    // Dropped rather than refused: neither has a reply, so there is no waiter to tell — the same asymmetry
    // as the input frames nothing acks. `session:leave` is the sharper of the two, because it nulls
    // `browserSocket`: an unguarded one strips ownership from a mounted viewer, and that viewer's own input
    // is then refused. That is why `not-session-owner` needed real copy in the dashboard.
    const { agent, browser, sessionId } = await live()
    const other = await outsider()

    other.send(JSON.stringify({ type: 'session:leave', sessionId }))
    other.send(JSON.stringify({ type: 'session:end', sessionId }))
    await barrier(other)

    // Nothing answered, and the session still works for the socket that holds it.
    expect(await waitForTypeOrNull<RelayMessage>(other, 'error', 0)).toBeNull()
    const fwd = waitForType<RelayMessage>(agent, 'input:touch:end')
    browser.send(JSON.stringify({
      type: 'input:touch:end', sessionId, requestId: 'rq-survived', payload: { x: 0.5, y: 0.5 },
    }))
    expect((await fwd).requestId).toBe('rq-survived')

    agent.close(); browser.close(); other.close()
  })

  it('lets the holder leave its own session', async () => {
    // The control: the gate must not break the ordinary path, and `session:leave` has no reply to confirm
    // with — so this reads the effect instead. After leaving, the holder no longer owns it, so its next
    // input is refused, which is the observable consequence of the leave having worked.
    const { agent, browser, sessionId } = await live()

    browser.send(JSON.stringify({ type: 'session:leave', sessionId }))
    await barrier(browser)
    browser.send(JSON.stringify({
      type: 'input:touch:end', sessionId, requestId: 'rq-after-leave', payload: { x: 0.5, y: 0.5 },
    }))
    const err = await waitForType<RelayMessage>(browser, 'input:error')
    expect(err.message).toBe('session not joined')

    agent.close(); browser.close()
  })

  // Every input type that is still answered by nothing. Listed rather than sampled, because the ways of
  // widening the set are harmful in different ways and testing one representative catches neither:
  // answering `input:touch:start` would answer twice per tap, and answering any of these at all would put
  // a reply on a frame with no waiter.
  //
  // **`input:type` left this list in L5c.** The comment that used to stand here said adding it to
  // `TERMINAL_INPUT_TYPES` would be useless, because its waiters key on the `input:type-*` pair and would
  // ignore an `input:error` and burn the full deadline anyway — and it named the honest fix, a reply in the
  // shape those waiters read. That is what landed, so the case below asserts it rather than its absence.
  const nonTerminals: Array<[string, Record<string, unknown>]> = [
    ['input:touch:start', { x: 0.5, y: 0.5 }],
    ['input:touch:move', { x: 0.5, y: 0.5 }],
    ['input:pinch:start', { f0: { x: 0.4, y: 0.4 }, f1: { x: 0.6, y: 0.6 } }],
    ['input:pinch:move', { f0: { x: 0.4, y: 0.4 }, f1: { x: 0.6, y: 0.6 } }],
    ['input:rotate', { orientation: 'landscapeLeft' }],
    ['input:keyboard:toggle', {}],
  ]

  it('answers input:type in the shape its waiters read, not with input:error', async () => {
    const { browser, sessionId } = await agentGone()

    browser.send(JSON.stringify({ type: 'input:type', sessionId, requestId: 'rq-type', payload: { text: 'hi' } }))
    const err = await waitForType(browser, 'input:type-error')

    expect(err.sessionId).toBe(sessionId)
    expect(err.requestId).toBe('rq-type')
    expect(err.message).toBe('agent offline')
    // And **not** an `input:error`: that is the frame its waiters ignore, so sending one would be the
    // deadline-burning non-answer this reply replaced.
    expect(await waitForTypeOrNull(browser, 'input:error', 100)).toBeNull()

    browser.close()
  })

  for (const [type, payload] of nonTerminals) {
    it(`still answers nothing for ${type}`, async () => {
      const { browser, sessionId } = await agentGone()

      browser.send(JSON.stringify({ type, sessionId, payload }))
      expect(await waitForTypeOrNull(browser, 'input:error', 100)).toBeNull()

      browser.close()
    })
  }
})
