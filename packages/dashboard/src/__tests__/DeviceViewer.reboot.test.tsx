import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BrowserInbound } from '@/lib/types'

// **The wiring, which the hook's suite and the toolbar's suite cannot reach between them** (#628).
//
// `useDeviceReboot` is tested against a handler it registers itself, and `SimulatorToolbar` is tested
// with a stand-in `onReboot`. Between the two sits the chain that actually makes a device restart:
// `DeviceViewer` routes `device:shutdown-*` into a ref, hands `rebootPending`/`onReboot` down through
// `commonProps`, and — the half that exists nowhere else — turns the hook's completion into a
// `device:boot` through the same helper the join and the rebind use.
//
// Deleting the routing branch leaves `inboundDisposition` green: its check looks for a `.type`
// comparison against the literal in a file named in `at:`, which the branch's own condition satisfies
// whether or not it forwards anything. Its comment calls that a floor rather than a fence, and this
// is the fence. The harness is `DeviceViewer.network.test.tsx`'s, which exists for the same reason.
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
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() }
vi.mock('sonner', () => ({ toast }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

const CHROME = {
  framePng: 'iVBORw0KGgo=', bezelWidth: 10, bezelHeight: 10,
  compositeWidth: 100, compositeHeight: 200,
  padding: { left: 0, right: 0, top: 0, bottom: 0 },
  screenRect: { x: 0, y: 0, width: 100, height: 200 },
  screenCornerRadius: 0, logicalWidth: 50, logicalHeight: 100, buttons: [],
}

/** A viewer with a device on screen — the toolbar lives inside `IOSViewer`, which needs the chrome. */
function live(sessionId = 'mine') {
  render(<DeviceViewer sessionId={sessionId} deviceId="dev-1" />)
  act(() => { deliver!({ type: 'session:joined', sessionId, capabilities: [] }) })
  act(() => { deliver!({ type: 'device:ready', sessionId, payload: { deviceId: 'dev-1' } }) })
  act(() => { deliver!({ type: 'session:chrome', sessionId, payload: CHROME }) })
}

const sentOf = (type: string) => send.mock.calls.map(([m]) => m).filter((m) => m.type === type)
const shutdowns = () => sentOf('device:shutdown')
const boots = () => sentOf('device:boot')

/**
 * Press the control and confirm the dialog, which is the only way a reboot starts.
 *
 * The record is cleared first because `session:joined` boots the device on its way in — counting
 * from zero here is what makes "a boot went out before the device was down" mean what it says.
 */
async function confirmRestart() {
  send.mockClear()
  await userEvent.click(screen.getByRole('button', { name: 'Restart the device' }))
  await userEvent.click(screen.getByRole('button', { name: 'Restart' }))
}

describe('DeviceViewer — reboot wiring', () => {
  beforeEach(() => { send.mockClear(); toast.error.mockClear(); deliver = null })

  it('offers the control on a live device', () => {
    live()
    expect(screen.getByRole('button', { name: 'Restart the device' })).toBeTruthy()
  })

  it('shuts the device down when the restart is confirmed', async () => {
    live()
    await confirmRestart()
    expect(shutdowns()).toHaveLength(1)
    expect(shutdowns()[0]).toMatchObject({ sessionId: 'mine', payload: { deviceId: 'dev-1' } })
    expect(shutdowns()[0].requestId, 'the viewer sent an uncorrelated shutdown').toBeTruthy()
    // Nothing yet: booting here would race the shutdown it just asked for.
    expect(boots(), 'a boot went out before the device was down').toHaveLength(0)
  })

  it('boots the device once its own shutdown is answered', async () => {
    live()
    await confirmRestart()
    const id = shutdowns()[0].requestId
    act(() => { deliver!({ type: 'device:shutdown-done', sessionId: 'mine', requestId: id, payload: { deviceId: 'dev-1' } }) })

    expect(boots(), 'the shutdown reply did not reach the sequence').toHaveLength(1)
    // **`app-only`, and the assertion is the point rather than the shape.** A restart is not a
    // request to erase (#439), and the selector screen is where wiping is chosen.
    expect(boots()[0]).toMatchObject({ payload: { deviceId: 'dev-1', resetMode: 'app-only' } })
    expect(boots()[0].requestId, 'the boot went out uncorrelated, so its reply answers nothing').toBeTruthy()
  })

  it('boots nothing on a reply to somebody else\'s shutdown', async () => {
    // `useAgentSession` sends three id-less `device:shutdown`s on the way out of a view, and the
    // relay's idle timer sends its own. Every one of them is answered on this session.
    live()
    await confirmRestart()
    act(() => { deliver!({ type: 'device:shutdown-done', sessionId: 'mine', payload: { deviceId: 'dev-1' } }) })
    act(() => { deliver!({ type: 'device:shutdown-done', sessionId: 'mine', requestId: 'someone-else', payload: { deviceId: 'dev-1' } }) })
    expect(boots(), 'a stranger\'s teardown booted this device').toHaveLength(0)
  })

  it('says so when the relay refuses the shutdown', async () => {
    live()
    await confirmRestart()
    const id = shutdowns()[0].requestId
    act(() => { deliver!({ type: 'device:shutdown-error', sessionId: 'mine', requestId: id, message: 'agent offline' }) })
    expect(boots()).toHaveLength(0)
    // Out loud, because the control it came from goes back to looking exactly as it did — a click
    // that changes nothing on screen is indistinguishable from a dead button.
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error.mock.calls[0][0]).toContain('agent offline')
  })

  it('leaves the join and the rebind booting the way they did', () => {
    // The reboot made `sendBoot` the single place a boot is sent, and the join is one of the two
    // callers it replaced. Its reset is the one thing the callers disagree on and the disagreement is
    // load-bearing (#439), so it is what this pins.
    live()
    expect(boots()).toHaveLength(1)
    expect(boots()[0].requestId, 'the join stopped correlating its boot').toBeTruthy()
  })
})
