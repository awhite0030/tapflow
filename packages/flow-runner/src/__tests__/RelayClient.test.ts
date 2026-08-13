import { describe, it, expect, afterEach, vi } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { RelayClient, SessionJoinError } from '../RelayClient.js'
import { TransientQueryError } from '../errors.js'

// Minimal Response stub for the ui-tree GET.
function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  } as unknown as Response
}

function client(): RelayClient {
  return new RelayClient('ws://localhost:4000', 'tok')
}

describe('RelayClient.queryUITree — transient vs permanent classification', () => {
  afterEach(() => vi.restoreAllMocks())

  it('200 → returns elements', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { elements: [{ role: 'button', label: 'x', frame: { x: 0, y: 0, width: 1, height: 1 }, enabled: true }] }))
    const els = await client().queryUITree('s1')
    expect(els).toHaveLength(1)
  })

  it.each([502, 504, 500, 503])('%d → TransientQueryError (retryable)', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(status, { error: 'transient' }))
    await expect(client().queryUITree('s1')).rejects.toBeInstanceOf(TransientQueryError)
  })

  it.each([400, 401, 403, 404, 409])('%d → NOT transient (fail-fast)', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(status, { error: 'nope' }))
    const err = await client().queryUITree('s1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(TransientQueryError)
  })

  it('network failure (fetch rejects) → TransientQueryError, preserving the original cause', async () => {
    const original = new Error('ECONNREFUSED')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(original)
    const err = await client().queryUITree('s1').catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(TransientQueryError)
    expect((err.cause as Error).cause).toBe(original) // original fetch error chained through the wrappers
  })

  it('a stalled request aborted by the signal → TransientQueryError (never hangs)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, opts) =>
      new Promise<Response>((_resolve, reject) => {
        (opts as RequestInit | undefined)?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')))
      }),
    )
    await expect(client().queryUITree('s1', AbortSignal.timeout(10))).rejects.toBeInstanceOf(TransientQueryError)
  })

  it('carries the server error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(502, { error: 'is the app running in the foreground?' }))
    await expect(client().queryUITree('s1')).rejects.toThrow('is the app running in the foreground?')
  })
})


