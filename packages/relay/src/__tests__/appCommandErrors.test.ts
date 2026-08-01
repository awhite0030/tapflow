import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
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

/** Resolves to the first message of any of `types`, or to null after `ms`. Used to assert that a
 *  reply arrives *promptly* — the defect under test is a caller waiting out its whole deadline. */
function firstOfOrTimeout(ws: WebSocket, types: string[], ms = 1000) {
  return new Promise<RelayMessage | null>((resolve) => {
    const timer = setTimeout(() => { ws.off('message', listener); resolve(null) }, ms)
    const listener = (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as RelayMessage
      if (types.includes(msg.type)) {
        clearTimeout(timer)
        ws.off('message', listener)
        resolve(msg)
      }
    }
    ws.on('message', listener)
  })
}

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
    const reply = await waitForType(agent, 'agent:registered')
    const sessionId = reply.registeredSessions![0]!.sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    return { agent, browser, sessionId }
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
    const msg = await firstOfOrTimeout(browser, ['app:install-error', 'error'])

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
    const msg = await firstOfOrTimeout(browser, ['app:install-error', 'error'])

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
    const msg = await firstOfOrTimeout(browser, ['app:launch-error', 'error'])

    expect(msg?.type).toBe('app:launch-error')
    expect(msg?.sessionId).toBe(sessionId)

    browser.close()
  })

  it('answers a boot the agent will never receive', async () => {
    const { agent, browser, sessionId } = await connectAgentAndBrowser()

    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed

    browser.send(JSON.stringify({ type: 'device:boot', sessionId, payload: { deviceId: 'dev-1' } }))
    // Without this the viewer sits on "Waiting for first frame…" with nothing said.
    const msg = await firstOfOrTimeout(browser, ['device:boot-error'])

    expect(msg).not.toBeNull()
    expect(msg!.sessionId).toBe(sessionId)
    // Losing the agent takes its sessions with it, so this is a missing session — not a live
    // session with a dead socket. Saying "agent offline" here would point an MCP caller at the
    // wrong problem on the very first call it makes.
    expect(msg!.message).toBe('Session not found')

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
    const msg = await firstOfOrTimeout(browser, ['app:install-error', 'error'])

    expect(msg?.type).toBe('app:install-error')
    expect(msg?.sessionId).toBe(sessionId)

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
