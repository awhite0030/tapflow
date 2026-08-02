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

  async function join(sessionId: string) {
    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    return browser
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

  it('survives the old socket closing afterwards', async () => {
    // The index move has an order requirement. Reassign `session.agentSocket` first and the id is
    // deleted from the *new* socket's set while the old one keeps it — so this close, which fires
    // late after an unclean drop, evicts the session that was just re-pointed. The relay terminates
    // the old socket itself, so this is the ordinary path, not an exotic one.
    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)

    const second = await register([DEV_A])
    await waitForType(browser, 'session:rebound')
    first.agent.close()
    // Round-trip the new socket: the close above is processed in order relative to this reply.
    await barrier(second.agent)

    expect((await devices(second.agent)).map((d) => d.id)).toEqual(['devA'])
    expect(await waitForTypeOrNull(browser, 'session:terminated', 0)).toBeNull()

    first.agent.close(); second.agent.close(); browser.close()
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
    // restart is likely to change — and `session:joined` is sent once, so the viewer has no other
    // way to learn the new set. The device's own reported state comes across too: left at the old
    // value, a device that came back down would still read `booted` to the REST guards.
    const first = await register([DEV_A], ['clipboard'])
    const browser = await join(first.byDevice.get('devA')!)

    const second = await register([{ ...DEV_A, name: 'iPhone A (renamed)', status: 'shutdown' }], ['clipboard', 'audio'])

    const rebound = await waitForType<RelayMessage>(browser, 'session:rebound')
    expect(rebound.capabilities).toEqual(['clipboard', 'audio'])
    const [devA] = await devices(second.agent)
    expect(devA!.status).toBe('shutdown')
    expect(devA!.name).toBe('iPhone A (renamed)')

    first.agent.close(); second.agent.close(); browser.close()
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

  it('answers a terminal input the restarted agent would have dropped', async () => {
    // The new process holds no device state for this session until it is asked to boot, and an
    // input for a session it does not know is dropped with no ack at all
    // (`IOSAgent.handleRelayMessage`: `if (!state) break`). The socket is open and healthy, so the
    // relay's "agent offline" branch does not fire either — the caller just waits, and the MCP
    // client turns that wait into a reported success.
    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)
    browser.send(JSON.stringify({ type: 'device:boot', sessionId, payload: { deviceId: 'devA' } }))
    await barrier(browser)

    const second = await register([DEV_A])
    await waitForType(browser, 'session:rebound')

    browser.send(JSON.stringify({ type: 'input:touch:end', sessionId, payload: { x: 1, y: 1 } }))

    const err = await waitForType<RelayMessage>(browser, 'input:error')
    expect(err.message).toBe('device not ready')
    // ...and the new agent was not sent an input it would have thrown away.
    expect(await waitForTypeOrNull(second.agent, 'input:touch:end', 0)).toBeNull()

    first.agent.close(); second.agent.close(); browser.close()
  })

  it('goes back to forwarding input once the device is asked for again', async () => {
    // The scope of the answer above is "this agent has not been asked to boot this session". If it
    // outlived the rebind it would suppress input for the rest of the session.
    const first = await register([DEV_A])
    const sessionId = first.byDevice.get('devA')!
    const browser = await join(sessionId)
    const second = await register([DEV_A])
    await waitForType(browser, 'session:rebound')

    browser.send(JSON.stringify({ type: 'device:boot', sessionId, payload: { deviceId: 'devA' } }))
    await waitForType(second.agent, 'device:boot')
    browser.send(JSON.stringify({ type: 'input:touch:end', sessionId, payload: { x: 1, y: 1 } }))

    await expect(waitForType(second.agent, 'input:touch:end')).resolves.toBeTruthy()
    expect(await waitForTypeOrNull(browser, 'input:error', 0)).toBeNull()

    first.agent.close(); second.agent.close(); browser.close()
  })
})
