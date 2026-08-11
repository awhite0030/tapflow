import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
        ws.send(JSON.stringify(inputAck === 'error'
          ? { type: 'input:error', sessionId: msg['sessionId'], message: 'device not booted' }
          : inputAck === 'error-with-reason'
          ? { type: 'input:error', sessionId: msg['sessionId'], message: 'the input channel is still starting — retry in a moment', reason: 'channel-starting' }
          : { type: 'input:done', sessionId: msg['sessionId'] }))
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

    it('throws on session busy error', async () => {
      setTimeout(() => relay.send({ type: 'error', message: 'Session busy' }), 10)
      await expect(client.connectDevice('sess-1')).rejects.toThrow('Session busy')
    })

    it('throws on session not found error', async () => {
      setTimeout(() => relay.send({ type: 'error', message: 'Session not found' }), 10)
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
      relay.send({ type: 'input:done', sessionId: 'sess-1' })           // the late ack, no waiter armed
      await new Promise((r) => setTimeout(r, 20))
      await expect(client.tap('sess-1', 3, 4)).rejects.toThrow(/could not confirm/i)
      // Two serial 2s windows plus a handshake; vitest's unconfigured default is 5s, which this would
      // otherwise sit at 80% of and flake on a loaded runner.
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
    it('sends input:type and resolves on input:type-done', async () => {
      setTimeout(() => relay.send({ type: 'input:type-done', sessionId: 'sess-1' }), 10)
      await expect(client.typeText('sess-1', 'hello')).resolves.toBeUndefined()
      expect(await waitForMessage(relay, 'input:type')).toMatchObject({ type: 'input:type', sessionId: 'sess-1', payload: { text: 'hello' } })
    })

    it('throws on input:type-error', async () => {
      setTimeout(() => relay.send({ type: 'input:type-error', sessionId: 'sess-1', message: 'No booted device' }), 10)
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
