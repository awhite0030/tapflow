import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import { waitForOpen, waitForType, waitForMessage, waitForTypeOrNull, barrier } from '@tapflowio/test-utils'

// The helpers in @tapflowio/test-utils exist to remove one specific failure: asking for a reply
// after it has already arrived. The old shape (`ws.once('message')`) lost it silently and the test
// died on a timeout pointing at the assertion. These cases pin the property that replaces it.
//
// None of them use `barrier` to establish "has already arrived" — barrier is one of the things
// under test, and using it here would let a broken barrier prove itself. Ordering comes from the
// socket instead: an invalid `session:start` is answered with `error`, and WebSocket preserves
// order within a connection, so once that reply lands anything sent before it has landed too.
describe('socket test helpers are order-proof (#452)', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-socket-helpers-'))
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

  async function connected() {
    const ws = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(ws)
    return ws
  }

  /** Sends a request that is answered with `error`, and waits for it. Anything sent earlier on
   *  this socket has arrived by the time it resolves. */
  async function sentinel(ws: WebSocket): Promise<void> {
    ws.send(JSON.stringify({ type: 'session:start', sessionId: 'no-such-session' }))
    await waitForType(ws, 'error')
  }

  it('finds a message that arrived before it was asked for', async () => {
    const ws = await connected()

    ws.send(JSON.stringify({ type: 'agents:list' }))
    await sentinel(ws) // the agents:listed is now definitely in

    await expect(waitForType(ws, 'agents:listed')).resolves.toMatchObject({ type: 'agents:listed' })

    ws.close()
  })

  it('still waits for one that has not arrived yet', async () => {
    const ws = await connected()

    const pending = waitForType(ws, 'agents:listed')
    ws.send(JSON.stringify({ type: 'agents:list' }))

    await expect(pending).resolves.toMatchObject({ type: 'agents:listed' })

    ws.close()
  })

  it('hands two waits for one type two different messages', async () => {
    // Matched messages leave the recording. Without that, a second wait would be answered by the
    // first message and a test could pass without the second one ever being sent.
    const ws = await connected()

    ws.send(JSON.stringify({ type: 'agents:list' }))
    ws.send(JSON.stringify({ type: 'agents:list' }))
    await sentinel(ws)

    const first = await waitForTypeOrNull(ws, 'agents:listed', 0)
    const second = await waitForTypeOrNull(ws, 'agents:listed', 0)

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)

    ws.close()
  })

  it('reports absence from the recording, without a live message to find', async () => {
    const ws = await connected()
    await sentinel(ws)

    // Budget 0: the sentinel proves the relay has answered everything sent so far, so anything
    // absent from the recording is absent, full stop. A test that needs a real timeout here has
    // established nothing about what the relay did.
    expect(await waitForTypeOrNull(ws, 'device:ready', 0)).toBeNull()

    ws.close()
  })

  it('waitForMessage takes the oldest unclaimed message', async () => {
    const ws = await connected()

    ws.send(JSON.stringify({ type: 'agents:list' }))
    await sentinel(ws)

    // agents:listed was sent first, so it is what comes out — not the sentinel's error, which is
    // already consumed, and not whichever arrives next.
    await expect(waitForMessage(ws)).resolves.toMatchObject({ type: 'agents:listed' })

    ws.close()
  })

  it('barrier waits for its own reply, not one already in the recording', async () => {
    // barrier registers a waiter before sending and never reads the queue. Reading the queue would
    // let it return on an `agents:listed` a test had queued earlier — no round-trip, nothing
    // proven, and the test's own message eaten.
    //
    // Registering an agent between the two requests is what makes that visible: the queued reply
    // lists no sessions, barrier's own reply lists one. Counting messages cannot tell the two
    // apart, because a barrier that eats the first still leaves its own behind.
    const ws = await connected()

    ws.send(JSON.stringify({ type: 'agents:list' }))
    await sentinel(ws)

    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: 'socketHelpers-1',
      devices: [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }],
    }))
    await waitForType(agent, 'agent:registered')

    await barrier(ws)

    const queued = await waitForTypeOrNull(ws, 'agents:listed', 0)
    expect(queued).not.toBeNull()
    // The one from before the agent existed. A barrier that took it would leave its own reply
    // here, which lists the agent.
    expect(queued!.sessions ?? []).toHaveLength(0)

    agent.close(); ws.close()
  })

  it('rejects instead of hanging when the socket cannot connect', async () => {
    // Port 1 is not listening. Without the error branch this waits out the suite timeout and the
    // failure names the assertion rather than the connection.
    const ws = new WebSocket('ws://127.0.0.1:1')
    await expect(waitForOpen(ws)).rejects.toThrow()
  })
})
