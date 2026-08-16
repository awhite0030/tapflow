import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type {
  AgentRegistered, DeviceShutdown, DeviceShutdownError, GenericError, SessionChrome, SessionJoined,
} from '@tapflowio/protocol'

// Three defects that share a subject — who holds a session — and **not** the question of who *should*.
// That one is #527/#507(2) and needs a definition of owner that survives a reconnect, which is a
// different slice. What is here is the part that needed no such decision:
//
//  - #515 a socket re-joining the session it already holds was told `session-not-found`
//  - #507 the reverse index held one session per socket while the relation is one-to-many
//  - #542 `device:shutdown` was the one browser command the relay never answered
describe('session ownership seam', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-ownership-seam-'))
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

  afterEach(async () => { await server.stop() })

  async function registerAgent(name: string, devices = 1) {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: name,
      devices: Array.from({ length: devices }, (_, i) => ({
        id: `dev${i}`, name: `iPhone ${i}`, platform: 'ios', status: 'shutdown',
      })),
    }))
    const reply = await waitForType<AgentRegistered>(agent, 'agent:registered')
    return { agent, sessionIds: reply.registeredSessions.map((s) => s.sessionId) }
  }

  async function browserSocket() {
    const ws = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(ws)
    return ws
  }

  // ── #515 — re-joining a session this socket already holds ─────────────────────────────────────────

  it('answers a re-join by the owning socket with session:joined, not an error', async () => {
    const { agent, sessionIds } = await registerAgent('seam-rejoin')
    const sessionId = sessionIds[0]!
    const browser = await browserSocket()

    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType<SessionJoined>(browser, 'session:joined')

    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    const again = await waitForType<SessionJoined>(browser, 'session:joined')
    expect(again.sessionId).toBe(sessionId)

    // The refusal is the thing being ruled out, so it is waited for rather than assumed absent: the
    // relay used to send `error` with `reason: 'session-not-found'` here, for a session this socket was
    // holding — `DeviceViewer` maps that reason to `onSessionEnded('agent-disconnected')` and takes the
    // viewer off a session that is fine.
    expect(await waitForTypeOrNull<GenericError>(browser, 'error', 200)).toBeNull()

    agent.close(); browser.close()
  })

  it('replays the session cache to a re-joining owner, as it does for a fresh join', async () => {
    const { agent, sessionIds } = await registerAgent('seam-replay')
    const sessionId = sessionIds[0]!
    const browser = await browserSocket()
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')

    agent.send(JSON.stringify({
      type: 'session:chrome', sessionId, payload: { platform: 'ios', model: 'iPhone 15' },
    }))
    await waitForType<SessionChrome>(browser, 'session:chrome')

    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    // Idempotent means the *whole* handler runs again, not just its reply. A re-join that answered and
    // returned early would leave a reconnecting viewer with no bezel — which is the state #515's
    // consumers were in for a different reason.
    const chrome = await waitForType<SessionChrome>(browser, 'session:chrome')
    expect(chrome.payload).toMatchObject({ model: 'iPhone 15' })

    agent.close(); browser.close()
  })

  it('a re-join leaves the socket owning the session, and holding it exactly once', async () => {
    const { agent, sessionIds } = await registerAgent('seam-keeps')
    const sessionId = sessionIds[0]!
    const browser = await browserSocket()
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')

    // Ownership survived: an acked input from this socket is forwarded rather than refused. Asserted
    // through the wire because `ownsSession` is what every command consults, and a re-join that dropped
    // the binding would leave the viewer connected and unable to touch anything.
    browser.send(JSON.stringify({
      type: 'input:touch:end', sessionId, requestId: 'rq-1', payload: { x: 0.5, y: 0.5 },
    }))
    const forwarded = await waitForType(agent, 'input:touch:end')
    expect(forwarded.sessionId).toBe(sessionId)
    expect(await waitForTypeOrNull(browser, 'input:error', 200)).toBeNull()

    agent.close(); browser.close()
  })

  it('still refuses a socket that does not hold the session', async () => {
    const { agent, sessionIds } = await registerAgent('seam-busy')
    const sessionId = sessionIds[0]!
    const holder = await browserSocket()
    holder.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(holder, 'session:joined')

    const other = await browserSocket()
    other.send(JSON.stringify({ type: 'session:start', sessionId }))
    const refusal = await waitForType<GenericError>(other, 'error')
    expect(refusal.reason).toBe('session-busy')

    agent.close(); holder.close(); other.close()
  })

  // `join()`'s two failures are answered above it in the handler, so nothing reaches its result branch by
  // ordinary means — and an arm no input can reach is an arm whose reply drifts. `RelayServer.test.ts`
  // forces the `catch` next door with the same technique and for the same stated reason. The mapping is
  // what is under test: reporting `held-by-another` as `session-not-found` is #515's defect exactly, and
  // without this the mutation that reintroduces it survives the whole suite.
  it.each([
    ['not-found', 'session-not-found', 'Session not found'],
    ['held-by-another', 'session-busy', 'Session busy'],
  ])('maps a %s from join() to %s', async (failure, reason, message) => {
    const { agent, sessionIds } = await registerAgent(`seam-map-${failure}`)
    const sessionId = sessionIds[0]!
    const sessions = (server as unknown as {
      sessions: { join(id: string, ws: WebSocket): { ok: boolean } }
    }).sessions
    const spy = vi.spyOn(sessions, 'join').mockReturnValue({ ok: false, failure } as never)
    try {
      const browser = await browserSocket()
      browser.send(JSON.stringify({ type: 'session:start', sessionId }))
      const err = await waitForType<GenericError>(browser, 'error')
      expect(err.reason).toBe(reason)
      expect(err.message).toBe(message)
      expect(err.sessionId).toBe(sessionId)
      browser.close()
    } finally { spy.mockRestore() }
    agent.close()
  })

  // ── #507 — one socket, several sessions ───────────────────────────────────────────────────────────

  it('releases every session a closing socket held, not just the last one joined', async () => {
    // `mcp-server` runs one WebSocket for the whole process and joins a session per device, so this is
    // the ordinary shape rather than an edge case. With the old one-slot index the close handler found
    // only `b`: `a` kept a `browserSocket` pointing at a dead socket, stayed `busy: true` for the life of
    // the relay, and never got an idle timer — a booted device with nobody watching and nothing to stop
    // it. The relay is built with a 50ms idle timeout here so the timer's effect is observable.
    await server.stop()
    server = new RelayServer({ port: 0, idleTimeoutMs: 50 })
    await server.start()
    port = (server.address() as { port: number }).port

    const { agent, sessionIds } = await registerAgent('seam-multi', 2)
    const [a, b] = sessionIds as [string, string]
    const browser = await browserSocket()
    browser.send(JSON.stringify({ type: 'session:start', sessionId: a }))
    await waitForType(browser, 'session:joined')
    browser.send(JSON.stringify({ type: 'session:start', sessionId: b }))
    await waitForType(browser, 'session:joined')

    browser.close()

    // Both idle timers fire, so the agent is asked to shut both devices down. Collected by session id
    // rather than counted: the failure this replaces produced exactly one of these, and a count of two
    // would also pass if the same session were released twice.
    const first = await waitForType<DeviceShutdown>(agent, 'device:shutdown')
    const second = await waitForType<DeviceShutdown>(agent, 'device:shutdown')
    expect([first.sessionId, second.sessionId].sort()).toEqual([a, b].sort())

    agent.close()
  })

  it('keeps the first session usable while the same socket holds a second', async () => {
    const { agent, sessionIds } = await registerAgent('seam-both-live', 2)
    const [a, b] = sessionIds as [string, string]
    const browser = await browserSocket()
    browser.send(JSON.stringify({ type: 'session:start', sessionId: a }))
    await waitForType(browser, 'session:joined')
    browser.send(JSON.stringify({ type: 'session:start', sessionId: b }))
    await waitForType(browser, 'session:joined')

    // The first design for #507 released `a` here, which would refuse this input and, five minutes on,
    // shut a device down under a caller that is still driving it. Two independent design reviews found
    // that before it was written; this is what says so afterwards.
    browser.send(JSON.stringify({
      type: 'input:touch:end', sessionId: a, requestId: 'rq-a', payload: { x: 0.1, y: 0.1 },
    }))
    const forwarded = await waitForType(agent, 'input:touch:end')
    expect(forwarded.sessionId).toBe(a)

    agent.close(); browser.close()
  })

  it('arms no idle timer for a socket closed by stop() itself', async () => {
    // `stop()` sets `stopping` and then terminates every client, so the release loop runs during
    // shutdown with as many sessions as the socket held — and each `clearBrowser(id, cb)` arms a timer
    // that outlives the promise `stop()` resolves. `holdAgentSocket` carries the same guard with the
    // same reason beside it; the browser side did not, and #507 turned one stray timer into N.
    //
    // **The agent has to be inside its reconnect hold, and finding that out is the test.** A first
    // version just stopped a healthy relay and found the sessions already gone: `stop()` terminates the
    // agent socket too, its close hits `holdAgentSocket`'s own `stopping` guard, and `evictAgentSocket`
    // removes every session — which clears any timer the browser's close had armed a moment earlier.
    // So the guard is load-bearing in exactly one state, and it is a state #426 made ordinary: the
    // agent dropped uncleanly, its socket is no longer in `wss.clients`, so nothing evicts on the way
    // out and the sessions — with their timers — survive the server.
    //
    // **Asserted on `session.idleTimer`, not on the absence of a shutdown.** A test that waits out the
    // timeout and finds nothing passes when nothing happens, which is its definition: it cannot tell a
    // working guard from a relay that has stopped answering. The field is a positive statement.
    const own = new RelayServer({ port: 0, idleTimeoutMs: 50 })
    await own.start()
    const ownPort = (own.address() as { port: number }).port

    const agent = new WebSocket(`ws://localhost:${ownPort}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: 'seam-stopping',
      devices: [
        { id: 'dev0', name: 'iPhone 0', platform: 'ios', status: 'shutdown' },
        { id: 'dev1', name: 'iPhone 1', platform: 'ios', status: 'shutdown' },
      ],
    }))
    const reg = await waitForType<AgentRegistered>(agent, 'agent:registered')
    const ids = reg.registeredSessions.map((s) => s.sessionId)

    const browser = new WebSocket(`ws://localhost:${ownPort}`)
    await waitForOpen(browser)
    for (const id of ids) {
      browser.send(JSON.stringify({ type: 'session:start', sessionId: id }))
      await waitForType(browser, 'session:joined')
    }

    // Into the hold. `session:agent-away` is the relay saying it kept the sessions rather than ending
    // them, so waiting for it is what proves the state is set up — a sleep would not.
    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed
    await waitForType(browser, 'session:agent-away')

    // `stop()` resolves only after `wss.close()` has seen every remaining client close, so the handler
    // under test has run by the time this returns. No sleep, and nothing to race.
    await own.stop()

    const sessions = (own as unknown as {
      sessions: { get(id: string): { idleTimer: unknown; browserSocket: unknown } | undefined }
    }).sessions
    for (const id of ids) {
      // Present, which is the premise — an evicted session would make the timer assertion vacuous, and
      // that is precisely how the first version of this test passed against the unguarded code.
      expect(sessions.get(id), `${id} was evicted, so this proves nothing`).toBeDefined()
      expect(sessions.get(id)?.idleTimer, `${id} armed a timer during stop()`).toBeNull()
    }
    // The cost of the guard, stated rather than left implicit: the sessions stay bound to a socket that
    // is gone. Correct here and only here — the process is on its way out, and the alternative is a
    // timer firing at a relay that no longer exists.
    expect(sessions.get(ids[0]!)?.browserSocket).not.toBeNull()

    browser.close()
  })

  it('does not let repeated re-joins force one keyframe each', async () => {
    // #515 made a re-join run the handler's whole body, and the tail of that body asks the agent for an
    // IDR when the session is streaming. That line was unreachable for a socket already holding the
    // session — `join()` threw and the handler answered above it — so making the re-join succeed opened
    // a request-per-frame path on the direction a viewer with devtools controls. A 1080p IDR is two
    // orders of magnitude larger than the P-frames around it, so the cost lands on the tester watching.
    //
    // Counted rather than sampled: the assertion that discriminates a throttled call from a bare
    // `sendTo` is **how many** arrive, and no shape of "did one arrive" can see the difference.
    const { agent, sessionIds } = await registerAgent('seam-idr')
    const sessionId = sessionIds[0]!
    const idrs: unknown[] = []
    agent.on('message', (d) => {
      const m = JSON.parse(String(d)) as { type?: string }
      if (m.type === 'stream:request-idr') idrs.push(m)
    })

    const browser = await browserSocket()
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    // `readySent` is what gates the IDR, and only a `device:ready` from the agent sets it.
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'dev0' } }))
    await waitForType(browser, 'device:ready')

    for (let i = 0; i < 5; i++) {
      browser.send(JSON.stringify({ type: 'session:start', sessionId }))
      await waitForType(browser, 'session:joined')
    }
    // The relay answered all five; a round trip on the agent's own socket proves anything it sent them
    // has been flushed to this end too.
    await barrier(agent)

    expect(idrs).toHaveLength(1)

    agent.close(); browser.close()
  })

  it('releases the sessions a socket that also registered a stream was holding', async () => {
    // The close handler tried the stream branch first and **returned** from it, so a socket that was both
    // never reached the release below — the exact state the loop above exists to end, reachable because
    // the role gate refuses a `browser`-role socket sending a non-browser type and says nothing about a
    // `stream`-role one sending `session:start`. Order matters: `stream:register` first is what makes the
    // socket stream-role, and a socket that joined first would be closed with 1008 for registering.
    await server.stop()
    server = new RelayServer({ port: 0, idleTimeoutMs: 50 })
    await server.start()
    port = (server.address() as { port: number }).port

    const { agent, sessionIds } = await registerAgent('seam-stream-holder')
    const sessionId = sessionIds[0]!
    const both = await browserSocket()
    both.send(JSON.stringify({ type: 'stream:register', sessionId }))
    await waitForType(both, 'stream:registered')
    both.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(both, 'session:joined')

    both.close()

    const fired = await waitForType<DeviceShutdown>(agent, 'device:shutdown')
    expect(fired.sessionId).toBe(sessionId)

    agent.close()
  })

  // ── #542 — device:shutdown is answered when it cannot be dispatched ───────────────────────────────

  it('answers a shutdown addressed to a session that does not exist', async () => {
    const { agent } = await registerAgent('seam-shutdown-missing')
    const browser = await browserSocket()

    browser.send(JSON.stringify({
      type: 'device:shutdown', sessionId: 'no-such-session', requestId: 'rq-gone',
      payload: { deviceId: 'dev0' },
    }))
    const err = await waitForType<DeviceShutdownError>(browser, 'device:shutdown-error')
    expect(err.message).toBe('Session not found')
    expect(err.sessionId).toBe('no-such-session')
    // Echoed by the relay itself, the obligation `device:boot-error` carries next door: a caller that
    // receives this uncorrelated reads it as unsolicited and waits out its 30s anyway.
    expect(err.requestId).toBe('rq-gone')

    agent.close(); browser.close()
  })

  it('answers a shutdown whose agent has gone', async () => {
    const { agent, sessionIds } = await registerAgent('seam-shutdown-away')
    const sessionId = sessionIds[0]!
    const browser = await browserSocket()
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')

    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed
    await waitForType(browser, 'session:agent-away')

    browser.send(JSON.stringify({
      type: 'device:shutdown', sessionId, requestId: 'rq-away', payload: { deviceId: 'dev0' },
    }))
    const err = await waitForType<DeviceShutdownError>(browser, 'device:shutdown-error')
    // The two prose strings are one distinction #492 settled: a held session with a dead socket is the
    // agent's fault, a missing session is not, and telling them apart is what stops a caller chasing the
    // wrong problem.
    expect(err.message).toBe('agent offline')

    browser.close()
  })

  it('leaves the correlator absent when the request carried none', async () => {
    // The dashboard's three teardown senders mint no id, deliberately — nothing there waits on the
    // reply. Inventing one would produce a frame that correlates with a request nobody made, and the
    // declaration is `requestId?` on both sides precisely so this can stay absent.
    const { agent } = await registerAgent('seam-shutdown-uncorrelated')
    const browser = await browserSocket()

    browser.send(JSON.stringify({
      type: 'device:shutdown', sessionId: 'no-such-session', payload: { deviceId: 'dev0' },
    }))
    const err = await waitForType<DeviceShutdownError>(browser, 'device:shutdown-error')
    expect(err.message).toBe('Session not found')
    expect('requestId' in err).toBe(false)

    agent.close(); browser.close()
  })

  it('still forwards a shutdown from a socket that does not hold the session', async () => {
    // #527, not this slice. `reachableTarget` deliberately omits the ownership clause, because three of
    // the dashboard's four senders come from a socket that never joins — gating it here would break
    // going back and the unmount teardown, the two paths that stop a device costing money. This pins the
    // omission so that closing #527 is a decision someone makes rather than a line that drifts in.
    const { agent, sessionIds } = await registerAgent('seam-shutdown-nonowner')
    const sessionId = sessionIds[0]!
    const holder = await browserSocket()
    holder.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(holder, 'session:joined')

    const stranger = await browserSocket()
    stranger.send(JSON.stringify({
      type: 'device:shutdown', sessionId, payload: { deviceId: 'dev0' },
    }))
    const forwarded = await waitForType<DeviceShutdown>(agent, 'device:shutdown')
    expect(forwarded.sessionId).toBe(sessionId)
    expect(await waitForTypeOrNull(stranger, 'device:shutdown-error', 200)).toBeNull()

    agent.close(); holder.close(); stranger.close()
  })

  it('does not answer the shutdown the relay originates from its own idle timer', async () => {
    // There is no browser behind that one — it is built and sent inside the timer callback and never
    // enters `route()`, so `reachableTarget` cannot see it. Worth pinning because the obvious way to
    // implement #542 is to answer inside a shared helper, and this is the caller that has nobody to
    // answer.
    await server.stop()
    server = new RelayServer({ port: 0, idleTimeoutMs: 50 })
    await server.start()
    port = (server.address() as { port: number }).port

    const { agent, sessionIds } = await registerAgent('seam-idle')
    const sessionId = sessionIds[0]!
    const browser = await browserSocket()
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')

    const observer = await browserSocket()
    await barrier(observer)
    browser.close()

    const fired = await waitForType<DeviceShutdown>(agent, 'device:shutdown')
    expect(fired.sessionId).toBe(sessionId)
    expect(await waitForTypeOrNull(observer, 'device:shutdown-error', 200)).toBeNull()

    agent.close(); observer.close()
  })
})
