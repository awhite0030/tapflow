import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import type { RelayMessage } from '../types'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'


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
    const reply = await waitForType<RelayMessage>(agent, 'agent:registered')
    const sessionId = reply.registeredSessions![0].sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    return { agent, browser, sessionId }
  }

  // The whole gate rests on this hop: an agent advertises what it implements, and the viewer
  // is told before it sends anything. Without it the dashboard would be back to inferring
  // support from silence, which cannot distinguish an old agent from a slow one.
  it('echoes the agent capabilities on session:joined', async () => {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register',
      capabilities: ['clipboard'],
      devices: [{ id: 'dev-1', name: 'iPhone', platform: 'ios', status: 'booted' }],
    }))
    const reply = await waitForType<RelayMessage>(agent, 'agent:registered')
    const sessionId = reply.registeredSessions![0].sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    const joined = await waitForType(browser, 'session:joined')
    expect((joined as unknown as { capabilities: string[] }).capabilities).toEqual(['clipboard'])

    agent.close(); browser.close()
  })

  // An agent that predates the field omits it. Absent must mean "not supported", not "unknown" —
  // that is what lets the viewer degrade deliberately instead of guessing.
  it('reports an empty capability list for an agent that advertises none', async () => {
    const { agent, browser, sessionId } = await setup()   // registers without capabilities
    browser.close()

    const b2 = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(b2)
    b2.send(JSON.stringify({ type: 'session:start', sessionId }))
    const joined = await waitForType(b2, 'session:joined')
    expect((joined as unknown as { capabilities: string[] }).capabilities).toEqual([])

    agent.close(); b2.close()
  })

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

  // clipboard:data lands on the viewer's host OS clipboard, so injection is the thing
  // to guard. Assert on what the VICTIM BROWSER receives — asserting that the agent
  // socket saw nothing would pass even with the protection removed.
  it('a browser socket cannot inject clipboard:data into its own viewer', async () => {
    const { agent, browser, sessionId } = await setup()

    const got: RelayMessage[] = []
    browser.on('message', (d) => got.push(JSON.parse(d.toString()) as RelayMessage))
    const closed = new Promise<number>((r) => browser.on('close', (code) => r(code)))

    browser.send(JSON.stringify({
      type: 'clipboard:data', sessionId, requestId: 'spoof', payload: { text: 'injected' },
    }))
    // an agent-only type from a browser role is a protocol violation → 1008
    const code = await Promise.race([closed, new Promise<number>((r) => setTimeout(() => r(0), 1_000))])
    expect(code).toBe(1008)
    expect(got.filter((m) => m.type === 'clipboard:data')).toEqual([])

    agent.close()
  })

  // A second agent (another Mac on the same relay, or any holder of an agent PAT) must
  // not be able to address a session it does not own — agents:list hands out every id.
  it('another agent cannot inject clipboard:data into someone else\'s session', async () => {
    const { agent, browser, sessionId } = await setup()

    const rogue = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(rogue)
    rogue.send(JSON.stringify({
      type: 'agent:register',
      devices: [{ id: 'rogue-1', name: 'Rogue', platform: 'ios', status: 'booted' }],
    }))
    await waitForType(rogue, 'agent:registered')

    const got: RelayMessage[] = []
    browser.on('message', (d) => got.push(JSON.parse(d.toString()) as RelayMessage))

    rogue.send(JSON.stringify({
      type: 'clipboard:data', sessionId, requestId: 'clip-1', payload: { text: 'ATTACKER' },
    }))
    await new Promise((r) => setTimeout(r, 200))
    expect(got.filter((m) => m.type === 'clipboard:data')).toEqual([])

    // and the session's own agent still gets through, so the guard is not just "drop everything"
    agent.send(JSON.stringify({
      type: 'clipboard:data', sessionId, requestId: 'clip-1', payload: { text: 'legit' },
    }))
    const data = await waitForType(browser, 'clipboard:data')
    expect((data.payload as { text: string }).text).toBe('legit')

    rogue.close(); agent.close(); browser.close()
  })

  it('drops a clipboard:read whose correlator is an empty string', async () => {
    // Clipboard is not part of the correlation layer's pair set — it has carried a required `requestId`
    // since it was written — but the relay answered an id-less request with `requestId: msg.requestId!`,
    // which is a **write into an outbound frame**: `JSON.stringify` erases the absent key and ships a
    // `clipboard:error` whose required correlator is missing, which `useClipboardBridge` discards on
    // `if (!msg.requestId) return`. So "agent offline" became the caller waiting out its budget. The same
    // defect was removed for `open-url`; this pins the door check that stops it here.
    //
    // The agent socket is closed first so the request would otherwise take the answering branch — the one
    // that used to produce the invalid frame.
    const { agent, browser, sessionId } = await setup()
    // Awaiting the close *event*, not a browser round-trip. A barrier on the browser proves the relay
    // processed something sent on the browser — it says nothing about the relay having seen the agent go,
    // and until it has, an ungated request is forwarded to a still-open socket and no error is produced.
    // The test would then pass with the gate removed. `appCommandErrors.test.ts` uses this same form.
    const gone = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await gone
    await barrier(browser)

    browser.send(JSON.stringify({ type: 'clipboard:read', sessionId, requestId: '' }))
    await barrier(browser)
    expect(await waitForTypeOrNull(browser, 'clipboard:error', 0)).toBeNull()

    browser.close()
  })
})
