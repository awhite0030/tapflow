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
// died on a timeout pointing at the assertion. These cases pin the property that replaces it —
// without them the package is a refactor with nothing holding its claim.
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

  it('finds a message that arrived before it was asked for', async () => {
    const ws = await connected()

    ws.send(JSON.stringify({ type: 'agents:list' }))
    // Round-trip on something else first, so the reply is definitely in already. This is the
    // ordering that used to lose it.
    await barrier(ws)

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
    await barrier(ws)

    const first = await waitForType(ws, 'agents:listed')
    const second = await waitForTypeOrNull(ws, 'agents:listed', 500)

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)

    ws.close()
  })

  it('reports absence without waiting out the clock', async () => {
    const ws = await connected()
    await barrier(ws)

    const started = process.hrtime.bigint()
    const missing = await waitForTypeOrNull(ws, 'device:ready', 0)
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    expect(missing).toBeNull()
    // The barrier is what makes 0 a valid budget: everything the relay was going to send has been
    // sent. A test that needs a real timeout here has not established anything.
    expect(elapsedMs).toBeLessThan(100)

    ws.close()
  })

  it('waitForMessage takes the oldest unclaimed message', async () => {
    const ws = await connected()

    ws.send(JSON.stringify({ type: 'agents:list' }))
    await barrier(ws)

    await expect(waitForMessage(ws)).resolves.toMatchObject({ type: 'agents:listed' })

    ws.close()
  })
})