// L5b′. `bootDevice` correlates by `requestId` when the reply carries one and by `sessionId` + type
// when it does not. Both halves are tested here rather than assumed from `mcp-server`, because
// `correlatesWith` is duplicated between the two clients — protocol cannot host it (its main entry has
// to erase under `import type`), so the one thing keeping the copies honest is that each has tests.
//
// Nothing else covers it: the correlator is optional, so `<Pair>ReplyBody` cannot exist for it and
// `correlatedRequestsGated` derives only required declarations.
// L5c. `tap`, `swipe` and `pressKey` await nothing, so the correlator they mint is the only thing standing
// between a flow and a silent no-op: the relay drops an acked input whose id is absent or `''`, without
// answering, and these three senders would never know. Review measured it — setting all three to `''` left
// all 63 tests passing, and a flow whose every tap, swipe and key press never left the relay reports **PASS**.
// The old code could not fail this way, because there was no id to get wrong.
//
// Read off the wire rather than asserted at the call site: what matters is what the relay would receive.
describe('RelayClient — the input senders mint a correlator and await the ack', () => {
  let wss: WebSocketServer | null = null

  afterEach(async () => {
    const s = wss
    wss = null
    if (!s) return
    for (const c of s.clients) c.terminate()
    await new Promise<void>((r) => s.close(() => r()))
  })

  // `ack` is what the agents and the relay do for every terminal input. A server that stays silent models an
  // agent older than the ack contract, which is not what these tests are about — the refusal tests below
  // pass their own reply instead.
  async function capture(ack: (msg: Record<string, unknown>) => Record<string, unknown> | null = (m) => ({
    type: 'input:done', sessionId: m['sessionId'], requestId: m['requestId'],
  })) {
    const received: Record<string, unknown>[] = []
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        received.push(msg)
        if (msg['type'] === 'session:start') {
          ws.send(JSON.stringify({ type: 'session:joined', sessionId: msg['sessionId'], capabilities: [] }))
        }
        // The five acked requests, per protocol/AGENTS.md — the four terminal frames and `input:type`.
        // Opening and move frames are silent by contract.
        if (msg['type'] === 'input:touch:end' || msg['type'] === 'input:key') {
          const reply = ack(msg)
          if (reply) ws.send(JSON.stringify(reply))
        }
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    await client.joinSession('s1')
    return { client, received }
  }

  const usable = (m: Record<string, unknown> | undefined, what: string) => {
    expect(m, `no ${what} was sent`).toBeDefined()
    expect(typeof m!['requestId']).toBe('string')
    expect(m!['requestId']).not.toBe('')
  }

  it('tap sends a terminal frame with a usable id, and an opening frame with none', async () => {
    const { client, received } = await capture()
    await client.tap('s1', 0.5, 0.5)

    usable(received.find((m) => m['type'] === 'input:touch:end'), 'input:touch:end')
    // And the opening frame carries none — nothing acks it, so an id there would name a waiter that does
    // not exist. Pinned so a later edit cannot quietly add one.
    expect(received.find((m) => m['type'] === 'input:touch:start')).not.toHaveProperty('requestId')
  })

  it('swipe sends a terminal frame with a usable id, and its moves with none', async () => {
    const { client, received } = await capture()
    await client.swipe('s1', [0.1, 0.1], [0.9, 0.9], 40)

    usable(received.find((m) => m['type'] === 'input:touch:end'), 'input:touch:end')
    const moves = received.filter((m) => m['type'] === 'input:touch:move')
    expect(moves.length).toBeGreaterThan(0)
    for (const m of moves) expect(m).not.toHaveProperty('requestId')
  })

  it('pressKey sends a usable id', async () => {
    const { client, received } = await capture()
    await client.pressKey('s1', 'Enter')

    usable(received.find((m) => m['type'] === 'input:key'), 'input:key')
  })

  it('a refused input fails the step, naming the reason (#512)', async () => {
    // The whole point of awaiting the ack. Without it the tap is refused, nothing notices, and the next
    // `assertVisible` polls until its own deadline and fails with "selector not found" — an infrastructure
    // failure written into the report as a product failure, which for a test runner is the worst place to
    // lose a cause.
    const { client } = await capture((m) => ({
      type: 'input:error',
      sessionId: m['sessionId'],
      requestId: m['requestId'],
      reason: 'not-booted',
      message: 'device is not booted',
    }))
    await expect(client.tap('s1', 0.5, 0.5)).rejects.toThrow(/tap was refused by the device \(not-booted\): device is not booted/)
  })

  it('reads an ack with no reason as channel-unavailable, not as fine', async () => {
    // `reason` is optional on the wire — an agent predating the field omits it — and absence means
    // *unknown*. protocol/AGENTS.md makes the conservative reading the contract, and the failure still has
    // to name something rather than an empty parenthesis.
    const { client } = await capture((m) => ({
      type: 'input:error', sessionId: m['sessionId'], requestId: m['requestId'], message: 'no channel',
    }))
    await expect(client.pressKey('s1', 'Enter'))
      .rejects.toThrow(/pressKey Enter was refused by the device \(channel-unavailable\): no channel/)
  })

  it('reports an unanswered input as unconfirmed, not as dropped, and says so once', async () => {
    // `IOSAgent.ackInput` awaits an untimed `simctl list` on the first input after a boot, on the same Mac
    // the relay gates at 80% CPU — so an ack that never reaches this waiter can still belong to an input
    // that landed. "tap timed out" reads as *the tap did not happen*, which is the false certainty this
    // change removes, sign flipped. And the run needs to hear that the agent may simply be too old to
    // correlate, since the step's own failure says neither.
    //
    // Driven by closing the socket rather than by waiting out `INPUT_ACK_TIMEOUT_MS`: both reject the same
    // waiter and take the same branch, and one of them costs 10 seconds per run of the suite.
    const logged: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logged.push(String(m)) })
    try {
      const { client } = await capture(() => null)
      const pending = client.tap('s1', 0.5, 0.5)
      for (const c of wss!.clients) c.terminate()
      const err = await pending.catch((e: unknown) => e) as Error
      expect(err.message).toContain('was not confirmed')
      expect(err.message).toContain('may have reached the device')
      expect(err.message).not.toContain('refused')
    } finally { spy.mockRestore() }
    expect(logged.filter((l) => l.includes('went unanswered'))).toHaveLength(1)
  })

  it('does not take another input\'s ack', async () => {
    // The correlator is the point, and it is why #499 exists: a gesture is dozens of frames and a late ack
    // from the previous input lands in this one's waiter. The stale reply is an **error** so resolving on it
    // is observable — two indistinguishable successes cannot fail this test.
    const { client } = await capture((m) => {
      const ws = [...wss!.clients][0]
      ws.send(JSON.stringify({
        type: 'input:error', sessionId: 's1', requestId: 'stale', reason: 'failed', message: 'a previous input',
      }))
      return { type: 'input:done', sessionId: m['sessionId'], requestId: m['requestId'] }
    })
    await expect(client.tap('s1', 0.5, 0.5)).resolves.toBeUndefined()
  })

  it('typeText correlates, so its waiter cannot take the previous typing\'s reply', async () => {
    // The one input sender here with a waiter. Dropping `requestId` from its predicate leaves #499 alive for
    // `input:type` specifically: a late `input:type-done` from the previous call lands in this one's waiter.
    const received: Record<string, unknown>[] = []
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        received.push(msg)
        if (msg['type'] === 'session:start') {
          ws.send(JSON.stringify({ type: 'session:joined', sessionId: msg['sessionId'], capabilities: [] }))
        }
        if (msg['type'] === 'input:type') {
          // The stale reply is an **error** so that resolving on it is observable. A first version sent two
          // successes, which passed with the correlator check deleted — the mutation that removes the
          // property has to fail the test, and two indistinguishable successes cannot do that.
          ws.send(JSON.stringify({
            type: 'input:type-error', sessionId: 's1', requestId: 'stale', message: 'a previous call',
          }))
          setTimeout(() => ws.send(JSON.stringify({
            type: 'input:type-done', sessionId: 's1', requestId: msg['requestId'],
          })), 20)
        }
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    await client.joinSession('s1')

    await expect(client.typeText('s1', 'hi')).resolves.toBeUndefined()
    usable(received.find((m) => m['type'] === 'input:type'), 'input:type')
  })
})

