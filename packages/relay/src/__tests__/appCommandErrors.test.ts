import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import type { RelayMessage } from '../types'
import { waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'


// #445: every failure of app:install / app:launch has to reach the caller, carrying the sessionId
// it was asked about. A dashboard viewer holds one session per socket so an unattributed error
// still lands somewhere sensible; an MCP caller waits for its own sessionId and cannot tell an
// unattributed error from silence. The worst of the three paths sent nothing at all.
describe('app command failures reach the caller (#445)', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-app-errors-test-'))
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

  async function connectAgentAndBrowser() {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register',
      devices: [{ id: 'dev-1', name: 'iPhone', platform: 'ios', status: 'booted' }],
    }))
    const reply = await waitForType<RelayMessage>(agent, 'agent:registered')
    const sessionId = reply.registeredSessions![0]!.sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    return { agent, browser, sessionId }
  }

  /** Blocks until the relay stops offering the agent's devices.
   *
   *  Nothing orders that against the browser's next request, and without this the same request
   *  answers differently depending on which won — measured at roughly 1 run in 10, which is exactly
   *  the kind of flake that gets a real assertion deleted instead of fixed.
   *
   *  It watches `agents:list`, which filters on the socket's `readyState` — so it flips at
   *  close-frame time, strictly earlier than the relay's close handler runs. That is enough here
   *  because the assertion below keys off the same `readyState`, but it is NOT a barrier for
   *  anything that needs the sessions to have been held or evicted. */
  async function untilAgentLeavesTheList(browser: WebSocket) {
    await vi.waitFor(async () => {
      const listed = waitForType(browser, 'agents:listed')
      browser.send(JSON.stringify({ type: 'agents:list' }))
      expect((await listed).sessions ?? []).toHaveLength(0)
    }, { timeout: 2000 })
  }

  function insertBuild(bundleId: string | null): number {
    const db = getDb()
    const key = `com.example.${Math.abs(Number(process.hrtime.bigint() % 100000n))}`
    db.prepare(`INSERT INTO apps (name, bundle_id_key, platform) VALUES ('Demo', ?, 'ios')`).run(key)
    const app = db.prepare('SELECT id FROM apps WHERE bundle_id_key = ?').get(key) as { id: number }
    const r = db.prepare(`
      INSERT INTO builds (app_id, version_name, build_number, bundle_id, file_path)
      VALUES (?, '1.0.0', '1', ?, '/tmp/demo.app')
    `).run(app.id, bundleId)
    return Number(r.lastInsertRowid)
  }

  it('answers an unknown session with an app-specific error, not a generic one', async () => {
    const { agent, browser } = await connectAgentAndBrowser()

    browser.send(JSON.stringify({ type: 'app:install', sessionId: 'no-such-session', buildId: 1 }))
    // A generic `error` cannot be correlated by construction — the caller cannot tell whose
    // request it answers, so it keeps waiting.
    const msg = await waitForTypeOrNull(browser, 'app:install-error')

    expect(msg?.type).toBe('app:install-error')
    expect(msg?.sessionId).toBe('no-such-session')

    agent.close(); browser.close()
  })

  it('carries the sessionId when the build is missing', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()

    browser.send(JSON.stringify({ type: 'app:install', sessionId, buildId: 999999 }))
    const msg = await waitForType(browser, 'app:install-error')

    expect(msg.message).toBe('Build not found')
    expect(msg.sessionId).toBe(sessionId)

    agent.close(); browser.close()
  })

  it('carries the sessionId when the build has no bundle id', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()
    const buildId = insertBuild(null)

    browser.send(JSON.stringify({ type: 'app:launch', sessionId, buildId }))
    const msg = await waitForType(browser, 'app:launch-error')

    expect(msg.message).toBe('Bundle ID not available for this build')
    expect(msg.sessionId).toBe(sessionId)

    agent.close(); browser.close()
  })

  // Losing the agent takes the session with it — the relay drops every session that agent owned —
  // so this arrives as `Session not found` rather than `agent offline`. Which of the two strings it
  // is does not matter to the caller; what matters is that something arrives, promptly, wearing the
  // sessionId that was asked about. Before this change the caller got a `type: 'error'` it could
  // not attribute, and waited out its deadline instead.
  it('answers promptly and correlatably after the agent disappears — install', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()
    const buildId = insertBuild('com.example.demo')

    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed

    browser.send(JSON.stringify({ type: 'app:install', sessionId, buildId }))
    const msg = await waitForTypeOrNull(browser, 'app:install-error')

    expect(msg?.type).toBe('app:install-error')
    expect(msg?.sessionId).toBe(sessionId)

    browser.close()
  })

  it('answers promptly and correlatably after the agent disappears — launch', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()
    const buildId = insertBuild('com.example.demo')

    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed

    browser.send(JSON.stringify({ type: 'app:launch', sessionId, buildId }))
    const msg = await waitForTypeOrNull(browser, 'app:launch-error')

    expect(msg?.type).toBe('app:launch-error')
    expect(msg?.sessionId).toBe(sessionId)

    browser.close()
  })

  it('answers a boot the agent will never receive', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()

    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed
    await untilAgentLeavesTheList(browser)

    browser.send(JSON.stringify({ type: 'device:boot', sessionId, payload: { deviceId: 'dev-1' } }))
    // Without this the viewer sits on "Waiting for first frame…" with nothing said.
    const msg = await waitForTypeOrNull(browser, 'device:boot-error')

    expect(msg).not.toBeNull()
    expect(msg!.sessionId).toBe(sessionId)
    // The session outlives its agent's socket now (#426), so this really is a live session with a
    // dead socket and `agent offline` is the accurate half of that pair. It used to be
    // `Session not found`, which was accurate then and would be misleading now — the id is valid,
    // and an MCP caller retrying it in a second may well succeed.
    //
    // The other half — an id that is genuinely gone, after the hold expires — is covered in
    // `agentReconnectGrace.test.ts`, where the window is short enough to wait out.
    expect(msg!.message).toBe('agent offline')

    browser.close()
  })

  // A missing or non-numeric buildId reaches the DB query unvalidated (#444 is open on inbound
  // validation generally). better-sqlite3 treats both as "no row" rather than throwing, so the
  // caller still gets a correlated answer instead of an exception killing the handler — which is
  // the property this PR is about. The message is imprecise, not absent.
  it.each([
    ['no buildId', undefined],
    ['a non-numeric buildId', 'abc'],
  ])('answers %s without going silent', async (_label, buildId) => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()

    browser.send(JSON.stringify({ type: 'app:install', sessionId, buildId }))
    const msg = await waitForTypeOrNull(browser, 'app:install-error')

    expect(msg?.type).toBe('app:install-error')
    expect(msg?.sessionId).toBe(sessionId)

    agent.close(); browser.close()
  })

  // `JSON.parse` does not honour the `RelayMessage` type, so buildId arrives as whatever was sent.
  // An object or array makes better-sqlite3 throw, and that exception used to be caught by the
  // message loop alongside genuine parse failures — the caller got nothing at all. This is the
  // same silence the rest of the file is about, reached through the type system's blind spot.
  it.each([
    ['an object', {}],
    ['an array', []],
    ['a populated object', { a: 1 }],
  ])('answers a buildId that is %s', async (_label, buildId) => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()

    browser.send(JSON.stringify({ type: 'app:install', sessionId, buildId }))
    const msg = await waitForTypeOrNull(browser, 'app:install-error')

    expect(msg?.type).toBe('app:install-error')
    expect(msg?.sessionId).toBe(sessionId)

    agent.close(); browser.close()
  })

  it('answers an object buildId on the launch path too', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()

    browser.send(JSON.stringify({ type: 'app:launch', sessionId, buildId: {} }))
    const msg = await waitForTypeOrNull(browser, 'app:launch-error')

    expect(msg?.type).toBe('app:launch-error')
    expect(msg?.sessionId).toBe(sessionId)

    agent.close(); browser.close()
  })

  // `JSON.parse` accepts bare `null`, numbers and strings without throwing, so a payload that is
  // valid JSON but not a message still reaches the routing path. Splitting the parse and route
  // catches — which is what stops a handler throw from vanishing — meant the error branch started
  // reading `.type` off those, raising an unhandled TypeError out of the socket callback. The
  // silence fix must not become a crash.
  it.each(['null', '123', '"str"', 'true'])('survives a bare %s payload', async (raw) => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()

    browser.send(raw)
    // Still serving afterwards is the assertion: a thrown TypeError here would surface as an
    // unhandled error and, in production, take the process with it.
    browser.send(JSON.stringify({ type: 'app:install', sessionId, buildId: 999999 }))
    const msg = await waitForTypeOrNull(browser, 'app:install-error')

    expect(msg?.type).toBe('app:install-error')

    agent.close(); browser.close()
  })

  // `bootDevice` is the first call an MCP caller makes, so a stale session id reported as a dead
  // Mac sends the reader after the wrong problem. An id that was never real is the case where the
  // distinction is decidable — no teardown to race against.
  it('calls an unknown session by its name, not a dead agent', async () => {
    const { agent, browser } = await connectAgentAndBrowser()

    browser.send(JSON.stringify({
      type: 'device:boot', sessionId: 'no-such-session', payload: { deviceId: 'dev-1' },
    }))
    const msg = await waitForTypeOrNull(browser, 'device:boot-error')

    expect(msg?.message).toBe('Session not found')
    expect(msg?.sessionId).toBe('no-such-session')

    agent.close(); browser.close()
  })

  it('still forwards a valid install to the agent', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()
    const buildId = insertBuild('com.example.demo')

    browser.send(JSON.stringify({ type: 'app:install', sessionId, buildId }))
    // The error paths are only correct if the success path is untouched.
    const forwarded = await waitForType(agent, 'app:install')

    expect(forwarded.sessionId).toBe(sessionId)
    expect((forwarded.payload as { filePath: string }).filePath).toBe('/tmp/demo.app')

    agent.close(); browser.close()
  })
})
