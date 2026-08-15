import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import { waitForOpen, waitForType } from '@tapflowio/test-utils'

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-rejectlog-test-'))
  initDb(path.join(tmpDir, 'test.db'))
})

afterAll(() => {
  closeDb()
  fs.rmSync(tmpDir, { recursive: true })
})

describe('the rejection log is throttled per socket', () => {
  // **A first draft wrote one line per rejected frame.** That is the unbounded, attacker-driven log
  // volume this relay already refuses at `forwardUnacked`, with the reason written beside it — a
  // viewer with devtools open can send malformed frames at gesture rate.
  //
  // The obvious fix is a module-level timestamp, and it breaks the thing the log is for: one noisy
  // socket would swallow the *first* bad frame from another, which is the skewed-client case
  // (`mcp-server` upgraded without the relay) the diagnostic exists to surface. So the state is keyed
  // by socket, and `a second socket still gets its first line` is the assertion that says so — it is
  // the only one a global throttle fails.
  let server: RelayServer
  let port: number
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    server = new RelayServer({ port: 0 })
    await server.start()
    port = (server.address() as { port: number }).port
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    warn.mockRestore()
    await server.stop()
  })

  const mismatches = (): string[] =>
    warn.mock.calls.flat().filter((c: unknown): c is string => typeof c === 'string' && c.includes('does not match the contract'))

  /** A socket that has sent `n` malformed frames and waited for the relay to have handled them. */
  async function spam(n: number): Promise<WebSocket> {
    const ws = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(ws)
    for (let i = 0; i < n; i++) {
      ws.send(JSON.stringify({ type: 'session:start', sessionId: 7 }))
    }
    // A round-trip proves the relay has finished with everything sent before it — an answer rather
    // than a sleep, which is what `barrier` exists for in this repo's socket helpers.
    ws.send(JSON.stringify({ type: 'agents:list' }))
    await waitForType(ws, 'agents:listed')
    return ws
  }

  it('writes the first rejection and suppresses the burst behind it', async () => {
    const ws = await spam(40)
    expect(mismatches()).toHaveLength(1)
    expect(mismatches()[0]).toContain('session:start')
    ws.close()
  })

  it('a second socket still gets its first line', async () => {
    const a = await spam(20)
    const b = await spam(20)
    // Two sockets, two first lines. A shared timestamp gives one.
    expect(mismatches()).toHaveLength(2)
    a.close()
    b.close()
  })

  it('says how many it swallowed when the next one is written', async () => {
    const ws = await spam(5)
    vi.setSystemTime(Date.now() + 2_000)
    try {
      ws.send(JSON.stringify({ type: 'session:start', sessionId: 7 }))
      ws.send(JSON.stringify({ type: 'agents:list' }))
      await waitForType(ws, 'agents:listed')
      const lines = mismatches()
      expect(lines).toHaveLength(2)
      expect(lines[1]).toMatch(/\+4 more from this socket/)
    } finally {
      vi.useRealTimers()
      ws.close()
    }
  })
})