describe('RelayClient.bootDevice — an optional correlator, with a fallback', () => {
  let wss: WebSocketServer | null = null

  afterEach(async () => {
    const s = wss
    wss = null
    if (!s) return
    // `close()` waits for every connection to go away, and the client keeps its socket open — so
    // without terminating them first this hook times out rather than the test failing, which reads as
    // five broken tests instead of one broken teardown.
    for (const c of s.clients) c.terminate()
    await new Promise<void>((r) => s.close(() => r()))
  })

  /** A relay that answers `device:boot` however the test asks it to, and records what it received. */
  async function relay(reply: (msg: Record<string, unknown>) => Record<string, unknown> | null) {
    const received: Record<string, unknown>[] = []
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        received.push(msg)
        if (msg['type'] === 'session:start') {
          ws.send(JSON.stringify({ type: 'session:joined', sessionId: msg['sessionId'], capabilities: [] }))
          return
        }
        if (msg['type'] !== 'device:boot') return
        const answer = reply(msg)
        if (answer) ws.send(JSON.stringify(answer))
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    await client.joinSession('s1')
    return { client, received }
  }

  const pendingAfter = (p: Promise<unknown>, ms = 150) =>
    Promise.race([
      p.then(() => 'resolved').catch(() => 'rejected'),
      new Promise<string>((r) => setTimeout(() => r('still-waiting'), ms)),
    ])

  it('mints a correlator on the boot it sends', async () => {
    const { client, received } = await relay((m) => ({
      type: 'device:ready', sessionId: 's1', requestId: m['requestId'], payload: { deviceId: 'dev-1' },
    }))
    await client.bootDevice('s1', 'dev-1')

    const boot = received.find((m) => m['type'] === 'device:boot')!
    expect(typeof boot['requestId']).toBe('string')
    expect(boot['requestId']).not.toBe('')
  })

  it('is not satisfied by a ready carrying another boot\'s correlator', async () => {
    const { client } = await relay(() => ({
      type: 'device:ready', sessionId: 's1', requestId: 'someone-elses', payload: { deviceId: 'dev-1' },
    }))
    expect(await pendingAfter(client.bootDevice('s1', 'dev-1'))).toBe('still-waiting')
  })

  it('is satisfied by a ready with no correlator, so an agent predating the echo still boots', async () => {
    // Rejecting this would trade a misattribution for the full 120s deadline — and this waiter is the
    // only thing between a flow run and that deadline.
    const { client } = await relay(() => ({
      type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' },
    }))
    await expect(client.bootDevice('s1', 'dev-1')).resolves.toBeUndefined()
  })

  it('is not satisfied by the relay\'s replay, which carries no sessionId', async () => {
    // Staged as an answer to the boot rather than during the join, because in the ordinary sequence the
    // waiter does not exist yet when the replay goes out — so a test that only joins would pass with
    // the `sessionId` comparison deleted. That comparison, not the correlator, is what excludes this
    // frame: an optional field can make a match more precise, never make it fail.
    const { client } = await relay(() => ({ type: 'device:ready', payload: { deviceId: 'dev-1' } }))
    expect(await pendingAfter(client.bootDevice('s1', 'dev-1'))).toBe('still-waiting')
  })

  it('waits through a boot-error raised for some other boot', async () => {
    // The mirror of the deadline defect: accepting a diagnosis that answers a different request fails a
    // boot still perfectly capable of succeeding.
    const { client } = await relay(() => ({
      type: 'device:boot-error', sessionId: 's1', requestId: 'not-mine', message: 'other',
    }))
    expect(await pendingAfter(client.bootDevice('s1', 'dev-1'))).toBe('still-waiting')
  })

  it('fails on the boot-error that does answer it', async () => {
    const { client } = await relay((m) => ({
      type: 'device:boot-error', sessionId: 's1', requestId: m['requestId'], message: 'emulator gone',
    }))
    await expect(client.bootDevice('s1', 'dev-1')).rejects.toThrow('emulator gone')
  })
})


