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
      if (msg.type === type) {
        ws.off('message', listener)
        resolve(msg)
      }
    }
    ws.on('message', listener)
  })

describe('clipboard bridge relay routing', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-clipboard-test-'))
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

  afterEach(async () => {
    await server.stop()
  })

  async function setup() {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register',
      devices: [{ id: 'dev-1', name: 'iPhone', platform: 'ios', status: 'booted' }],
    }))
    const reply = await waitForType(agent, 'agent:registered')
    const sessionId = reply.registeredSessions![0].sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    return { agent, browser, sessionId }
  }

  it('forwards clipboard:read to the agent and clipboard:data back, preserving requestId', async () => {
    const { agent, browser, sessionId } = await setup()

    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === 'clipboard:read') {
        agent.send(JSON.stringify({
          type: 'clipboard:data',
          sessionId: msg.sessionId,
          requestId: msg.requestId,
          payload: { text: 'from the simulator' },
        }))
      }
    })

    browser.send(JSON.stringify({ type: 'clipboard:read', sessionId, requestId: 'req-1' }))
    const data = await waitForType(browser, 'clipboard:data')
    expect(data.requestId).toBe('req-1')
    expect((data.payload as { text: string }).text).toBe('from the simulator')

    agent.close()
    browser.close()
  })

  it('forwards clipboard:write with its text and returns clipboard:write-done', async () => {
    const { agent, browser, sessionId } = await setup()

    // Unicode must survive the JSON round trip untouched — the whole point of the bridge.
    const text = '한글 テスト 🎉\nline2\ttab'
    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === 'clipboard:write') {
        expect((msg.payload as { text: string }).text).toBe(text)
        agent.send(JSON.stringify({ type: 'clipboard:write-done', sessionId: msg.sessionId, requestId: msg.requestId }))
      }
    })

    browser.send(JSON.stringify({ type: 'clipboard:write', sessionId, requestId: 'req-2', payload: { text } }))
    const done = await waitForType(browser, 'clipboard:write-done')
    expect(done.requestId).toBe('req-2')

    agent.close()
    browser.close()
  })

  it('forwards clipboard:error from the agent back to the browser', async () => {
    const { agent, browser, sessionId } = await setup()

    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (msg.type === 'clipboard:read') {
        agent.send(JSON.stringify({
          type: 'clipboard:error', sessionId: msg.sessionId, requestId: msg.requestId, message: 'no booted device',
        }))
      }
    })

    browser.send(JSON.stringify({ type: 'clipboard:read', sessionId, requestId: 'req-3' }))
    const err = await waitForType(browser, 'clipboard:error')
    expect(err.requestId).toBe('req-3')
    expect(err.message).toBe('no booted device')

    agent.close()
    browser.close()
  })

  // H-F principle: an undeliverable request must fail loudly, not sit until the
  // caller's timeout — the browser needs to tell "agent gone" from "still working".
  it('replies clipboard:error when the agent is offline (read)', async () => {
    const { agent, browser, sessionId } = await setup()
    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed

    browser.send(JSON.stringify({ type: 'clipboard:read', sessionId, requestId: 'req-4' }))
    const raced = await Promise.race([
      waitForType(browser, 'clipboard:error'),
      new Promise<null>((r) => setTimeout(() => r(null), 1_000)),
    ])
    expect(raced).not.toBeNull()
    expect(raced!.requestId).toBe('req-4')
    expect(raced!.message).toBe('agent offline')

    browser.close()
  })

  it('replies clipboard:error when the agent is offline (write)', async () => {
    const { agent, browser, sessionId } = await setup()
    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed

    browser.send(JSON.stringify({ type: 'clipboard:write', sessionId, requestId: 'req-5', payload: { text: 'x' } }))
    const raced = await Promise.race([
      waitForType(browser, 'clipboard:error'),
      new Promise<null>((r) => setTimeout(() => r(null), 1_000)),
    ])
    expect(raced).not.toBeNull()
    expect(raced!.message).toBe('agent offline')

    browser.close()
  })

  // clipboard:data carries the simulator's clipboard, so a browser must never be able
  // to inject it — it is agent-authenticated, like ui:tree:response.
  it('ignores clipboard:data sent by a browser socket', async () => {
    const { agent, browser, sessionId } = await setup()

    const agentSaw: string[] = []
    agent.on('message', (d) => agentSaw.push((JSON.parse(d.toString()) as RelayMessage).type))

    browser.send(JSON.stringify({
      type: 'clipboard:data', sessionId, requestId: 'spoof', payload: { text: 'injected' },
    }))
    await new Promise((r) => setTimeout(r, 100))
    expect(agentSaw).not.toContain('clipboard:data')

    agent.close()
    browser.close()
  })
})
