import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { BrowserToRelay } from '@tapflowio/protocol'
import type { RelayMessage } from '@/lib/types'

// #426 stage 2. When an agent restarts, the relay re-points the session at the new socket and sends
// `session:rebound`. The relay cannot restart the stream on its own — the codec negotiation and the
// tier ride in the browser's own `device:boot` payload — so the viewer has to ask for the device
// again. Until it does, every flag here still describes the agent that died.
const send = vi.fn<(msg: BrowserToRelay) => void>()
let deliver: ((msg: RelayMessage) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: RelayMessage) => void) => {
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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

/** Minimal iOS chrome — enough for the platform viewer to mount, which is what makes teardown
 *  observable: with `chrome` set the skeleton is gone, and clearing it brings the skeleton back. */
const CHROME = {
  framePng: 'iVBORw0KGgo=', bezelWidth: 10, bezelHeight: 10,
  compositeWidth: 100, compositeHeight: 200,
  padding: { left: 0, right: 0, top: 0, bottom: 0 },
  screenRect: { x: 0, y: 0, width: 100, height: 200 },
  screenCornerRadius: 0, logicalWidth: 50, logicalHeight: 100, buttons: [],
}

const boots = () =>
  send.mock.calls
    .map(([m]) => m)
    .filter((m): m is Extract<BrowserToRelay, { type: 'device:boot' }> => m.type === 'device:boot')

const installs = () => send.mock.calls.filter(([m]) => m.type === 'app:install')

/** Brings a viewer to "streaming": joined, device up, chrome delivered, build installed. */
function live(buildId?: number) {
  render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={buildId} />)
  act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] } as RelayMessage) })
  act(() => { deliver!({ type: 'device:ready', payload: { deviceId: 'dev-1' } } as RelayMessage) })
  act(() => { deliver!({ type: 'session:chrome', payload: CHROME } as unknown as RelayMessage) })
  if (buildId) act(() => { deliver!({ type: 'app:install-done' } as RelayMessage) })
}

const rebound = (capabilities: string[] = []) =>
  act(() => { deliver!({ type: 'session:rebound', sessionId: 's1', capabilities } as RelayMessage) })

describe('DeviceViewer recovers from an agent restart (#426)', () => {
  beforeEach(() => { send.mockClear(); deliver = null })

  it('asks for the device again', async () => {
    live()
    send.mockClear()

    rebound()

    expect(boots()).toHaveLength(1)
  })

  it('does not erase the device on the way back', async () => {
    // A restart is not a reset request. `resetSentRef` is already spent, so this is automatic —
    // pinned because losing it would wipe a tester's device with no click involved (#439).
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" resetMode="full-erase" />)
    act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] } as RelayMessage) })
    send.mockClear()

    rebound()

    expect(boots()[0]?.payload.resetMode).toBe('app-only')
  })

  it('stops showing the dead agent\'s frame', async () => {
    // The device frame `<img>` renders only while `chrome` is set, so its absence is what proves
    // the teardown. Not the "Starting device…" text: the platform viewer carries its own status
    // card, so that string appears whenever `deviceReady` is false — with or without chrome — and
    // a teardown that forgot `setChrome(null)` would pass.
    live()
    const frame = () => document.querySelectorAll('img[src^="data:image/png;base64,"]').length
    expect(frame()).toBe(1)

    rebound()

    expect(frame()).toBe(0)
  })

  it('drops UI state that only the dead agent could have resolved', async () => {
    // The software keyboard was up on the old device; the reboot puts it away. Same block clears
    // `launching` and `swKeyboardPending`, whose acknowledgements (`app:launch-done`,
    // `keyboard:toggled`) died with the old agent — before rebinding existed those could not
    // outlive it, because a dead agent unmounted the viewer.
    //
    // `data-active` on the keyboard button is the observable. `launching` is only reachable by
    // clicking Launch, so it is covered by inspection rather than by this test.
    live()
    act(() => { deliver!({ type: 'keyboard:toggled', sessionId: 's1', payload: { visible: true } } as RelayMessage) })
    expect(document.querySelectorAll('[data-active="true"]').length).toBeGreaterThan(0)

    rebound()
    act(() => { deliver!({ type: 'session:chrome', payload: CHROME } as unknown as RelayMessage) })

    expect(document.querySelectorAll('[data-active="true"]')).toHaveLength(0)
  })

  it('keeps the installed app, and keeps the control that launches it', async () => {
    // The simulator stayed up across the restart, so the build is still installed. Reinstalling
    // would kill the state the rebind exists to preserve — but skipping it means `app:install-done`
    // never arrives, and that message is the only thing that sets `installed`, which gates Launch.
    live(7)
    const buttonsWhenLive = screen.queryAllByRole('button').length
    send.mockClear()

    rebound()
    act(() => { deliver!({ type: 'device:booting' } as RelayMessage) })
    act(() => { deliver!({ type: 'device:ready', payload: { deviceId: 'dev-1' } } as RelayMessage) })
    act(() => { deliver!({ type: 'session:chrome', payload: CHROME } as unknown as RelayMessage) })

    expect(installs()).toHaveLength(0)
    expect(screen.queryAllByRole('button')).toHaveLength(buttonsWhenLive)
  })

  it('installs again on a boot that is not a rebind', async () => {
    // The skip is scoped to the rebind. A later ordinary boot must still install, or the ref has
    // simply disabled installing for the life of the mount.
    live(7)
    rebound()
    act(() => { deliver!({ type: 'device:booting' } as RelayMessage) })
    act(() => { deliver!({ type: 'device:ready', payload: { deviceId: 'dev-1' } } as RelayMessage) })
    send.mockClear()

    act(() => { deliver!({ type: 'device:ready', payload: { deviceId: 'dev-1' } } as RelayMessage) })

    expect(installs()).toHaveLength(1)
  })

  it('releases the rebind when the re-boot fails', async () => {
    // Otherwise a failed recovery suppresses every install for the rest of the mount.
    live(7)
    rebound()
    act(() => { deliver!({ type: 'device:boot-error', sessionId: 's1', message: 'nope' } as RelayMessage) })
    send.mockClear()

    act(() => { deliver!({ type: 'device:ready', payload: { deviceId: 'dev-1' } } as RelayMessage) })

    expect(installs()).toHaveLength(1)
  })

  it('ignores a rebind meant for another session', async () => {
    live()
    send.mockClear()

    act(() => { deliver!({ type: 'session:rebound', sessionId: 'other', capabilities: [] } as RelayMessage) })

    expect(boots()).toHaveLength(0)
    expect(screen.queryByText(/Starting device/)).not.toBeInTheDocument()
  })
})