// L5d. `error` is the answer to a `session:start` the relay refused, and it carries the session it refuses.
// This file had **no `error` fixture at all** before, so removing the waiter's `sessionId === undefined`
// escape was untested in both directions — the review that found that is why these exist.
describe('RelayClient.joinSession — a refusal is addressed', () => {
  let wss: WebSocketServer | null = null

  afterEach(async () => {
    const s = wss
    wss = null
    if (!s) return
    for (const c of s.clients) c.terminate()
    await new Promise<void>((r) => s.close(() => r()))
  })

  /** A relay that answers `session:start` with whatever the test returns — one frame, or several. */
  async function relay(
    reply: (msg: Record<string, unknown>) => Record<string, unknown> | Record<string, unknown>[],
  ) {
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        if (msg['type'] !== 'session:start') return
        const out = reply(msg)
        for (const frame of Array.isArray(out) ? out : [out]) ws.send(JSON.stringify(frame))
      })
    })
    const port = (wss.address() as { port: number }).port
    const client = new RelayClient(`ws://localhost:${port}`, '')
    await client.connect()
    return client
  }

  it('fails the join on a refusal that names its session', async () => {
    const client = await relay((m) => ({
      type: 'error', sessionId: m['sessionId'], message: 'Session busy', reason: 'session-busy',
    }))
    await expect(client.joinSession('s1')).rejects.toThrow('Session busy')
  })

  it('carries the machine reason, not just the prose (#512)', async () => {
    // `reason` is what #506 added the field for — the dashboard was branching on the prose, handled two of
    // three wordings, and dropped `Session busy` silently. This client was still reading the prose, so the
    // three outcomes were indistinguishable to a caller: retry works, nothing is ever coming, or the Mac is
    // over its ceiling.
    for (const reason of ['session-busy', 'session-not-found', 'agent-resources-exhausted'] as const) {
      const client = await relay((m) => ({ type: 'error', sessionId: m['sessionId'], message: 'refused', reason }))
      const err = await client.joinSession('s1').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SessionJoinError)
      expect((err as SessionJoinError).reason).toBe(reason)
      expect((err as Error).message).toContain(reason)
      const s = wss
      wss = null
      for (const c of s!.clients) c.terminate()
      await new Promise<void>((r) => s!.close(() => r()))
    }
  })

  it('reads a reason it does not know as unknown rather than passing it through', async () => {
    // The guard's member list lives in this package — `protocol`'s entry erases under `import type` — so a
    // string off the wire that is not a member must not be reported as if it were one. `Record<
    // SessionStartFailure, true>` is what makes falling behind a compile error rather than a silent widening.
    const client = await relay((m) => ({
      type: 'error', sessionId: m['sessionId'], message: 'refused', reason: 'a-reason-from-the-future',
    }))
    const err = await client.joinSession('s1').catch((e: unknown) => e) as SessionJoinError
    expect(err.reason).toBe('unknown')
  })

  it('does not take a refusal meant for another session', async () => {
    // The other half of #512's first finding: with the old `sessionId === undefined` escape this resolved,
    // and the caller was told a failure that belonged to a join it had not made.
    const client = await relay(() => ({
      type: 'error', sessionId: 'someone-else', message: 'Session busy', reason: 'session-busy',
    }))
    const settled = await Promise.race([
      client.joinSession('s1').then(() => 'resolved').catch(() => 'rejected'),
      new Promise<string>((r) => setTimeout(() => r('still-waiting'), 150)),
    ])
    expect(settled).toBe('still-waiting')
  })

  it('logs once when a refusal carries no address, and still times out', async () => {
    // A relay older than L5d. There is no version handshake anywhere, so this frame is the only signal that
    // the two sides disagree — and without the log the join simply times out with no stated reason, which is
    // #512's complaint arriving through a different door.
    const logged: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logged.push(String(m)) })
    try {
      const client = await relay(() => ({ type: 'error', message: 'Session busy', reason: 'session-busy' }))
      const settled = await Promise.race([
        client.joinSession('s1').then(() => 'resolved').catch(() => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still-waiting'), 200)),
      ])
      expect(settled).toBe('still-waiting')
    } finally { spy.mockRestore() }
    expect(logged.filter((l) => l.includes('predates addressed errors'))).toHaveLength(1)
  })

  it('logs the skew once even when the old relay refuses more than once', async () => {
    // The once-guard above was **free**: the harness answered a single `session:start`, so "once" and "every
    // time" produced the same one line and removing `!this.addressSkewLogged` passed all 70 tests. An old
    // relay refuses *every* join this way, and a client driving a flow of many steps would get a line per
    // refusal — the volume that buries the one message telling the operator what to fix. Two frames is the
    // smallest fixture where the guard is observable.
    const logged: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logged.push(String(m)) })
    try {
      const client = await relay(() => [
        { type: 'error', message: 'Session busy', reason: 'session-busy' },
        { type: 'error', message: 'Session busy', reason: 'session-busy' },
      ])
      await Promise.race([
        client.joinSession('s1').catch(() => 'rejected'),
        new Promise((r) => setTimeout(r, 200)),
      ])
    } finally { spy.mockRestore() }
    expect(logged.filter((l) => l.includes('predates addressed errors'))).toHaveLength(1)
  })
})
