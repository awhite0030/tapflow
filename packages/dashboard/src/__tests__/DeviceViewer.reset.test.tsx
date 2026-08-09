import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { act } from 'react'
import type { BrowserToRelay } from '@tapflowio/protocol'
import type { BrowserInbound } from '@/lib/types'

// The viewer is only exercised through its message handler here — the decoders, the audio path and
// the platform viewers all want a canvas and a real socket, and none of them touch resetMode.
const send = vi.fn<(msg: BrowserToRelay) => void>()
let deliver: ((msg: BrowserInbound) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send, connected: true }
  },
}))
vi.mock('@/hooks/usePerfMode', () => ({ usePerfMode: () => ({ perfMode: false, visible: false }) }))
vi.mock('@/hooks/useAudioPlayback', () => ({ useAudioPlayback: () => ({ pushFrame: vi.fn() }) }))
// Partial: SimulatorInfoCard reaches for performanceMode() from the same module.
vi.mock('@/lib/decoders/pickDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decoders/pickDecoder')>()),
  canDecodeH264: () => false,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

/** Every device:boot the viewer sent, in order, with the resetMode it carried. */
function bootModes(): Array<string | undefined> {
  return send.mock.calls
    .map(([msg]) => msg)
    .filter((msg): msg is Extract<BrowserToRelay, { type: 'device:boot' }> => msg.type === 'device:boot')
    .map((msg) => msg.payload.resetMode)
}

describe('DeviceViewer — resetMode is consumed once per mount (#439)', () => {
  beforeEach(() => {
    send.mockClear()
    deliver = null
  })

  it('carries the reset on the first session:joined and drops it on every later one', () => {
    render(<DeviceViewer sessionId="s-1" deviceId="dev-1" resetMode="full-erase" />)
    expect(deliver).not.toBeNull()

    // The relay replays session:joined on every session:start, and useRelay re-sends that whenever
    // the socket reconnects. A Wi-Fi blip must not re-erase the device the tester is looking at.
    act(() => { deliver!({ type: 'session:joined', sessionId: 's-1', capabilities: [] }) })
    act(() => { deliver!({ type: 'session:joined', sessionId: 's-1', capabilities: [] }) })
    act(() => { deliver!({ type: 'session:joined', sessionId: 's-1', capabilities: [] }) })

    expect(bootModes()).toEqual(['full-erase', 'app-only', 'app-only'])
  })

  // Guards the inverted condition, not #439 itself: the pre-fix code passed this too.
  it('never asks for an erase when the toggle was off', () => {
    render(<DeviceViewer sessionId="s-1" deviceId="dev-1" resetMode="app-only" />)
    act(() => { deliver!({ type: 'session:joined', sessionId: 's-1', capabilities: [] }) })
    act(() => { deliver!({ type: 'session:joined', sessionId: 's-1', capabilities: [] }) })

    expect(bootModes()).toEqual(['app-only', 'app-only'])
  })

  // Per mount, not per module: the next viewer has to be able to erase. Whether picking a device
  // actually produces a new mount is QASession's business — see QASession.reset.test.tsx.
  it('a second viewer arms again', () => {
    const first = render(<DeviceViewer sessionId="s-1" deviceId="dev-1" resetMode="full-erase" />)
    act(() => { deliver!({ type: 'session:joined', sessionId: 's-1', capabilities: [] }) })
    first.unmount()  // keeps the two viewers from overlapping; `deliver` already points at the next one
    send.mockClear()

    render(<DeviceViewer sessionId="s-2" deviceId="dev-2" resetMode="full-erase" />)
    act(() => { deliver!({ type: 'session:joined', sessionId: 's-2', capabilities: [] }) })

    expect(bootModes()).toEqual(['full-erase'])
  })
})
