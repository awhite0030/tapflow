import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { TapflowClient, REASON_ADVICE, reasonAdvice } from '../client.js'

// inputAck models the agent's terminal-input ack: 'done' = new agent (booted), 'error' = rejects with prose only, 'error-with-reason' = rejects with the machine-readable reason too, 'none' = older agent that never acks (degradation).
function createMockRelay(): {
  wss: WebSocketServer
  port: number
  lastClient: () => WebSocket
  send: (msg: Record<string, unknown>) => void
  setInputAck: (mode: 'done' | 'error' | 'error-with-reason' | 'none') => void
  sentMessages: () => Record<string, unknown>[]
  close: () => Promise<void>
} {
  const wss = new WebSocketServer({ port: 0 })
  const received: Record<string, unknown>[] = []
  let conn: WebSocket | null = null
  let inputAck: 'done' | 'error' | 'error-with-reason' | 'none' = 'done'
  const TERMINAL = new Set(['input:touch:end', 'input:key', 'input:button'])

  wss.on('connection', (ws) => {
    conn = ws
    ws.on('message', (data) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) as Record<string, unknown> } catch { return }
      received.push(msg)
      if (inputAck !== 'none' && TERMINAL.has(msg['type'] as string)) {
        // Echoes `requestId`, because an agent must (L5c). Read back off the request rather than invented:
        // a made-up id would only prove the waiter rejects made-up ids, which is a different claim.
        const requestId = msg['requestId']
        ws.send(JSON.stringify(inputAck === 'error'
          ? { type: 'input:error', sessionId: msg['sessionId'], requestId, message: 'device not booted' }
          : inputAck === 'error-with-reason'
          ? { type: 'input:error', sessionId: msg['sessionId'], requestId, message: 'the input channel is still starting — retry in a moment', reason: 'channel-starting' }
          : { type: 'input:done', sessionId: msg['sessionId'], requestId }))
      }
    })
  })

  const port = (wss.address() as { port: number }).port

  return {
    wss,
    port,
    lastClient: () => conn!,
    send: (msg) => conn?.send(JSON.stringify(msg)),
    setInputAck: (mode) => { inputAck = mode },
    sentMessages: () => received,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  }
}

function waitForMessage(relay: ReturnType<typeof createMockRelay>, type: string, timeoutMs = 2000) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const check = setInterval(() => {
      const found = relay.sentMessages().find((m) => m['type'] === type)
      if (found) { clearInterval(check); clearTimeout(timer); resolve(found) }
    }, 10)
    const timer = setTimeout(() => {
      clearInterval(check)
      reject(new Error(`waitForMessage: timed out waiting for type "${type}"`))
    }, timeoutMs)
  })
}

/** Answers the next request of `type` with `reply`, carrying back the correlator the client minted.
 *
 *  A timer that fires before the request arrives cannot do this: the id is chosen by the client, so the
 *  fake has to observe the request and echo. That is the point of the correlator, and a fixture that made
 *  one up would be testing that the client rejects it. */
function echoReply(relay: { lastClient: () => WebSocket }, type: string, reply: Record<string, unknown>): void {
  const ws = relay.lastClient()
  const onMessage = (data: unknown) => {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(String(data)) as Record<string, unknown> } catch { return }
    if (msg['type'] !== type) return
    ws.off('message', onMessage)
    ws.send(JSON.stringify({ ...reply, requestId: msg['requestId'] }))
  }
  ws.on('message', onMessage)
}

