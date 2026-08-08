import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import type { RelayMessage } from '../types'
import { waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'

// #492. The relay answers a terminal input it cannot dispatch, and it was the last producer of
// `input:error` sending no `reason` — while being the one that knows the answer with the most
// certainty, since it is looking at the socket rather than inferring from its own state.
//
// Two situations reach that reply and only one is the agent's fault, so the prose split matters too:
// a session held with a closed socket really is an absent agent, but no session at all can mean an
// evicted id in front of a perfectly healthy agent.
describe('input:error from the relay carries a reason (#492)', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-input-reason-test-'))
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

  async function joinedSession() {
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

  /** Leaves the session in the relay with a socket that is no longer open — the reconnect grace holds
   *  the id, which is what makes this the branch where "the agent is gone" is the true statement. */
  async function agentGone() {
    const { agent, browser, sessionId } = await joinedSession()
    const closed = new Promise<void>((r) => agent.on('close', () => r()))
    agent.close()
    await closed
    return { browser, sessionId }
  }

  const terminals: Array<[string, Record<string, unknown>]> = [
    ['input:touch:end', { x: 0.5, y: 0.5 }],
    ['input:pinch:end', { f0: { x: 0.4, y: 0.4 }, f1: { x: 0.6, y: 0.6 } }],
    ['input:key', { code: 'KeyA' }],
    ['input:button', { name: 'home' }],
  ]

  for (const [type, payload] of terminals) {
    it(`answers ${type} with reason channel-unavailable when the agent's socket is gone`, async () => {
      const { browser, sessionId } = await agentGone()

      browser.send(JSON.stringify({ type, sessionId, payload }))
      // By type, not "the next message": losing the agent also produces a `session:terminated` and
      // whichever lands first is not this test's subject.
      const err = await waitForType(browser, 'input:error')
      expect(err.sessionId).toBe(sessionId)
      expect(err.reason).toBe('channel-unavailable')
      expect(err.message).toBe('agent offline')

      browser.close()
    })
  }

  // The other branch. `agent offline` was a wrong diagnosis here — the relay has no session for this
  // id, which says nothing about any agent's health — and `device:boot` already answered this pair
  // with these two strings before this change.
  it('says the session is not found, rather than blaming an agent, for an unknown session', async () => {
    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)

    browser.send(JSON.stringify({
      type: 'input:touch:end', sessionId: 'no-such-session', payload: { x: 0.5, y: 0.5 },
    }))
    const err = await waitForType(browser, 'input:error')
    expect(err.sessionId).toBe('no-such-session')
    expect(err.reason).toBe('channel-unavailable')
    expect(err.message).toBe('Session not found')
    expect(err.message).not.toBe('agent offline')

    browser.close()
  })

  // The reason is deliberately the same for both branches: the set is derived from what a consumer
  // must do differently, and a reconnect or re-join answers both. Pinning the equality keeps a future
  // change from splitting the wire vocabulary when only the wording needed to differ.
  it('uses one reason for both branches while the wording differs', async () => {
    const { browser, sessionId } = await agentGone()

    browser.send(JSON.stringify({ type: 'input:touch:end', sessionId, payload: { x: 0.5, y: 0.5 } }))
    const held = await waitForType(browser, 'input:error')

    browser.send(JSON.stringify({ type: 'input:touch:end', sessionId: 'nope', payload: { x: 0.5, y: 0.5 } }))
    const unknown = await waitForType(browser, 'input:error')

    // Named, not merely equal: two absent reasons are also equal, and that is the state this whole
    // change exists to end.
    expect(held.reason).toBe('channel-unavailable')
    expect(held.reason).toBe(unknown.reason)
    expect(held.message).not.toBe(unknown.message)

    browser.close()
  })

  // This change adds a field to an existing reply; it does not widen what gets answered. A move has
  // no caller waiting on it, and inventing a reply for one would grow the surface the terminal-only
  // set exists to bound.
  it('still answers nothing for a non-terminal input', async () => {
    const { browser, sessionId } = await agentGone()

    browser.send(JSON.stringify({ type: 'input:touch:move', sessionId, payload: { x: 0.5, y: 0.5 } }))
    expect(await waitForTypeOrNull(browser, 'input:error', 100)).toBeNull()

    browser.close()
  })
})
