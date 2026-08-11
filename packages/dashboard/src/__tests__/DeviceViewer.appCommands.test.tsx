import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { BrowserInbound } from '@/lib/types'

// The browser half of the app-command correlation, which shipped with none of this. That is a documented
// repeat: `DeviceViewer.openUrl.test.tsx` opens by saying those tests exist because the previous slice
// shipped without them, and then this slice added two more pairs with zero.
//
// A wrong or unrecorded correlator is a **loss** here, not a misattribution — the gate discards the reply,
// nothing clears `installing`, and the Launch control never appears for the life of the mount.
const send = vi.fn()
let deliver: ((msg: BrowserInbound) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send, connected: true }
  },
}))
vi.mock('@/hooks/usePerfMode', () => ({ usePerfMode: () => ({ perfMode: false, visible: false }) }))
vi.mock('@/hooks/useAudioPlayback', () => ({ useAudioPlayback: () => ({ pushFrame: vi.fn() }) }))
vi.mock('@/lib/decoders/pickDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decoders/pickDecoder')>()),
  canDecodeH264: () => false,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

const CHROME = {
  framePng: 'iVBORw0KGgo=', bezelWidth: 10, bezelHeight: 10,
  compositeWidth: 100, compositeHeight: 200,
  padding: { left: 0, right: 0, top: 0, bottom: 0 },
  screenRect: { x: 0, y: 0, width: 100, height: 200 },
  screenCornerRadius: 0, logicalWidth: 50, logicalHeight: 100, buttons: [],
}

/** The correlator the viewer actually sent. Read back rather than invented — a made-up id would test that
 *  the gate rejects it, which is the opposite of what these need. */
const sentId = (type: string): string => {
  const call = send.mock.calls.map(([m]) => m).filter((m) => m.type === type).at(-1)
  expect(call, `no ${type} was sent`).toBeDefined()
  return (call as { requestId: string }).requestId
}

/** Joined, device up, chrome delivered — and with a build, so the viewer issues an install. */
function live(buildId?: number) {
  render(<DeviceViewer sessionId="mine" deviceId="dev-1" buildId={buildId} />)
  act(() => { deliver!({ type: 'session:joined', sessionId: 'mine', capabilities: [] }) })
  act(() => { deliver!({ type: 'device:ready', sessionId: 'mine', payload: { deviceId: 'dev-1' } }) })
  act(() => { deliver!({ type: 'session:chrome', sessionId: 'mine', payload: CHROME }) })
}

describe('DeviceViewer only acts on app-command replies it asked for', () => {
  beforeEach(() => { send.mockClear(); deliver = null })

  it('applies an install reply carrying its own correlator', () => {
    live(7)
    act(() => { deliver!({ type: 'app:install-done', sessionId: 'mine', requestId: sentId('app:install') }) })
    expect(screen.queryByText(/Installing/)).not.toBeInTheDocument()
  })

  it('ignores an install failure for a request it did not make', () => {
    // Reachable: `handleBrowserAppInstall` never checks that the sender holds the session, and the agent's
    // reply goes to whoever holds `browserSocket`. So an `mcp-server` install on this session lands here.
    live(7)
    act(() => { deliver!({ type: 'app:install-error', sessionId: 'mine', requestId: 'someone-elses', message: 'Build not found' }) })
    expect(screen.queryByText(/Install failed/)).not.toBeInTheDocument()
  })

  it('shows an install failure that is its own', () => {
    live(7)
    act(() => { deliver!({ type: 'app:install-error', sessionId: 'mine', requestId: sentId('app:install'), message: 'Build not found' }) })
    expect(screen.getByText(/Install failed: Build not found/)).toBeInTheDocument()
  })

  it('clears the launch spinner only for its own launch reply', () => {
    live(7)
    act(() => { deliver!({ type: 'app:install-done', sessionId: 'mine', requestId: sentId('app:install') }) })

    const launch = screen.getByLabelText('Launch app')
    act(() => { launch.click() })
    const id = sentId('app:launch')
    expect(id).toMatch(/^[0-9a-f]{32}$/)

    // Someone else's launch reply must not clear this viewer's spinner.
    act(() => { deliver!({ type: 'app:launch-done', sessionId: 'mine', requestId: 'someone-elses' }) })
    expect(screen.getByLabelText('Launch app')).toBeDisabled()

    act(() => { deliver!({ type: 'app:launch-done', sessionId: 'mine', requestId: id }) })
    expect(screen.getByLabelText('Launch app')).not.toBeDisabled()
  })

  it('gives each launch its own correlator', () => {
    live(7)
    act(() => { deliver!({ type: 'app:install-done', sessionId: 'mine', requestId: sentId('app:install') }) })

    act(() => { screen.getByLabelText('Launch app').click() })
    const first = sentId('app:launch')
    act(() => { deliver!({ type: 'app:launch-error', sessionId: 'mine', requestId: first, message: 'nope' }) })

    act(() => { screen.getByLabelText('Launch app').click() })
    expect(sentId('app:launch')).not.toBe(first)
  })

  it('drops a reply from an agent older than the field, and that is the upgrade cost', () => {
    // The relay forwards agent replies without inspecting them, so an agent predating `requestId` puts the
    // key on the wire absent — `Set.delete(undefined)` is false and the reply is discarded. The `fixed`
    // version group makes packages *release* together, not *install* together, and the agent runs on a
    // tester's Mac installed separately. This pins the cost rather than claiming it cannot happen.
    live(7)
    act(() => { deliver!({ type: 'app:install-done', sessionId: 'mine' } as BrowserInbound) })
    expect(screen.getByText(/Installing/)).toBeInTheDocument()
  })
})
