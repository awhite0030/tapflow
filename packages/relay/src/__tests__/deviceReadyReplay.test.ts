import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import type { RelayMessage } from '../types'

const waitForOpen = (ws: WebSocket) =>
  new Promise<void>((resolve) => ws.once('open', resolve))

const waitForType = (ws: WebSocket, type: string) =>
  new Promise<RelayMessage>((resolve) => {
    const listener = (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === type) { ws.off('message', listener); resolve(msg) }
    }
    ws.on('message', listener)
  })

/** Null after `ms` instead of hanging — used to assert a message does *not* arrive. */
function typeOrTimeout(ws: WebSocket, type: string, ms = 800) {
  return new Promise<RelayMessage | null>((resolve) => {
    const timer = setTimeout(() => { ws.off('message', listener); resolve(null) }, ms)
    const listener = (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === type) { clearTimeout(timer); ws.off('message', listener); resolve(msg) }
    }
    ws.on('message', listener)
  })
}

// #440: the relay replays `device:ready` so a browser that reconnects mid-stream gets a picture
// without waiting for the next boot. The condition for that has to be "this session announced a
// stream", not "the device was up when the agent registered" — the relay opens a session for every
// device the agent reports, so a simulator someone left running had a session that looked ready
// before the agent had done anything with it.
describe('device:ready replay tracks the session, not the device (#440)', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-ready-replay-'))
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

  /** Registers one device and returns its session. `status` is what the agent reports to the relay
   *  at register time — 'booted' is an ordinary state for a simulator nobody shut down. */
  async function registerAgent(status: 'booted' | 'shutdown') {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register',
      devices: [{ id: 'devA', name: 'iPhone A', platform: 'ios', status }],
    }))
    const reply = await waitForType(agent, 'agent:registered')
    return { agent, sessionId: reply.registeredSessions![0]!.sessionId }
  }

  async function joinAs(sessionId: string) {
    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    const ready = typeOrTimeout(browser, 'device:ready')
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    return { browser, ready }
  }

  it('says nothing about readiness when the device merely happened to be running', async () => {
    const { agent, sessionId } = await registerAgent('booted')

    const { browser, ready } = await joinAs(sessionId)

    // Before this fix the viewer was told the device was ready here, with no stream behind it.
    expect(await ready).toBeNull()

    agent.close(); browser.close()
  })

  it('replays for a session that is actually streaming', async () => {
    // The reason replay exists: a Wi-Fi blip drops the browser socket mid-session, and the viewer
    // must not sit blank until the next boot. Without this case, deleting the replay outright
    // would pass the test above.
    const { agent, sessionId } = await registerAgent('shutdown')
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'devA' } }))
    await new Promise((r) => setTimeout(r, 50))

    const { browser, ready } = await joinAs(sessionId)

    const msg = await ready
    expect(msg).not.toBeNull()
    expect((msg!.payload as { deviceId: string }).deviceId).toBe('devA')

    agent.close(); browser.close()
  })

  it('stops replaying once the device is shut down', async () => {
    const { agent, sessionId } = await registerAgent('shutdown')
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'devA' } }))
    agent.send(JSON.stringify({ type: 'device:shutdown-done', sessionId, payload: { deviceId: 'devA' } }))
    await new Promise((r) => setTimeout(r, 50))

    const { browser, ready } = await joinAs(sessionId)

    expect(await ready).toBeNull()

    agent.close(); browser.close()
  })

  it('stops replaying while a reboot is in flight', async () => {
    // `device:booting` clears the cached chrome for the same reason: what was announced is being
    // torn down, and a browser joining now would be promised a stream that no longer exists.
    const { agent, sessionId } = await registerAgent('shutdown')
    agent.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: 'devA' } }))
    agent.send(JSON.stringify({ type: 'device:booting', sessionId }))
    await new Promise((r) => setTimeout(r, 50))

    const { browser, ready } = await joinAs(sessionId)

    expect(await ready).toBeNull()

    agent.close(); browser.close()
  })

  it('still reports the real device state in the device list', async () => {
    // `deviceStatus` answers a different question — "is this device up" — and the dashboard's
    // Booted badge and the REST guards both read it. Moving them onto the new flag would have made
    // every device look shut down.
    const { agent, sessionId } = await registerAgent('booted')

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'agents:list' }))
    const listed = await waitForType(browser, 'agents:listed')

    const device = listed.sessions![0]!.devices.find((d) => d.sessionId === sessionId)
    expect(device?.status).toBe('booted')

    agent.close(); browser.close()
  })
})
