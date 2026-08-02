import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
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

  it('drops the keyboard state the dead agent was holding', async () => {
    // The software keyboard was up on the old device; the reboot puts it away.
    // `data-active` on the keyboard button is the observable.
    live()
    act(() => { deliver!({ type: 'keyboard:toggled', sessionId: 's1', payload: { visible: true } } as RelayMessage) })
    expect(document.querySelectorAll('[data-active="true"]').length).toBeGreaterThan(0)

    rebound()
    act(() => { deliver!({ type: 'session:chrome', payload: CHROME } as unknown as RelayMessage) })

    expect(document.querySelectorAll('[data-active="true"]')).toHaveLength(0)
  })

  it('unsticks a keyboard toggle whose acknowledgement died with the agent', async () => {
    // `swKeyboardPending` disables the toggle until `keyboard:toggled` comes back. Send it to an
    // agent that then restarts and the acknowledgement never arrives — the control stays disabled
    // for the life of the mount. Before rebinding existed this was unreachable: a dead agent
    // unmounted the viewer, so nothing could outlive it.
    //
    // Clicking is what makes the flag true. Delivering `keyboard:toggled` instead — as an earlier
    // version of this test did — sets it *false*, so the assertion held with the clearing line
    // deleted and proved nothing.
    live()
    const kbd = () => document.querySelector('button[data-active]') as HTMLButtonElement
    fireEvent.click(kbd())
    expect(kbd().disabled).toBe(true)

    rebound()
    act(() => { deliver!({ type: 'session:chrome', payload: CHROME } as unknown as RelayMessage) })

    expect(kbd().disabled).toBe(false)
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

  it('unsticks a launch whose acknowledgement died with the agent', async () => {
    // Same shape as the keyboard toggle: `launching` is set on click and cleared only by
    // `app:launch-done` / `app:launch-error`, both of which die with the agent.
    live(7)
    const launch = () => screen.getByRole('button', { name: /launch app/i }) as HTMLButtonElement
    fireEvent.click(launch())
    expect(launch().disabled).toBe(true)

    rebound()
    act(() => { deliver!({ type: 'session:chrome', payload: CHROME } as unknown as RelayMessage) })

    expect(launch().disabled).toBe(false)
  })

  it('installs after a rebind that interrupted the install', async () => {
    // Finding 1. An agent is at its most fragile mid-install, and a rebind there means the app
    // really is missing. Skipping the install anyway — and setting `installed` on top of it —
    // hands the tester a Launch button for an app that is not on the device.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] } as RelayMessage) })
    act(() => { deliver!({ type: 'device:ready', payload: { deviceId: 'dev-1' } } as RelayMessage) })
    expect(installs()).toHaveLength(1) // in flight — no `app:install-done`
    send.mockClear()

    rebound()
    act(() => { deliver!({ type: 'device:booting' } as RelayMessage) })
    act(() => { deliver!({ type: 'device:ready', payload: { deviceId: 'dev-1' } } as RelayMessage) })
    act(() => { deliver!({ type: 'session:chrome', payload: CHROME } as unknown as RelayMessage) })

    expect(installs()).toHaveLength(1)
    // ...and no Launch control until that install reports back. This query is only meaningful
    // because the button carries an `aria-label`; without one it matches nothing and passes
    // whatever the viewer renders.
    expect(screen.queryByRole('button', { name: /launch app/i })).not.toBeInTheDocument()
  })

  it('does not let an unanswered rebind swallow a later boot', async () => {
    // Finding 2. The new agent can fail to answer at all — it is a process that just restarted.
    // A rebind left pending would then absorb the `device:ready` of whatever boot comes next
    // (a socket blip re-sends `device:boot` from the `session:joined` branch), and the install
    // would be suppressed for the rest of the mount rather than for one recovery.
    live(7)
    rebound()
    act(() => { deliver!({ type: 'device:booting' } as RelayMessage) }) // ...and then silence
    send.mockClear()

    act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] } as RelayMessage) })
    act(() => { deliver!({ type: 'device:ready', payload: { deviceId: 'dev-1' } } as RelayMessage) })

    expect(installs()).toHaveLength(1)
  })

  it('skips the install for every rebind, not just the first', async () => {
    // Finding 3. A crash-looping agent rebinds more than once, and each rebind boots and gets its
    // own ready. A flag is spent by the first of them, so the second reinstalls — destroying the
    // app state the skip exists to preserve. Hence a count.
    live(7)
    send.mockClear()

    rebound()
    rebound()
    act(() => { deliver!({ type: 'device:ready', payload: { deviceId: 'dev-1' } } as RelayMessage) })
    act(() => { deliver!({ type: 'device:ready', payload: { deviceId: 'dev-1' } } as RelayMessage) })

    expect(boots()).toHaveLength(2)
    expect(installs()).toHaveLength(0)
  })

  it('ignores a rebind meant for another session', async () => {
    live()
    send.mockClear()

    act(() => { deliver!({ type: 'session:rebound', sessionId: 'other', capabilities: [] } as RelayMessage) })

    expect(boots()).toHaveLength(0)
    expect(screen.queryByText(/Starting device/)).not.toBeInTheDocument()
  })
})