describe('TapflowClient', () => {
  let relay: ReturnType<typeof createMockRelay>
  let client: TapflowClient

  beforeEach(async () => {
    relay = createMockRelay()
    client = new TapflowClient(`ws://localhost:${relay.port}`, 'tflw_pat_test')
    await client.connect()
  })

  afterEach(async () => {
    client.disconnect()
    await relay.close()
  })

  describe('listDevices', () => {
    it('sends agents:list and returns sessions from agents:listed', async () => {
      const sessions = [{ agentName: 'MyMac', devices: [{ id: 'dev-1', name: 'iPhone', sessionId: 'sess-1', platform: 'ios', status: 'shutdown', busy: false }] }]
      setTimeout(() => relay.send({ type: 'agents:listed', sessions }), 10)

      const [result, msg] = await Promise.all([
        client.listDevices(),
        waitForMessage(relay, 'agents:list'),
      ])

      expect(result).toEqual(sessions)
      expect(msg).toMatchObject({ type: 'agents:list' })
    })

    it('returns empty array when sessions is missing', async () => {
      setTimeout(() => relay.send({ type: 'agents:listed' }), 10)
      const result = await client.listDevices()
      expect(result).toEqual([])
    })
  })

  describe('connectDevice', () => {
    it('sends session:start and resolves on session:joined', async () => {
      setTimeout(() => relay.send({ type: 'session:joined', sessionId: 'sess-1' }), 10)
      const [, msg] = await Promise.all([
        client.connectDevice('sess-1'),
        waitForMessage(relay, 'session:start'),
      ])
      expect(msg).toMatchObject({ type: 'session:start', sessionId: 'sess-1' })
    })

    // These two send an **addressed** refusal, as the relay does since L5d. The fake relay's `send` takes
    // `Record<string, unknown>`, so nothing typed them and they carried neither `sessionId` nor the required
    // `reason` — they passed only because the waiter had a `sessionId === undefined` escape. Removing that
    // escape is what closes #512's first finding, and it is what would have turned these two red with no
    // compile error to point at them.
    it('throws on session busy error', async () => {
      setTimeout(() => relay.send({ type: 'error', sessionId: 'sess-1', message: 'Session busy', reason: 'session-busy' }), 10)
      await expect(client.connectDevice('sess-1')).rejects.toThrow('Session busy')
    })

    it('does not resolve one join with another session\'s refusal', async () => {
      // **#512 finding 1.** Before L5d `error` carried no address, so the waiter's `sessionId === undefined`
      // half was always true and any refusal resolved any pending join. Two joins in flight and the first
      // refusal woke the wrong one — reported as a failure that session never had — while the one that was
      // actually refused waited out its deadline, because `dispatch` resolves only the first match.
      const other = client.connectDevice('sess-OTHER')
      relay.send({ type: 'error', sessionId: 'sess-1', message: 'Session busy', reason: 'session-busy' })

      expect(await Promise.race([
        other.then(() => 'resolved').catch(() => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
      ])).toBe('still-waiting')
      other.catch(() => { /* times out on its own deadline */ })
    }, 15_000)

    it('is not resolved by an unaddressed refusal, and logs the skew once', async () => {
      // The `sessionId === undefined` escape only fires for a refusal carrying **no** address, so the
      // foreign-address test above does not exercise it — a mutation putting the escape back left all 80
      // tests passing. This is the case that holds it, and the same one that holds the skew log.
      //
      // A relay older than L5d sends unaddressed refusals. They match nothing now, so the join runs to its
      // deadline instead of throwing `'Session busy'` — advice the caller could have acted on. Taken
      // deliberately over a fallback, and logged once per socket because nothing else announces a relay's
      // version and the join's own timeout says nothing about why.
      const logged: string[] = []
      const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logged.push(String(m)) })
      try {
        const pending = client.connectDevice('sess-1')
        relay.send({ type: 'error', message: 'Session busy', reason: 'session-busy' })   // no sessionId
        await new Promise((r) => setTimeout(r, 20))
        relay.send({ type: 'error', message: 'Session busy', reason: 'session-busy' })   // and again
        await new Promise((r) => setTimeout(r, 20))

        expect(await Promise.race([
          pending.then(() => 'resolved').catch(() => 'rejected'),
          new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
        ])).toBe('still-waiting')
        pending.catch(() => { /* times out on its own deadline */ })
      } finally { spy.mockRestore() }
      // Once, not twice: an old relay refuses every join this way, and a line per refusal would bury it.
      expect(logged.filter((l) => l.includes('predates addressed errors'))).toHaveLength(1)
    }, 15_000)

    it('throws on session not found error', async () => {
      setTimeout(() => relay.send({ type: 'error', sessionId: 'sess-1', message: 'Session not found', reason: 'session-not-found' }), 10)
      await expect(client.connectDevice('sess-1')).rejects.toThrow('Session not found')
    })
  })

  describe('disconnectDevice', () => {
    it('sends session:leave', async () => {
      client.disconnectDevice('sess-1')
      const msg = await waitForMessage(relay, 'session:leave')
      expect(msg).toMatchObject({ type: 'session:leave', sessionId: 'sess-1' })
    })
  })

  describe('bootDevice', () => {
    it('sends device:boot and resolves on device:ready', async () => {
      setTimeout(() => relay.send({ type: 'device:ready', sessionId: 'sess-1' }), 10)
      await expect(client.bootDevice('sess-1', 'dev-1')).resolves.toBeUndefined()
      // Await outbound device:boot arrival; device:ready resolving doesn't guarantee it was recorded (CI race).
      const bootMsg = await waitForMessage(relay, 'device:boot')
      expect(bootMsg).toMatchObject({
        type: 'device:boot',
        sessionId: 'sess-1',
        payload: { deviceId: 'dev-1' },
      })
    })

    it('throws on device:boot-error', async () => {
      setTimeout(() => relay.send({ type: 'device:boot-error', sessionId: 'sess-1', message: 'Boot failed' }), 10)
      await expect(client.bootDevice('sess-1', 'dev-1')).rejects.toThrow('Boot failed')
    })

    it('ignores device:ready for a different sessionId and resolves on the correct one', async () => {
      setTimeout(() => {
        relay.send({ type: 'device:ready', sessionId: 'OTHER' })
        relay.send({ type: 'device:ready', sessionId: 'sess-1' })
      }, 10)
      await expect(client.bootDevice('sess-1', 'dev-1')).resolves.toBeUndefined()
    })
  })

  describe('shutdownDevice', () => {
    it('sends device:shutdown (with payload.deviceId) and resolves on device:shutdown-done', async () => {
      setTimeout(() => relay.send({ type: 'device:shutdown-done', sessionId: 'sess-1' }), 10)
      await expect(client.shutdownDevice('sess-1', 'dev-1')).resolves.toBeUndefined()
      const msg = await waitForMessage(relay, 'device:shutdown')
      // deviceId must be in the payload — the agent handler destructures msg.payload.deviceId.
      expect(msg).toMatchObject({ type: 'device:shutdown', sessionId: 'sess-1', payload: { deviceId: 'dev-1' } })
    })

    it('does not resolve on a different session\'s shutdown-done, only the matching one', async () => {
      const p = client.shutdownDevice('sess-1', 'dev-1')
      relay.send({ type: 'device:shutdown-done', sessionId: 'OTHER' })
      // A different session's completion must leave the promise pending.
      const outcome = await Promise.race([
        p.then(() => 'resolved'),
        new Promise<string>((r) => setTimeout(() => r('pending'), 40)),
      ])
      expect(outcome).toBe('pending')
      relay.send({ type: 'device:shutdown-done', sessionId: 'sess-1' })
      await expect(p).resolves.toBeUndefined()
    })
  })

  describe('tap', () => {
    it('sends touch:start then touch:end with coordinates', async () => {
      await client.tap('sess-1', 100, 200)
      const msgs = relay.sentMessages()
      expect(msgs[0]).toMatchObject({ type: 'input:touch:start', sessionId: 'sess-1', payload: { x: 100, y: 200 } })
      expect(msgs[1]).toMatchObject({ type: 'input:touch:end', sessionId: 'sess-1', payload: { x: 100, y: 200 } })
    })

    it('throws when the agent acks input:error (device not booted)', async () => {
      relay.setInputAck('error')
      await expect(client.tap('sess-1', 1, 2)).rejects.toThrow('device not booted')
    })

    // The reason is what lets a caller tell "retry in a moment" from "reconnect" from "never retry".
    // Acting on it is #457; carrying it is this change.
    it('includes the machine-readable reason when the agent sends one', async () => {
      relay.setInputAck('error-with-reason')
      await expect(client.tap('sess-1', 1, 2)).rejects.toThrow(/channel-starting/)
    })

    it('behaves exactly as before for an agent that sends no reason', async () => {
      // The field is optional so an older agent can omit it — absence must not change anything.
      relay.setInputAck('error')
      await expect(client.tap('sess-1', 1, 2)).rejects.toThrow('device not booted')
    })

    it('resolves optimistically when an older agent never acks (degradation)', async () => {
      relay.setInputAck('none')
      await expect(client.tap('sess-1', 1, 2)).resolves.toBeUndefined()
    })

    // The input is already on the wire by the time the ack is awaited — `tap` sends both frames first —
    // so a close means "could not confirm", not "was not dispatched". It used to say the latter.
    it('reports a drop mid-input as unconfirmed, not as undispatched', async () => {
      relay.setInputAck('none') // no ack will arrive
      const p = client.tap('sess-1', 1, 2)
      relay.lastClient().close() // drop the connection while awaiting the ack
      const err = await p.catch((e: Error) => e)
      expect(err.message).toMatch(/could not confirm/i)
      expect(err.message).toMatch(/may have landed/i)
      expect(err.message).toMatch(/do not repeat/i)
    })

    // And it does not depend on the ledger: a close is not evidence about whether the agent acks, so a
    // session that has never answered one still gets the truth rather than an optimistic success.
    it('reports a drop as unconfirmed even on a session that never acked', async () => {
      relay.setInputAck('none')
      const p = client.tap('sess-NEW', 1, 2)
      relay.lastClient().close()
      await expect(p).rejects.toThrow(/could not confirm/i)
    })
  })

  // #457. Silence used to be reported as success, so a tap that never reached the device was reported
  // as landed to a model that then moved on. Two decisions carry the fix, and both are tested here:
  // silence is answered with "could not confirm" rather than "dropped", and whether it is fatal at all
  // is decided by what this session has already done rather than by a negotiated flag.
  //
  // The silent paths each cost the real 2s ack window. Fake timers are not an option — these drive a
  // real WebSocket — so the count of them is kept deliberately small.
  describe('input ack truthfulness (#457)', () => {
    it('throws once a session has acked before and then goes silent', async () => {
      await client.tap('sess-1', 1, 2)          // acks: this agent demonstrably answers input
      relay.setInputAck('none')
      await expect(client.tap('sess-1', 3, 4)).rejects.toThrow(/could not confirm/i)
    })

    // "Dropped" would invite a retry, and `ackInput` awaits a device verify on the first input after a
    // boot or reconnect — so an ack past the window can belong to an input that did land. Repeating it
    // would duplicate it.
    it('says the input may have landed, and does not call it dropped', async () => {
      await client.tap('sess-1', 1, 2)
      relay.setInputAck('none')
      const err = await client.tap('sess-1', 3, 4).catch((e: Error) => e)
      expect(err.message).toMatch(/may have landed/i)
      expect(err.message).not.toMatch(/dropped/i)
      expect(err.message).toMatch(/do not repeat/i)
    })

    // Only `input:done` is the agent's word. The relay originates `input:error` to this same socket for
    // a terminal input it cannot dispatch, so counting errors would let one agent-offline blip mark a
    // session as acking when its agent may never have answered anything — and every later input would
    // then be reported as unconfirmed on evidence the agent did not produce.
    it('does not treat an input:error as evidence that the agent acks', async () => {
      relay.setInputAck('error')
      await expect(client.tap('sess-1', 1, 2)).rejects.toThrow('device not booted')
      relay.setInputAck('none')
      await expect(client.tap('sess-1', 3, 4)).resolves.toBeUndefined()
    })

    // The relay's own reply, verbatim: `agent offline` with `channel-unavailable`, which is what an
    // older agent's session looks like from here. It must not arm the gate against that agent.
    it('is not armed by the relay answering on an absent agent behalf', async () => {
      relay.setInputAck('none')
      relay.send({ type: 'input:error', sessionId: 'sess-1', message: 'agent offline', reason: 'channel-unavailable' })
      await new Promise((r) => setTimeout(r, 20))
      await expect(client.tap('sess-1', 1, 2)).resolves.toBeUndefined()
    })

    // The ledger is written where messages arrive, not where an ack is awaited — so an ack that missed
    // its own window still teaches us this agent acks. That case is the whole reason for the placement:
    // a ledger kept at the waiter would learn nothing from it.
    it('learns from an ack that arrives after its window expired', async () => {
      relay.setInputAck('none')
      await expect(client.tap('sess-1', 1, 2)).resolves.toBeUndefined() // optimistic, nothing acked
      // The late ack carries the id the first tap minted. Read back, not invented: the ledger records a
      // **correlated** done and only that, so an invented id would test the opposite of this test's subject.
      const sent = relay.sentMessages().filter((m) => m['type'] === 'input:touch:end').at(-1)
      relay.send({ type: 'input:done', sessionId: 'sess-1', requestId: sent!['requestId'] })
      await new Promise((r) => setTimeout(r, 20))
      await expect(client.tap('sess-1', 3, 4)).rejects.toThrow(/could not confirm/i)
      // Two serial 2s windows plus a handshake; vitest's unconfigured default is 5s, which this would
      // otherwise sit at 80% of and flake on a loaded runner.
    }, 15_000)

    it('is not satisfied by an ack carrying no correlator', async () => {
      // **The no-fallback rule, and nothing else held it**: adding `m['requestId'] === undefined ||` to the
      // waiter left all 77 tests passing in the mutation round. A fallback here would keep #499 exactly as
      // it is — an ack that missed its own deadline still matching the next input's waiter — which is the
      // one thing this layer exists to remove. The lifecycle pair (#521) has a fallback because its replies
      // have producers that answer no request; every producer of `input:done` answers a terminal input.
      const ws = relay.lastClient()
      relay.setInputAck('none')
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'input:touch:end') return
        ws.send(JSON.stringify({ type: 'input:done', sessionId: msg['sessionId'] })) // no requestId
      })
      // Resolves optimistically rather than on that ack — the session has never produced a matchable one,
      // so `strict` is false. What this pins is that the ack did not *satisfy the waiter*: with a fallback
      // it would, and the assertion below is what tells the two apart.
      await expect(client.tap('sess-1', 1, 2)).resolves.toBeUndefined()

      // Now make the session strict with a correlated ack, then send an uncorrelated one for the next tap.
      relay.setInputAck('done')
      await client.tap('sess-1', 3, 4)
      relay.setInputAck('none')
      await expect(client.tap('sess-1', 5, 6)).rejects.toThrow(/could not confirm/i)
    }, 15_000)

    it('does not learn from an uncorrelated late ack, and says why once', async () => {
      // An agent predating the correlator. Its acks can never match a waiter, so silence on this session is
      // **structural** rather than anomalous — recording it would make every later input report a failure
      // the agent never had a chance to avoid. The skew is logged instead, because nothing else in this
      // system announces an agent's version and dropping the signal silently returns the session to
      // optimistic reporting, which reads exactly like the defect #457 fixed.
      const logged: string[] = []
      const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logged.push(String(m)) })
      try {
        relay.setInputAck('none')
        await expect(client.tap('sess-1', 1, 2)).resolves.toBeUndefined()
        relay.send({ type: 'input:done', sessionId: 'sess-1' })   // no requestId: an old agent
        await new Promise((r) => setTimeout(r, 20))
        // Still optimistic, because the ledger did not record an ack it cannot match.
        await expect(client.tap('sess-1', 3, 4)).resolves.toBeUndefined()
        relay.send({ type: 'input:done', sessionId: 'sess-1' })
        await new Promise((r) => setTimeout(r, 20))
      } finally { spy.mockRestore() }
      // Once per session, not once per ack: an old agent answers every input this way, and a line per tap
      // would bury the one thing the operator needs to read.
      expect(logged.filter((l) => l.includes('predates input correlation'))).toHaveLength(1)
    }, 15_000)

    // A per-session ledger, not a per-client one: one session's agent acking says nothing about
    // another's. If it were global this would throw.
    it('does not let one session make another strict', async () => {
      await client.tap('sess-1', 1, 2)
      relay.setInputAck('none')
      await expect(client.tap('sess-OTHER', 3, 4)).resolves.toBeUndefined()
    })

    // Regression guard for a discarded design. The first plan retried some reasons inside this client;
    // the design review found that unsafe, because `no-gesture` can mean either "nothing landed" or
    // "the opening frames landed and only the last was refused" and the wire cannot tell them apart.
    // Retrying is the caller's decision, so the client must never re-send on its own.
    it('never re-sends an input on any reason', async () => {
      relay.setInputAck('error-with-reason')
      await expect(client.tap('sess-1', 1, 2)).rejects.toThrow()
      const ends = relay.sentMessages().filter((m) => m['type'] === 'input:touch:end')
      expect(ends).toHaveLength(1)
    })

    it('carries the advice for the reason into the thrown message', async () => {
      relay.setInputAck('error-with-reason') // channel-starting
      await expect(client.tap('sess-1', 1, 2)).rejects.toThrow(REASON_ADVICE['channel-starting'])
    })
  })

  describe('swipe', () => {
    it('sends touch:start, multiple touch:move, and touch:end', async () => {
      await client.swipe('sess-1', 0, 0, 100, 100, 80)
      await waitForMessage(relay, 'input:touch:end')
      const msgs = relay.sentMessages()
      expect(msgs[0]).toMatchObject({ type: 'input:touch:start', payload: { x: 0, y: 0 } })
      expect(msgs[msgs.length - 1]).toMatchObject({ type: 'input:touch:end', payload: { x: 100, y: 100 } })
      const moves = msgs.filter((m) => m['type'] === 'input:touch:move')
      expect(moves.length).toBe(7) // STEPS - 1
    })
  })

  describe('typeText', () => {
    // Answered off the request rather than on a timer, because the reply must now carry the id the client
    // minted and that id is only knowable once the request has arrived.
    const answerType = (reply: (m: Record<string, unknown>) => Record<string, unknown>) => {
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] === 'input:type') ws.send(JSON.stringify(reply(msg)))
      })
    }

    it('sends input:type and resolves on input:type-done', async () => {
      answerType((m) => ({ type: 'input:type-done', sessionId: 'sess-1', requestId: m['requestId'] }))
      await expect(client.typeText('sess-1', 'hello')).resolves.toBeUndefined()
      expect(await waitForMessage(relay, 'input:type')).toMatchObject({ type: 'input:type', sessionId: 'sess-1', payload: { text: 'hello' } })
    })

    it('does not take the previous typing\'s reply', async () => {
      // Both tests here answer with the id the client minted, so dropping `requestId` from the predicate
      // matched either way — the echo made the assertion vacuous, which review measured. A **stale** reply
      // is what tells the two apart, and it is #499's shape for `input:type` specifically: a late
      // `input:type-done` from the previous call landing in this one's waiter.
      // The stale reply is an **error** and the real one a success, so which of the two resolved the call is
      // observable. A first version sent two successes and asserted the request count — 1 either way, so it
      // passed with the correlator check deleted. Asserting a property needs the mutation that removes it to
      // fail, and counting requests was not that.
      answerType((m) => {
        const ws = relay.lastClient()
        setTimeout(() => ws.send(JSON.stringify({
          type: 'input:type-done', sessionId: 'sess-1', requestId: m['requestId'],
        })), 20)
        return { type: 'input:type-error', sessionId: 'sess-1', requestId: 'a-previous-call', message: 'stale' }
      })
      await expect(client.typeText('sess-1', 'hello')).resolves.toBeUndefined()
    }, 20_000)

    it('throws on input:type-error', async () => {
      answerType((m) => ({ type: 'input:type-error', sessionId: 'sess-1', requestId: m['requestId'], message: 'No booted device' }))
      await expect(client.typeText('sess-1', 'x')).rejects.toThrow('No booted device')
    })
  })

  describe('pressKey', () => {
    it('sends the agent contract { code, modifiers } — not { key }', async () => {
      await client.pressKey('sess-1', 'Enter')
      const msg = await waitForMessage(relay, 'input:key')
      expect(msg).toMatchObject({ type: 'input:key', sessionId: 'sess-1', payload: { code: 'Enter', modifiers: 0 } })
      expect((msg as { payload: Record<string, unknown> }).payload).not.toHaveProperty('key')
    })

    it('maps the Return alias to Enter (no platform maps "Return")', async () => {
      await client.pressKey('sess-1', 'Return')
      const msg = await waitForMessage(relay, 'input:key')
      expect(msg).toMatchObject({ payload: { code: 'Enter', modifiers: 0 } })
    })

    it('passes other KeyboardEvent.code names through unchanged', async () => {
      await client.pressKey('sess-1', 'Backspace')
      const msg = await waitForMessage(relay, 'input:key')
      expect(msg).toMatchObject({ payload: { code: 'Backspace', modifiers: 0 } })
    })
  })

  describe('pressButton', () => {
    it('sends the agent contract { name } — not { button }', async () => {
      await client.pressButton('sess-1', 'home')
      const msg = await waitForMessage(relay, 'input:button')
      expect(msg).toMatchObject({ type: 'input:button', sessionId: 'sess-1', payload: { name: 'home' } })
      expect((msg as { payload: Record<string, unknown> }).payload).not.toHaveProperty('button')
      expect((msg as { payload: Record<string, unknown> }).payload).not.toHaveProperty('phase')
    })
  })

  // Reverting all four predicates from `requestId` back to `sessionId` left this suite green, because the
  // fixtures echo the id and both fields then agree. These distinguish the two: a reply with the right
  // session and the wrong correlator must not resolve, which is only true if the client matches on the
  // correlator.
  describe('correlator matching', () => {
    it('does not resolve installApp on a reply for another request', async () => {
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'app:install') return
        ws.send(JSON.stringify({ type: 'app:install-done', sessionId: 'sess-1', requestId: 'someone-elses' }))
      })
      const pending = client.installApp('sess-1', 42)
      const settled = await Promise.race([
        pending.then(() => 'resolved').catch(() => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
      ])
      expect(settled).toBe('still-waiting')
    })

    it('does not resolve clearState on a reply for another request', async () => {
      // `clearState` had no test at all, which is why the plan's "seven fixtures to rewrite" became four.
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'app:clear-state') return
        ws.send(JSON.stringify({ type: 'app:clear-state-done', sessionId: 'sess-1', requestId: 'someone-elses' }))
      })
      const settled = await Promise.race([
        client.clearState('sess-1', 'com.example.app').then(() => 'resolved').catch(() => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
      ])
      expect(settled).toBe('still-waiting')
    })

    // ── L5b′: the lifecycle pair, whose correlator is optional ─────────────────────────────────
    //
    // Different from the four above: an absent `requestId` is **accepted** here, because
    // `device:ready` and `device:boot-error` have producers that answer no request — the relay replays
    // a cached ready to a re-joining viewer, and an Android stream that dies mid-session reports it as
    // a boot error. What the correlator buys is the rejection of a *mismatched* id.

    it('mints a correlator on device:boot', async () => {
      setTimeout(() => relay.send({ type: 'device:ready', sessionId: 'sess-1' }), 10)
      await client.bootDevice('sess-1', 'dev-1')
      const bootMsg = await waitForMessage(relay, 'device:boot')
      expect(typeof bootMsg['requestId']).toBe('string')
      expect(bootMsg['requestId']).not.toBe('')
    })

    it('does not resolve a boot on a ready carrying another request\'s correlator', async () => {
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'device:boot') return
        ws.send(JSON.stringify({ type: 'device:ready', sessionId: 'sess-1', requestId: 'someone-elses' }))
      })
      const settled = await Promise.race([
        client.bootDevice('sess-1', 'dev-1').then(() => 'resolved').catch(() => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
      ])
      expect(settled).toBe('still-waiting')
    })

    it('resolves a boot on the ready that answers it', async () => {
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'device:boot') return
        ws.send(JSON.stringify({ type: 'device:ready', sessionId: 'sess-1', requestId: msg['requestId'] }))
      })
      await expect(client.bootDevice('sess-1', 'dev-1')).resolves.toBeUndefined()
    })

    it('rejects a boot on the boot-error that answers it, and not on one that does not', async () => {
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'device:boot') return
        // A diagnosis for someone else's boot first. Accepting it would fail a boot that is still
        // perfectly capable of succeeding, which is the mirror image of the deadline defect.
        ws.send(JSON.stringify({ type: 'device:boot-error', sessionId: 'sess-1', requestId: 'not-mine', message: 'other' }))
        setTimeout(() => ws.send(JSON.stringify({
          type: 'device:boot-error', sessionId: 'sess-1', requestId: msg['requestId'], message: 'mine',
        })), 20)
      })
      await expect(client.bootDevice('sess-1', 'dev-1')).rejects.toThrow('mine')
    })

    it('accepts a ready with no correlator, and says so', async () => {
      // An agent predating the echo, and the relay's own replay. Dropping these would trade a
      // misattribution for a 30s hang, so the fallback stands — but silently falling back is how a
      // half-upgraded fleet stays invisible, so it is logged.
      const logged: string[] = []
      const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logged.push(String(m)) })
      try {
        setTimeout(() => relay.send({ type: 'device:ready', sessionId: 'sess-1' }), 10)
        await expect(client.bootDevice('sess-1', 'dev-1')).resolves.toBeUndefined()
      } finally { spy.mockRestore() }
      expect(logged.some((l) => l.includes('device:ready') && l.includes('no requestId'))).toBe(true)
    })

    it('is not satisfied by the relay\'s replay, which carries no sessionId at all', async () => {
      // The replay frame is `{ type, payload }`. It is cached state addressed to a **join**, not an
      // answer to a **boot**, and `readySent` is cleared by nothing while an agent is wedged-but-
      // connected — which is exactly when a boot hangs, so the value is stalest when it would be
      // consumed. What keeps it out is the `sessionId` comparison, not the correlator: an optional
      // field can make a frame match more precisely, never make it fail to match.
      //
      // Staged genuinely mid-boot, which matters. In the ordinary sequence this client registers its
      // boot waiter only after `session:start` resolves, and the relay sends its replays during that
      // join — so the replay is dropped before any waiter exists and a test that merely joins first
      // would pass with the comparison deleted.
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'device:boot') return
        ws.send(JSON.stringify({ type: 'device:ready', payload: { deviceId: 'dev-1' } }))
      })
      const settled = await Promise.race([
        client.bootDevice('sess-1', 'dev-1').then(() => 'resolved').catch(() => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
      ])
      expect(settled).toBe('still-waiting')
    })

    it('sends the one reply to the boot it answers, not to whichever waited first', async () => {
      // **The correlator\'s actual payoff on this pair, and it is not "both boots resolve".** A superseded
      // boot is answered by nothing at all — `bootSeq` makes every checkpoint in the agent return silently
      // — so one of two overlapping boots times out either way. What the correlator changes is which.
      // `dispatch` resolves the first waiter whose predicate matches and then stops, so on `sessionId` +
      // type alone that single reply went to the boot registered **first**, i.e. the superseded one, and
      // the boot that actually happened was reported as a failure.
      const ws = relay.lastClient()
      const ids: string[] = []
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'device:boot') return
        ids.push(msg['requestId'] as string)
        // Answer only the second, the way a real agent does once `bootSeq` has moved on.
        if (ids.length === 2) {
          ws.send(JSON.stringify({ type: 'device:ready', sessionId: 'sess-1', requestId: ids[1] }))
        }
      })

      const first = client.bootDevice('sess-1', 'dev-1')
      const second = client.bootDevice('sess-1', 'dev-1')

      await expect(second).resolves.toBeUndefined()
      expect(await Promise.race([
        first.then(() => 'resolved').catch(() => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
      ])).toBe('still-waiting')
      first.catch(() => { /* it times out on its own deadline; nothing here waits for that */ })
    })

    it('mints a correlator on device:shutdown', async () => {
      // `bootDevice` has this and `shutdownDevice` did not, and the two tests either side of it cannot
      // stand in: `toMatchObject` ignores a key that is absent, and the mismatch case below still passes
      // against a hardcoded foreign id even when nothing was sent. Leave the id off the wire and the agent
      // has nothing to echo, so `correlatesWith` falls back and resolves `shutdown_device` on *any*
      // shutdown-done for the session — the relay's idle timer or the dashboard's unmount teardown can
      // satisfy a shutdown that has not happened. It also logs "carried no requestId" on every call,
      // blaming the agent for the client's omission.
      setTimeout(() => relay.send({ type: 'device:shutdown-done', sessionId: 'sess-1' }), 10)
      await client.shutdownDevice('sess-1', 'dev-1')
      const msg = await waitForMessage(relay, 'device:shutdown')
      expect(typeof msg['requestId']).toBe('string')
      expect(msg['requestId']).not.toBe('')
    })

    it('does not resolve a shutdown on a done carrying another request\'s correlator', async () => {
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'device:shutdown') return
        ws.send(JSON.stringify({ type: 'device:shutdown-done', sessionId: 'sess-1', requestId: 'someone-elses' }))
      })
      const settled = await Promise.race([
        client.shutdownDevice('sess-1', 'dev-1').then(() => 'resolved').catch(() => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
      ])
      expect(settled).toBe('still-waiting')
    })

    it('resolves clearState on its own reply', async () => {
      const ws = relay.lastClient()
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'app:clear-state') return
        ws.send(JSON.stringify({ type: 'app:clear-state-done', sessionId: 'sess-1', requestId: msg['requestId'] }))
      })
      await expect(client.clearState('sess-1', 'com.example.app')).resolves.toBeUndefined()
    })
  })

  describe('installApp', () => {
    it('sends app:install and resolves on app:install-done', async () => {
      echoReply(relay, 'app:install', { type: 'app:install-done', sessionId: 'sess-1' })
      await expect(client.installApp('sess-1', 42)).resolves.toBeUndefined()
      // Await the outbound message's arrival (same ws race as bootDevice above).
      expect(await waitForMessage(relay, 'app:install')).toMatchObject({ type: 'app:install', sessionId: 'sess-1', buildId: 42 })
    })

    it('throws on app:install-error', async () => {
      echoReply(relay, 'app:install', { type: 'app:install-error', sessionId: 'sess-1', message: 'Build not found' })
      await expect(client.installApp('sess-1', 99)).rejects.toThrow('Build not found')
    })
  })

  describe('launchApp', () => {
    it('sends app:launch and resolves on app:launch-done', async () => {
      echoReply(relay, 'app:launch', { type: 'app:launch-done', sessionId: 'sess-1' })
      await expect(client.launchApp('sess-1', 42)).resolves.toBeUndefined()
    })

    it('throws on app:launch-error', async () => {
      echoReply(relay, 'app:launch', { type: 'app:launch-error', sessionId: 'sess-1', message: 'Bundle ID not available' })
      await expect(client.launchApp('sess-1', 99)).rejects.toThrow('Bundle ID not available')
    })
  })

  describe('screenshot', () => {
    it('calls REST endpoint with PAT and returns buffer', async () => {
      const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      const origFetch = globalThis.fetch

      globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toContain('/api/v1/sessions/sess-1/screenshot')
        expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tflw_pat_test')
        return new Response(fakePng, { status: 200, headers: { 'Content-Type': 'image/png' } })
      }

      try {
        const buf = await client.screenshot('sess-1')
        expect(buf).toEqual(fakePng)
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('uses jpeg format query param when requested', async () => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async (url: RequestInfo | URL) => {
        expect(String(url)).toContain('format=jpeg')
        return new Response(Buffer.from([0xff, 0xd8]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
      }
      try {
        await client.screenshot('sess-1', 'jpeg')
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('throws on 401', async () => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
      try {
        await expect(client.screenshot('sess-1')).rejects.toThrow('Unauthorized')
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('falls back to the response text when the error body is not JSON', async () => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async () =>
        new Response('Bad Gateway', { status: 502, headers: { 'Content-Type': 'text/plain' } })
      try {
        await expect(client.screenshot('sess-1')).rejects.toThrow('Bad Gateway')
      } finally {
        globalThis.fetch = origFetch
      }
    })
  })

  describe('queryUITree', () => {
    const ELEMENTS = [
      {
        role: 'button',
        label: 'Login',
        identifier: 'com.example.app:id/login',
        frame: { x: 0.25, y: 0.5, width: 0.5, height: 0.0625 },
        enabled: true,
        rawRole: 'android.widget.Button',
      },
    ]

    it('calls the ui-tree REST endpoint with PAT and returns elements', async () => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toContain('/api/v1/sessions/sess-1/ui-tree')
        expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tflw_pat_test')
        return new Response(JSON.stringify({ elements: ELEMENTS }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      try {
        const elements = await client.queryUITree('sess-1')
        expect(elements).toEqual(ELEMENTS)
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('falls back to the response text when the error body is not JSON', async () => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async () =>
        new Response('Bad Gateway', { status: 502, headers: { 'Content-Type': 'text/plain' } })
      try {
        await expect(client.queryUITree('sess-1')).rejects.toThrow('Bad Gateway')
      } finally {
        globalThis.fetch = origFetch
      }
    })

    it('surfaces the relay error body (e.g. 502 dump failure) as an exception', async () => {
      const origFetch = globalThis.fetch
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: 'uiautomator dump produced no XML within 10s' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        })
      try {
        await expect(client.queryUITree('sess-1')).rejects.toThrow('uiautomator dump produced no XML')
      } finally {
        globalThis.fetch = origFetch
      }
    })
  })

  describe('listBuilds', () => {
    it('unwraps { items }, maps uploaded_at→createdAt, and pages through total', async () => {
      const origFetch = globalThis.fetch
      // 3 builds across 2 pages (limit=100 requested; server splits for the test)
      const allBuilds = [
        { id: 7, app_id: 1, version_name: '1.0', build_number: '42', platform: 'ios', status_label: null, uploaded_at: '2026-07-01' },
        { id: 8, app_id: 1, version_name: '1.1', build_number: '43', platform: 'ios', status_label: 'Done', uploaded_at: '2026-07-02' },
        { id: 9, app_id: 1, version_name: '1.2', build_number: '44', platform: 'ios', status_label: null, uploaded_at: '2026-07-03' },
      ]
      globalThis.fetch = async (url: RequestInfo | URL) => {
        const u = new URL(String(url))
        if (u.pathname.endsWith('/apps')) {
          // real server column is bundle_id_key, not bundle_id
          return new Response(JSON.stringify({ items: [{ id: 1, name: 'TheApp', bundle_id_key: 'com.example', platform: 'ios' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        const page = Number(u.searchParams.get('page'))
        const items = page === 0 ? allBuilds.slice(0, 2) : allBuilds.slice(2)
        return new Response(JSON.stringify({ items, total: 3 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      try {
        const apps = await client.listBuilds()
        expect(apps).toHaveLength(1)
        expect(apps[0].bundleId).toBe('com.example') // from bundle_id_key, not undefined
        // all three builds returned (not just the first page)
        expect(apps[0].builds.map((b) => b.id)).toEqual([7, 8, 9])
        expect(apps[0].builds[0].createdAt).toBe('2026-07-01')
      } finally {
        globalThis.fetch = origFetch
      }
    })
  })

  describe('WebSocket lifecycle', () => {
    it('rejects pending waiters when WS closes', async () => {
      const promise = client.listDevices()
      relay.lastClient().close()
      await expect(promise).rejects.toThrow('WebSocket closed')
    })
  })
})

// The advice is what a language model acts on, so an entry that is missing, blank, or shared with a
// reason whose required action differs would send it the wrong way. `tsc` enforces that every reason
// has a key; none of the rest.
describe('REASON_ADVICE', () => {
  const reasons = Object.keys(REASON_ADVICE) as Array<keyof typeof REASON_ADVICE>

  it('gives every reason non-blank advice', () => {
    for (const r of reasons) expect(REASON_ADVICE[r].trim(), r).not.toBe('')
  })

  it('gives no two reasons the same advice', () => {
    const values = reasons.map((r) => REASON_ADVICE[r])
    expect(new Set(values).size).toBe(values.length)
  })

  // Absence means an agent older than the field, and an unfamiliar value means one newer than this
  // build. Both resolve to `channel-unavailable` — the protocol's conservative reading — rather than to
  // silence, which would be the dangerous direction.
  it.each([undefined, 'some-future-reason', 'toString'])('resolves %s to the channel-unavailable advice', (r) => {
    expect(reasonAdvice(r)).toBe(REASON_ADVICE['channel-unavailable'])
  })

  it('resolves a known reason to its own advice', () => {
    expect(reasonAdvice('no-gesture')).toBe(REASON_ADVICE['no-gesture'])
  })

  // The one reason whose advice must warn about duplication: it covers both "nothing landed" and
  // "part of the gesture already landed", and a caller that repeats it may duplicate what did.
  it('warns that no-gesture may already have applied part of the input', () => {
    expect(REASON_ADVICE['no-gesture']).toMatch(/duplicate|already/i)
  })

  // Uniqueness alone lets two bodies be swapped, which is how a "retry this" could end up on a reason
  // that must never be retried. These pin the *direction* of each one without freezing its wording —
  // wording stays a judgement call, per the same rule the dashboard's notices follow.
  it.each([
    ['channel-starting', /again/i],          // the only reason whose action is to repeat the input
    ['dispatch-failed', /do not repeat/i],   // stricter than the protocol table, on purpose
    ['unsupported', /do not retry/i],
    ['malformed', /bug/i],
    ['not-booted', /boot_device/],
    ['channel-unavailable', /reconnect/i],
  ] as const)('points %s in the right direction', (reason, expected) => {
    expect(REASON_ADVICE[reason]).toMatch(expected)
  })

  // And the two that must not be confusable: one says send it again, the other says never.
  it('does not tell the caller to repeat an input that may have doubled', () => {
    expect(REASON_ADVICE['dispatch-failed']).not.toMatch(/safe to send again|try it again/i)
  })
})
