import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type { AgentRegistered, AgentsListed, DeviceBootError, SessionAgentAway, SessionJoined, SessionRebound, SessionTerminated } from '@tapflowio/protocol'

// #426 stage 3. Stage 2 taught the relay to re-point a session at a restarted agent's socket, and
// it worked — but only while the old socket was still open. On a real restart it never was: the
// close is processed in under 400ms and a new agent takes about a second to register, so the
// sessions were always gone before it arrived. Measured twice on a simulator; the tab got the same
// bounce to the Mac list it got before any of this existed.
//
// So the relay now holds a closed agent's sessions for a window, and the rebind gets its chance.
//
// The whole point is the socket really closing first. Stage 2's tests kept both sockets open at
// once, which handed the precondition over for free — that is precisely why nothing caught it.
describe('a session outlives its agent socket long enough to be reclaimed (#426)', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  // Long enough that nothing inside a test races it, short enough to wait out twice.
  const GRACE = 300

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-agent-grace-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(async () => {
    server = new RelayServer({ port: 0, agentGraceMs: GRACE })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => { await server.stop() })

  const DEV_A = { id: 'devA', name: 'iPhone A', platform: 'ios', status: 'booted' }
  type Device = { id: string; name: string; platform: string; status: string }

  async function register(devices: Device[] = [DEV_A], agentId = 'mac-1') {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', agentId, agentName: 'the-mac', platform: 'ios',
      devices, capabilities: ['clipboard'],
    }))
    const reply = await waitForType<AgentRegistered>(agent, 'agent:registered')
    const byDevice = new Map(reply.registeredSessions.map((r) => [r.deviceId, r.sessionId]))
    return { agent, byDevice }
  }

  async function join(sessionId: string) {
    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    const joined = await waitForType<SessionJoined>(browser, 'session:joined')
    return Object.assign(browser, { joined })
  }

  /** Closes a socket and waits for the *client's* close event.
   *
   *  This does NOT prove the relay has processed the close — that is a different event on a
   *  different socket object, and measuring it shows the hold is not armed yet when this resolves.
   *  Anything that depends on the relay having held the sessions must wait for `session:agent-away`
   *  instead, which `holdAgentSocket` is the only sender of. Relying on this alone is what let the
   *  previous stage ship with a trigger that never fired. */
  async function closeAndSettle(ws: WebSocket) {
    const closed = new Promise<void>((r) => ws.on('close', () => r()))
    ws.close()
    await closed
  }

  /** Closes the agent and waits for the relay to say it is holding — the barrier `closeAndSettle`
   *  is not. Without it a register can beat the close handler, and the test then proves the old
   *  behaviour (both sockets briefly registered at once) rather than the new one. */
  async function closeAndHeld(agent: WebSocket, browser: WebSocket) {
    await closeAndSettle(agent)
    await waitForType(browser, 'session:agent-away')
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  /** The hold map is private, and it is the only place the release is observable — the timers
   *  themselves are no-ops by the time they fire. Reaching in beats leaving the release untested. */
  const holdsOf = (s: RelayServer) =>
    (s as unknown as { agentHolds: Map<unknown, unknown> }).agentHolds

  async function devices(ws: WebSocket) {
    ws.send(JSON.stringify({ type: 'agents:list' }))
    const listed = await waitForType<AgentsListed>(ws, 'agents:listed')
    return (listed.sessions ?? []).flatMap((s) => s.devices)
  }

  it('reclaims a session after its agent socket actually closed', async () => {
    // The case stage 2 could not reach. Everything here happens in the order a real restart
    // happens in: the socket dies, the relay processes that, and only then does a new one appear.
    const first = await register()
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)

    // Waiting for the hold, not just for the client's close: otherwise the register can win the
    // race and this passes because both sockets were briefly registered at once — the precondition
    // stage 2 quietly relied on. Measured at roughly 1 run in 30 without this.
    await closeAndHeld(first.agent, browser)
    const second = await register()

    const rebound = await waitForType<SessionRebound>(browser, 'session:rebound')
    expect(rebound.sessionId).toBe(sessionId)
    expect(second.byDevice.get('devA')).toBe(sessionId)

    second.agent.close(); browser.close()
  })

  it('tells the viewer it is waiting, before anything is decided', async () => {
    const first = await register()
    const browser = await join(first.byDevice.get('devA')!)

    await closeAndSettle(first.agent)

    const away = await waitForType<SessionAgentAway>(browser, 'session:agent-away')
    expect(away.sessionId).toBe(first.byDevice.get('devA'))
    // Nothing has been decided yet — the frozen frame is explained, not resolved. Only
    // `session:terminated` is worth asserting: no second agent registers here, so `session:rebound`
    // has no code path that could produce it and an assertion against it could never fail.
    expect(await waitForTypeOrNull(browser, 'session:terminated', 0)).toBeNull()

    browser.close()
  })

  it('ends the session when the agent does not come back', async () => {
    const first = await register()
    const browser = await join(first.byDevice.get('devA')!)

    await closeAndSettle(first.agent)
    await waitForType(browser, 'session:agent-away')

    const ended = await waitForType<SessionTerminated>(browser, 'session:terminated')
    expect(ended.reason).toBe('agent-disconnected')

    browser.close()
  })

  it('gives a fresh session to an agent that comes back too late', async () => {
    const first = await register()
    const kept = first.byDevice.get('devA')!

    await closeAndSettle(first.agent)
    await sleep(GRACE * 3)
    const second = await register()

    expect(second.byDevice.get('devA')).not.toBe(kept)

    second.agent.close()
  })

  it('survives a browser blip inside the window', async () => {
    // The failure the design review found before any of this was written. Refusing the re-join —
    // the first draft's plan — leaves the tab permanently stuck: the viewer sends `session:start`
    // once per reconnect and ignores a plain `error`, and `session:rebound` is addressed to
    // `browserSocket`, which a refusal never sets. The session then lives on, rebound and healthy,
    // with a tab that can never hear about it.
    const first = await register()
    const sessionId = first.byDevice.get('devA')!
    const browserA = await join(sessionId)

    await closeAndSettle(first.agent)
    await waitForType(browserA, 'session:agent-away')
    await closeAndSettle(browserA)

    // The viewer reconnects and re-joins, exactly as `useRelay` does after a socket drop.
    const browserB = await join(sessionId)
    expect(await waitForType(browserB, 'session:agent-away')).toBeTruthy()

    const second = await register()

    expect((await waitForType<SessionRebound>(browserB, 'session:rebound')).sessionId).toBe(sessionId)

    second.agent.close(); browserB.close()
  })

  it('does not replay the gone agent\'s state to a viewer joining inside the window', async () => {
    // `handleSessionStart` replays chrome, device info and `device:ready`. All three describe the
    // process that just died, and nothing clears them during the hold.
    const first = await register()
    const sessionId = first.byDevice.get('devA')!
    const browserA = await join(sessionId)
    first.agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'devA' } }))
    first.agent.send(JSON.stringify({ type: 'session:chrome', sessionId, payload: { tag: 'old' } }))
    first.agent.send(JSON.stringify({
      type: 'session:deviceInfo', sessionId, payload: { deviceName: 'stale', osVersion: '17.0' },
    }))
    await waitForType(browserA, 'session:deviceInfo')
    await closeAndSettle(browserA)

    await closeAndSettle(first.agent)
    const browserB = await join(sessionId)
    await barrier(browserB)

    expect(await waitForTypeOrNull(browserB, 'session:chrome', 0)).toBeNull()
    expect(await waitForTypeOrNull(browserB, 'session:deviceInfo', 0)).toBeNull()
    expect(await waitForTypeOrNull(browserB, 'device:ready', 0)).toBeNull()

    browserB.close()
  })

  it('answers a boot for a session whose hold has expired', async () => {
    // The other half of the pair in `appCommandErrors.test.ts`: inside the window the id is valid
    // and the answer is `agent offline`; once the hold expires the id really is gone.
    const first = await register()
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)

    await closeAndSettle(first.agent)
    await waitForType(browser, 'session:terminated')

    browser.send(JSON.stringify({ type: 'device:boot', sessionId, requestId: 'rq-grace', payload: { deviceId: 'devA' } }))

    expect((await waitForType<DeviceBootError>(browser, 'device:boot-error')).message).toBe('Session not found')

    browser.close()
  })

  it('offers no device while its agent is away', async () => {
    // A held session is not something anyone can pick. Listed, it would render a Mac card with the
    // dead agent's last CPU/RAM reading and no warning — the `Stale` badge keys off a 30s-old
    // sample, an order of magnitude longer than this window.
    const first = await register()
    const probe = await join(first.byDevice.get('devA')!)

    await closeAndSettle(first.agent)
    await waitForType(probe, 'session:agent-away')

    expect(await devices(probe)).toEqual([])

    const second = await register()
    await waitForType(probe, 'session:rebound')
    expect((await devices(probe)).map((d) => d.id)).toEqual(['devA'])

    second.agent.close(); probe.close()
  })

  it('shows one Mac even when the returning agent reports a different identity', async () => {
    // Upgrading is a common reason to restart an agent, and an upgrade can be the one that starts
    // sending `agentId`. Identity then does not match, nothing is rebound, and `create()` makes a
    // second set — two groups under one `agentName`, which the dashboard keys its list by.
    const first = await register([DEV_A], 'mac-1')
    const probe = await join(first.byDevice.get('devA')!)
    await closeAndSettle(first.agent)
    await waitForType(probe, 'session:agent-away')

    const second = await register([DEV_A], 'a-different-machine-id')

    expect((await devices(second.agent)).map((d) => d.id)).toEqual(['devA'])

    second.agent.close(); probe.close()
  })

  it('does not kill a reclaimed session when the original deadline passes', async () => {
    // Two independent defences hold this up: the hold is released when the agent returns, and the
    // timer is keyed by the dead socket rather than by session ids, so a late expiry finds an empty
    // set. Mutating either one alone leaves this green — they genuinely cover for each other, and
    // it takes removing both (timer captures ids AND no release) to break it. Measured.
    //
    // The redundancy is worth keeping: the socket-keyed timer is what makes the release optional,
    // and the release is what keeps a timer from lingering per restart.
    const first = await register()
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)

    // If the register wins the race no hold is ever armed, and the timer whose late firing this is
    // about does not exist — the assertion would hold against a scenario it never created.
    await closeAndHeld(first.agent, browser)
    const second = await register()
    await waitForType(browser, 'session:rebound')

    // The release is the only half of the pair with an observable, and this is it.
    expect(holdsOf(server).size).toBe(0)
    await sleep(GRACE * 3)

    // Well past the original expiry, and the session is still here.
    expect((await devices(second.agent)).map((d) => d.id)).toEqual(['devA'])
    expect(await waitForTypeOrNull(browser, 'session:terminated', 0)).toBeNull()

    second.agent.close(); browser.close()
  })

  it('handles a restart that reclaims nothing', async () => {
    // A restart reporting a completely different device list rebinds zero sessions — the old ones
    // are evicted at register time instead. Nothing observable distinguishes the hold being
    // released here from it expiring later against an empty set, so this pins the outcome rather
    // than the mechanism: the new device is listed and the old one is not.
    const first = await register([DEV_A])
    await closeAndSettle(first.agent)

    const second = await register([{ id: 'devZ', name: 'iPhone Z', platform: 'ios', status: 'booted' }])
    await sleep(GRACE * 3)

    expect((await devices(second.agent)).map((d) => d.id)).toEqual(['devZ'])

    second.agent.close()
  })

  it('frees the device when it comes back under a different identity', async () => {
    // The hold is only worth keeping while the device is unreachable. Identity is
    // `agentId ?? agentName`, and an upgrade — the usual reason to restart — can be the release
    // that starts sending an agentId, so nothing rebinds. Leaving the old session held would strand
    // its viewer for the full window while a colleague picks the very same simulator.
    const first = await register([DEV_A], 'mac-1')
    const browser = await join(first.byDevice.get('devA')!)
    await closeAndSettle(first.agent)
    await waitForType(browser, 'session:agent-away')

    const second = await register([DEV_A], 'a-different-machine-id')

    expect((await waitForType<SessionTerminated>(browser, 'session:terminated')).reason).toBe('agent-disconnected')
    expect((await devices(second.agent)).map((d) => d.id)).toEqual(['devA'])

    second.agent.close(); browser.close()
  })

  it('does not read the gone agent\'s resource sample when someone joins', async () => {
    // An overloaded Mac is a common reason to restart an agent, and the last sample it sent is
    // still on the dead socket — `removeResources` does not run until the window closes. Read
    // naively, the join is refused with `Agent resources exhausted` at the exact moment the Mac is
    // recovering, and the tester never learns the agent is on its way back.
    const first = await register()
    const sessionId = first.byDevice.get('devA')!
    first.agent.send(JSON.stringify({
      type: 'agent:resources',
      resources: {
        cpuPercent: 99, memUsedMB: 15_000, memTotalMB: 16_000,
        slotsAvailable: 0, slotsTotal: 2, reportedAt: 1_754_000_000_000,
      },
    }))
    await barrier(first.agent)
    await closeAndSettle(first.agent)

    const browser = await join(sessionId)

    expect(browser.joined.type).toBe('session:joined')
    expect(await waitForType(browser, 'session:agent-away')).toBeTruthy()

    browser.close()
  })

  it('stops holding when the server does', async () => {
    // `stop()` terminates every socket, and each close would arm a fresh hold — after the clearing
    // that was meant to prevent exactly this. The timer then outlives the server and fires against
    // a `SessionManager` nobody owns any more.
    const own = new RelayServer({ port: 0, agentGraceMs: 60_000 })
    await own.start()
    const ownPort = (own.address() as { port: number }).port
    const agent = new WebSocket(`ws://localhost:${ownPort}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', agentName: 'agentReconnectGrace-1', agentId: 'mac-1', platform: 'ios', devices: [DEV_A],
    }))
    await waitForType(agent, 'agent:registered')

    await own.stop()
    // Give the terminate-driven close events their turn.
    await sleep(100)

    expect(holdsOf(own).size).toBe(0)
    agent.close()
  })

  describe('TAPFLOW_AGENT_GRACE_MS', () => {
    // Every one of these silently switches the hold off if the value is merely parsed. `15s` is the
    // typo the documented default ("15000 (15 s)") invites and `parseInt` happily returns 15 for it;
    // `Number('')` is 0, not NaN, so an empty line in `.env` passes a `>= 0` check. This line has
    // been wrong twice — once for the typo, once for the blank.
    const graceFor = (value: string | undefined) => {
      const before = process.env['TAPFLOW_AGENT_GRACE_MS']
      if (value === undefined) delete process.env['TAPFLOW_AGENT_GRACE_MS']
      else process.env['TAPFLOW_AGENT_GRACE_MS'] = value
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        // The window is private and has no observable short of waiting one out, which is the whole
        // problem with these values — a broken one expires before anything can watch for it.
        const ms = (new RelayServer({ port: 0 }) as unknown as { agentGraceMs: number }).agentGraceMs
        const warned = warn.mock.calls.map((c) => c.join(' ')).join('\n')
        return { ms, warned }
      } finally {
        warn.mockRestore()
        if (before === undefined) delete process.env['TAPFLOW_AGENT_GRACE_MS']
        else process.env['TAPFLOW_AGENT_GRACE_MS'] = before
      }
    }

    it.each([
      ['unset', undefined, 15_000],
      ['an empty value', '', 15_000],
      ['a blank value', '   ', 15_000],
      ['a non-number', 'abc', 15_000],
      ['a unit suffix', '15s', 15_000],
      ['a negative', '-5', 15_000],
      ['a real value', '3000', 3_000],
      ['zero, meaning no hold at all', '0', 0],
    ])('reads %s as the %sms window', (label, value, expected) => {
      expect(graceFor(value as string | undefined).ms, label as string).toBe(expected)
    })

    it.each([
      ['a unit suffix', '15s'],
      ['a non-number', 'abc'],
      ['a negative', '-5'],
    ])('warns about %s instead of falling back quietly', (_label, value) => {
      // Documenting the fallback is not enough. Both times this line was wrong the symptom was the
      // hold switching off with nothing said, and someone who typed `15s` is looking at a terminal
      // rather than at the configuration table.
      const { warned } = graceFor(value)
      expect(warned).toContain('TAPFLOW_AGENT_GRACE_MS')
      expect(warned).toContain(value)
    })

    it.each([
      ['unset', undefined],
      ['a usable value', '3000'],
      ['zero', '0'],
    ])('says nothing about %s', (_label, value) => {
      expect(graceFor(value as string | undefined).warned).toBe('')
    })
  })

  it('leaves another agent alone', async () => {
    const ios = await register([DEV_A], 'mac-1')
    const other = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(other)
    other.send(JSON.stringify({
      type: 'agent:register', agentId: 'mac-2', agentName: 'other-mac', platform: 'android',
      devices: [{ id: 'emu-1', name: 'Pixel', platform: 'android', status: 'booted' }],
    }))
    await waitForType(other, 'agent:registered')

    await closeAndSettle(ios.agent)

    expect((await devices(other)).map((d) => d.id)).toEqual(['emu-1'])

    other.close()
  })
})
