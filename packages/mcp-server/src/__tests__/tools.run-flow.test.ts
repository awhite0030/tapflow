import { describe, it, expect, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTools } from '../tools.js'
import type { TapflowClient } from '../client.js'
import { TransientQueryError } from '@tapflowio/flow-runner'

type ToolResult = { content: unknown[]; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>

// Capture the tool handlers registered by registerTools so we can invoke run_flow directly.
function captureTools(client: TapflowClient): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => { handlers.set(name, handler) },
  }
  registerTools(server as unknown as McpServer, client)
  return handlers
}

function fakeClient(calls: string[]): TapflowClient {
  return {
    installApp: vi.fn(async () => { calls.push('install') }),
    launchApp: vi.fn(async () => { calls.push('launch') }),
    clearState: vi.fn(async () => { calls.push('clearState') }),
    queryUITree: vi.fn(async () => []),
    screenshot: vi.fn(async () => Buffer.from('')),
    tap: vi.fn(),
    swipe: vi.fn(async () => {}),
    typeText: vi.fn(async () => {}),
    pressKey: vi.fn(),
    openUrl: vi.fn(async () => {}),
  } as unknown as TapflowClient
}

describe('run_flow — install before replay', () => {
  const runFlowHandler = (client: TapflowClient) => captureTools(client).get('run_flow') as Handler

  it('installs buildId before running the flow (default)', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    const res = await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - launchApp\n', buildId: 5 })
    expect(res.isError).toBeFalsy()
    expect(client.installApp).toHaveBeenCalledWith('s1', 5)
    expect(calls).toEqual(['install', 'launch']) // install strictly before the launchApp step
  })

  it('install:false skips the install but still launches', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - launchApp\n', buildId: 5, install: false })
    expect(client.installApp).not.toHaveBeenCalled()
    expect(calls).toEqual(['launch'])
  })

  it('no buildId → nothing to install', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - clearState: com.example.app\n' })
    expect(client.installApp).not.toHaveBeenCalled()
    expect(calls).toEqual(['clearState'])
  })

  it('passes the engine selector deadline signal to the client', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    vi.mocked(client.queryUITree).mockImplementation(async (_sessionId, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      return [{
        role: 'button',
        label: 'OK',
        frame: { x: 0, y: 0, width: 1, height: 1 },
        enabled: true,
      }]
    })
    const res = await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - assertVisible: "OK"\n' })
    expect(res.isError).toBeFalsy()
  })

  it('retries a transient ui-tree response until the selector resolves', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    let attempts = 0
    vi.mocked(client.queryUITree).mockImplementation(async () => {
      if (attempts++ === 0) throw new TransientQueryError('temporary relay failure')
      return [{
        role: 'button',
        label: 'OK',
        frame: { x: 0, y: 0, width: 1, height: 1 },
        enabled: true,
      }]
    })
    const res = await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - assertVisible: "OK"\n' })
    expect(res.isError).toBeFalsy()
    expect(client.queryUITree).toHaveBeenCalledTimes(2)
  })

  it('surfaces an install failure as a run_flow error and never runs the flow', async () => {
    const calls: string[] = []
    const client = fakeClient(calls)
    vi.mocked(client.installApp).mockRejectedValueOnce(new Error('device offline'))
    const res = await runFlowHandler(client)({ sessionId: 's1', flow: 'steps:\n  - launchApp\n', buildId: 5 })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('device offline')
    expect(calls).toEqual([]) // install rejected → launchApp step never reached
  })
})
