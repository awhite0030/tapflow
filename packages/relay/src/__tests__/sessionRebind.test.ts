import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type { RelayMessage } from '../types'

// #426 stage 2. Restarting an agent used to end every session it held: the browser was told
// `session:terminated` and sent back to the Mac list, losing its navigation for something that
// should have been invisible. The relay now keeps the session and re-points it at the new socket,
// telling the viewer with `session:rebound` — which the viewer answers with `device:boot` (PR1).
//
// A restart here is exactly what one is on the wire: a second socket registering the same devices
// under the same identity. Nothing about it announces itself as a restart.
describe('a session survives its agent restarting (#426)', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-session-rebind-'))
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

  const DEV_A = { id: 'devA', name: 'iPhone A', platform: 'ios', status: 'booted' }
  const DEV_B = { id: 'devB', name: 'iPhone B', platform: 'ios', status: 'booted' }

  type Device = { id: string; name: string; platform: string; status: string }

  /** One agent process. `agentId` is the machine identity, so a second call with the same one is
   *  indistinguishable from a restart — which is the point. */
  async function register(devices: Device[], capabilities: string[] = ['clipboard']) {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register',
      agentId: 'mac-1', agentName: 'the-mac', platform: 'ios',
      devices, capabilities,
    }))
    const reply = await waitForType<RelayMessage>(agent, 'agent:registered')
    const byDevice = new Map(reply.registeredSessions!.map((r) => [r.deviceId, r.sessionId]))
    return { agent, byDevice, registered: reply.registeredSessions! }
  }

  /** `joined` is handed back because `session:joined` is consumed here — it is the only message
   *  carrying what the relay has stored about the agent, and a later wait would find it gone. */
  async function join(sessionId: string) {
    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    const joined = await waitForType<RelayMessage>(browser, 'session:joined')
    return Object.assign(browser, { joined })
  }

  /** The device list as the dashboard sees it, flattened across agents. */
  async function devices(ws: WebSocket) {
    ws.send(JSON.stringify({ type: 'agents:list' }))
    const listed = await waitForType<RelayMessage>(ws, 'agents:listed')
    return (listed.sessions ?? []).flatMap((s) => s.devices)
  }

  it('keeps the session id and tells the viewer', async () => {
    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)

    const second = await register([DEV_A])

    const rebound = await waitForType<RelayMessage>(browser, 'session:rebound')
    expect(rebound.sessionId).toBe(sessionId)
    // The same id came back to the agent too, or its own bookkeeping would point at a session the
    // relay has since replaced.
    expect(second.byDevice.get('devA')).toBe(sessionId)

    first.agent.close(); second.agent.close(); browser.close()
  })

  it('does not tell the viewer its session ended', async () => {
    // The old behaviour, and the reason the tab lost its place. `session:terminated` would arrive
    // before `session:rebound`, so ordering cannot hide it.
    const first = await register([DEV_A])
    const browser = await join(first.byDevice.get('devA')!)

    const second = await register([DEV_A])
    await waitForType(browser, 'session:rebound')

    expect(await waitForTypeOrNull(browser, 'session:terminated', 0)).toBeNull()

    first.agent.close(); second.agent.close(); browser.close()
  })

  it('leaves one card per device, not two', async () => {
    // A rebound device must be left out of `create()`. `list()` does not deduplicate, so a second
    // session for the same simulator becomes a second card — and it names an id the agent has never
    // heard of, so it would never come up. That is the bug this change exists to remove.
    const first = await register([DEV_A, DEV_B])
    const second = await register([DEV_A, DEV_B])

    const listed = await devices(second.agent)

    expect(listed.map((d) => d.id).sort()).toEqual(['devA', 'devB'])

    first.agent.close(); second.agent.close()
  })

  it('pairs every device with its own session id', async () => {
    // `registeredSessions` used to pair `devices[i]` with `sessionIds[i]`. Once some devices are
    // rebound the two arrays have different lengths, and position would hand the agent the wrong
    // session for a device — silently, since both values are well-formed uuids.
    const first = await register([DEV_A, DEV_B])
    const keptA = first.byDevice.get('devA')!
    const keptB = first.byDevice.get('devB')!

    // devA is rebound, devC is new, devB is gone — every case at once. The rebound device goes
    // *first* on purpose: that is the order where index alignment hands devA the freshly created
    // session belonging to devC. A well-formed uuid for the wrong device is the failure that hides;
    // put devA last and the misalignment merely runs off the end of the array and shows up as
    // undefined.
    const second = await register([DEV_A, { id: 'devC', name: 'iPhone C', platform: 'ios', status: 'booted' }])

    expect(second.byDevice.get('devA')).toBe(keptA)
    expect(second.byDevice.get('devC')).not.toBe(keptA)
    expect(second.byDevice.get('devC')).not.toBe(keptB)
    expect(second.registered).toHaveLength(2)

    first.agent.close(); second.agent.close()
  })

  it('leaves the old socket holding nothing', async () => {
    // The index move has an order requirement, and this is the state that shows it kept: after the
    // move the old socket owns no session ids, so nothing that walks them can reach the rebound one.
    //
    // Not named for a late close. Reversing the order does break this, but the session is already
    // gone by then — `evictAgentSocket` runs in the same synchronous handler and takes it, so the
    // failure the wrong order produces is immediate, and `keeps the session id and tells the viewer`
    // is what catches it. `first.agent.close()` here is a formality: the relay has already called
    // `terminate()` on that socket.
    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)

    const second = await register([DEV_A])
    await waitForType(browser, 'session:rebound')
    first.agent.close()

    expect((await devices(second.agent)).map((d) => d.id)).toEqual(['devA'])
    expect(await waitForTypeOrNull(browser, 'session:terminated', 0)).toBeNull()

    second.agent.close(); browser.close()
  })

  it('ends the session for a device the restarted agent no longer has', async () => {
    // A rebind is not unconditional. A device that is gone — unplugged, deleted — has no session to
    // keep, and its viewer has to be told rather than left waiting for a `session:rebound` that is
    // never coming.
    const first = await register([DEV_A])
    const browser = await join(first.byDevice.get('devA')!)

    const second = await register([DEV_B])

    const ended = await waitForType<RelayMessage>(browser, 'session:terminated')
    expect(ended.reason).toBe('agent-disconnected')
    expect((await devices(second.agent)).map((d) => d.id)).toEqual(['devB'])

    first.agent.close(); second.agent.close(); browser.close()
  })

  it('keeps the devices that stayed and drops the ones that went', async () => {
    const first = await register([DEV_A, DEV_B])
    const keptA = first.byDevice.get('devA')!
    const browserA = await join(keptA)
    const browserB = await join(first.byDevice.get('devB')!)

    const second = await register([DEV_A])

    expect((await waitForType<RelayMessage>(browserA, 'session:rebound')).sessionId).toBe(keptA)
    await waitForType(browserB, 'session:terminated')
    expect((await devices(second.agent)).map((d) => d.id)).toEqual(['devA'])

    first.agent.close(); second.agent.close(); browserA.close(); browserB.close()
  })

  it('refreshes what the session records about its agent', async () => {
    // An upgrade is the usual reason to restart an agent, so its capabilities are exactly what a
    // restart is likely to change — and `session:joined` is sent once, so a viewer has no other way
    // to learn the new set. The device's own reported state comes across too: left at the old
    // value, a device that came back down would still read `booted` to the REST guards.
    const first = await register([DEV_A, DEV_B], ['clipboard'])
    const browser = await join(first.byDevice.get('devA')!)

    const second = await register(
      [{ ...DEV_A, name: 'iPhone A (renamed)', status: 'shutdown' }, DEV_B],
      ['clipboard', 'audio'],
    )

    const rebound = await waitForType<RelayMessage>(browser, 'session:rebound')
    expect(rebound.capabilities).toEqual(['clipboard', 'audio'])
    // ...but that one only proves the register frame was echoed: the relay copies `msg.capabilities`
    // into it directly, so it holds even if the session was never updated. `session:joined` is what
    // reads `session.agentCapabilities`, so joining devB — rebound too, and with no browser on it —
    // is what observes the stored value.
    const other = await join(first.byDevice.get('devB')!)

    const [devA] = await devices(second.agent)
    expect(devA!.status).toBe('shutdown')
    expect(devA!.name).toBe('iPhone A (renamed)')

    first.agent.close(); second.agent.close(); browser.close(); other.close()
    // Asserted last so the sockets above are closed even when this is the failure.
    expect(other.joined.capabilities).toEqual(['clipboard', 'audio'])
  })

  it('tells the agent about every session it made, even for a repeated device', async () => {
    // Everything here is keyed by device id, so a payload naming one device twice used to collapse
    // to a single `registeredSessions` entry while `create()` had already made two sessions —
    // orphaning one. Agents do not normally send duplicates; the relay does not get to assume it.
    const { agent, registered } = await register([DEV_A, DEV_A])

    const ids = new Set(registered.map((r) => r.sessionId))
    expect((await devices(agent)).map((d) => d.id)).toEqual(['devA'])
    expect(ids.size).toBe(registered.length)

    agent.close()
  })

  it('does not replay the dead agent\'s geometry to a browser that joins next', async () => {
    // `handleSessionStart` replays `session:chrome` and `session:deviceInfo` the same way it replays
    // `device:ready`, and all three were measured by the process that just died. A viewer would
    // clear them itself a moment later with `device:boot`; an MCP-attached session never boots on
    // its own, so for it they would simply be wrong for as long as it lives.
    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browserA = await join(sessionId)
    first.agent.send(JSON.stringify({ type: 'session:chrome', sessionId, payload: { tag: 'old-agent' } }))
    first.agent.send(JSON.stringify({
      type: 'session:deviceInfo', sessionId, payload: { deviceName: 'stale', osVersion: '17.0' },
    }))
    await waitForType(browserA, 'session:deviceInfo')

    const second = await register([DEV_A])
    await waitForType(browserA, 'session:rebound')
    browserA.close()
    await barrier(second.agent)

    const browserB = await join(sessionId)
    await barrier(browserB)
    expect(await waitForTypeOrNull(browserB, 'session:chrome', 0)).toBeNull()
    expect(await waitForTypeOrNull(browserB, 'session:deviceInfo', 0)).toBeNull()

    first.agent.close(); second.agent.close(); browserB.close()
  })

  it('stops claiming the session is streaming', async () => {
    // `readySent` is what the `device:ready` replay keys off. Carried across a restart, a browser
    // joining just after would be handed a `device:ready` for a stream that died with the old
    // process — a frozen frame that looks live, which is the symptom #426 opened with.
    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browserA = await join(sessionId)
    first.agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'devA' } }))
    await waitForType(browserA, 'device:ready')

    const second = await register([DEV_A])
    await waitForType(browserA, 'session:rebound')
    browserA.close()

    // Re-join: the replay fires here if the relay still believes it announced a stream.
    const browserB = await join(sessionId)
    await barrier(browserB)
    expect(await waitForTypeOrNull(browserB, 'device:ready', 0)).toBeNull()

    first.agent.close(); second.agent.close(); browserB.close()
  })

  it('does not hold the new agent to the old one\'s resource reading', async () => {
    // `handleSessionStart` refuses a join when the agent's last resource report is over the
    // threshold, and an overloaded Mac is a common reason to restart an agent — so this pins that
    // restarting clears the refusal rather than inheriting it.
    //
    // What makes it pass is that resources are keyed by socket and every reader goes through
    // `session.agentSocket`, so re-pointing the session leaves the old reading behind on its own.
    // Deleting the old entry is a separate concern (a leak, see `rebind`) and mutating that line
    // away does not fail this test — measured, not assumed. Kept because the behaviour is worth
    // holding still whatever implements it.
    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    first.agent.send(JSON.stringify({
      type: 'agent:resources',
      resources: {
        cpuPercent: 99, memUsedMB: 15_000, memTotalMB: 16_000,
        slotsAvailable: 0, slotsTotal: 2, reportedAt: 1_754_000_000_000,
      },
    }))
    await barrier(first.agent)

    const refused = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(refused)
    refused.send(JSON.stringify({ type: 'session:start', sessionId }))
    expect((await waitForType<RelayMessage>(refused, 'error')).message).toBe('Agent resources exhausted')
    refused.close()

    const second = await register([DEV_A])
    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))

    await expect(waitForType(browser, 'session:joined')).resolves.toBeTruthy()

    first.agent.close(); second.agent.close(); browser.close()
  })

  it('forwards input to the restarted agent instead of answering for it', async () => {
    // A relay-side "the device is not ready" reply was written here and then removed: it was built
    // on the belief that a restarted agent knows nothing about the session until it is asked to
    // boot, and drops its input silently. That is false. The relay hands the new socket the kept
    // session id in `agent:registered`, and the agent seeds a device state for every pair it is
    // given (`IOSAgent.initDeviceStates`) — so `if (!state) break` never fires, and the agent
    // answers `input:error: input channel not ready` on its own.
    //
    // Answering here instead costs correctness twice over: `input:touch:start` is not a terminal
    // type, so it would still be forwarded while its `:end` was refused, leaving the device holding
    // a press that never lifts — and `run_flow` never boots at all, so its first `tapOn` would fail
    // on a device that is up and working. This pins the forwarding so none of that comes back.
    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)
    const second = await register([DEV_A])
    await waitForType(browser, 'session:rebound')

    browser.send(JSON.stringify({ type: 'input:touch:start', sessionId, payload: { x: 1, y: 1 } }))
    browser.send(JSON.stringify({ type: 'input:touch:end', sessionId, requestId: 'rq-rebind', payload: { x: 1, y: 1 } }))

    await expect(waitForType(second.agent, 'input:touch:start')).resolves.toBeTruthy()
    await expect(waitForType(second.agent, 'input:touch:end')).resolves.toBeTruthy()
    // Both halves of the gesture, and nothing invented on the session's behalf.
    expect(await waitForTypeOrNull(browser, 'input:error', 0)).toBeNull()

    first.agent.close(); second.agent.close(); browser.close()
  })
})
