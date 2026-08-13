import { describe, it, expect, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTools } from '../tools.js'
import type { TapflowClient } from '../client.js'

type ToolResult = {
  content: Array<{ type: string; text?: string; mimeType?: string }>
  isError?: boolean
}
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>

function captureTools(client: TapflowClient): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => { handlers.set(name, handler) },
  }
  registerTools(server as unknown as McpServer, client)
  return handlers
}

/** A 1×1 PNG header: signature, then IHDR with width and height at bytes 16–23. */
function pngBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(64)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.write('IHDR', 12)
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

/** A JPEG whose SOF0 marker carries the dimensions, laid out the way the parser reads it. */
function jpegBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(64)
  buf[0] = 0xff
  buf[1] = 0xd8
  buf[20] = 0xff
  buf[21] = 0xc0
  buf.writeUInt16BE(height, 25)
  buf.writeUInt16BE(width, 27)
  return buf
}

function clientReturning(buf: Buffer): TapflowClient {
  return {
    screenshot: vi.fn(async () => buf),
  } as unknown as TapflowClient
}

const text = (res: ToolResult) => res.content.find((c) => c.type === 'text')?.text ?? ''
const image = (res: ToolResult) => res.content.find((c) => c.type === 'image')

// #508. The request's `format` is a preference and the reply's is a claim, so neither can decide how
// to parse the bytes. Android produces PNG whatever is asked — `screencap -p` takes no format — and
// used to echo the request, so a JPEG request arrived as PNG bytes that the dimension parser scanned
// for a JPEG SOF0 marker. A stray `ff c0` in a few hundred KB of IDAT is close to certain, so the
// numbers were wrong, and they go into the text the LLM hands back as `tap`'s divisors.
describe('screenshot — the bytes decide the format, not the request', () => {
  const handler = (buf: Buffer) => captureTools(clientReturning(buf)).get('screenshot') as Handler

  it('reports PNG for PNG bytes even when jpeg was asked for', async () => {
    const res = await handler(pngBytes(1170, 2532))({ sessionId: 's1', format: 'jpeg' })
    expect(image(res)?.mimeType).toBe('image/png')
    expect(text(res)).toContain('.png')
    // The dimensions are the ones a PNG parser reads. Under the old code this asked a JPEG parser for
    // them, which is the half that reaches `tap`.
    expect(text(res)).toContain('1170×2532px')
    expect(text(res)).toContain('jpeg was requested but the device produced png')
  })

  it('still honours a JPEG that really is one', async () => {
    // The path that already worked gets mutated first (`contributing/test-and-guard-coverage.md` §4):
    // a sniffer that answered `png` for everything would fix Android and silently break iOS, whose
    // JPEG request is the only one any platform fulfils.
    const res = await handler(jpegBytes(828, 1792))({ sessionId: 's1', format: 'jpeg' })
    expect(image(res)?.mimeType).toBe('image/jpeg')
    expect(text(res)).toContain('.jpg')
    expect(text(res)).toContain('828×1792px')
    // Nothing to report when the request was met.
    expect(text(res)).not.toContain('but the device produced')
  })

  it('leaves the ordinary png request quiet', async () => {
    const res = await handler(pngBytes(400, 800))({ sessionId: 's1' })
    expect(image(res)?.mimeType).toBe('image/png')
    expect(text(res)).toContain('400×800px')
    expect(text(res)).not.toContain('produced')
    expect(text(res)).not.toContain('unrecognised')
  })

  it('says so when the bytes match neither signature', async () => {
    // Reachable only from a platform registered through `AgentRegistry` that produces something else
    // — `DeviceAgent.screenshot()` takes no format, so nothing constrains it. Falling back to the
    // request keeps the old behaviour; saying so is what stops it being presented as a reading, and
    // `tap` takes these dimensions as required arguments.
    const res = await handler(Buffer.from('RIFF....WEBPVP8 '))({ sessionId: 's1', format: 'jpeg' })
    expect(image(res)?.mimeType).toBe('image/jpeg')
    expect(text(res)).toContain('unrecognised format, read as jpeg')
  })
})
