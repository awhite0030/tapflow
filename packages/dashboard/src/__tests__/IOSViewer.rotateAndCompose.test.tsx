import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * **The iOS half of the recording and rotation contract.**
 *
 * `IOSViewer` took the same two changes `AndroidViewer` did — the recorder is handed its composer
 * through `setComposeFrame` instead of through `startClientRecording`, and the cleanup that puts a
 * rotated simulator back upright keeps its body in a ref so its dependency list is honestly empty.
 * Neither was held by anything: `input:rotate` appeared in no test in this package, and the four
 * files that render this component through `DeviceViewer` never record.
 *
 * Both mutations were measured green across all 681 tests before this file existed. The second is
 * the worse one, and it is this branch that made it quiet: `startClientRecording(composeFrame)`
 * used to require the composer, so losing it was a type error. Now a cleanup pass that deletes the
 * registration effect and its unused destructure leaves a green typecheck, a silent lint, and a
 * recording of a black canvas.
 */

type Compose = () => void

const { recordCanvas, captured } = vi.hoisted(() => ({
  recordCanvas: { current: null as HTMLCanvasElement | null },
  captured: { compose: null as Compose | null, started: false },
}))

// Stable, like the real hook's `useCallback(…, [])` — see the note in
// `AndroidViewer.composeFrame.test.tsx`: unstable mocks make every dependency array containing
// them change every render, which hides a missing dependency.
const stableSetComposeFrame = (compose: Compose) => { captured.compose = compose }
const stableStart = () => { captured.started = true }
const stableStop = () => {}

vi.mock('@/hooks/useClientRecording', () => ({
  useClientRecording: () => ({
    recordState: 'idle',
    recordCanvasRef: recordCanvas,
    setComposeFrame: stableSetComposeFrame,
    startClientRecording: stableStart,
    stopClientRecording: stableStop,
  }),
}))

vi.mock('@/hooks/useDecoderStream', () => ({ useDecoderStream: () => {} }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { IOSViewer } from '@/components/device/IOSViewer'

const chrome = {
  framePng: 'data:image/png;base64,', bezelWidth: 600, bezelHeight: 1200,
  compositeWidth: 640, compositeHeight: 1240,
  padding: { left: 20, right: 20, top: 20, bottom: 20 },
  screenRect: { x: 40, y: 40, width: 560, height: 1160 },
  screenCornerRadius: 40, logicalWidth: 390, logicalHeight: 844, buttons: [],
}

function renderViewer() {
  const send = vi.fn()
  const props = {
    sessionId: 's1',
    send,
    openUrl: vi.fn(),
    launchApp: vi.fn(),
    connected: true,
    joined: true,
    deviceReady: true,
    installing: false,
    installed: true,
    installError: null,
    bootError: null,
    launching: false,
    chrome,
    binaryFrameHandlerRef: { current: undefined },
    clipboardHandlerRef: { current: undefined },
    clipboardSupported: true,
    networkHandlerRef: { current: undefined },
    networkSupported: false,
    swKeyboardVisible: false,
    swKeyboardPending: false,
    onKbdToggle: vi.fn(),
    rebootPending: false,
    onReboot: vi.fn(),
    restartButtonRef: { current: null },
  // The prop surface is wide and none of it is what this file is about; the cast keeps the fixture
  // from restating types the component already owns.
  } as unknown as React.ComponentProps<typeof IOSViewer>
  return { ...render(<IOSViewer {...props} />), send }
}

/** The `input:rotate` messages `send` was given, in order. */
const rotateCalls = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.filter(([m]) => (m as { type: string }).type === 'input:rotate')

const rotateButton = () => screen.getByRole('button', { name: /rotate the device/i })

describe('IOSViewer — the recorder gets a composer, and the simulator gets put back', () => {
  beforeEach(() => { captured.compose = null; captured.started = false; recordCanvas.current = null })
  afterEach(() => vi.restoreAllMocks())

  it('hands the recorder a composer on mount', () => {
    // Deleting the registration effect is a silent black recording, not a build failure — which is
    // exactly what the move from an argument to a setter cost. This is what says it happened.
    renderViewer()
    expect(captured.compose).toBeTypeOf('function')
  })

  it('rotates the simulator back when the viewer goes away in landscape', async () => {
    const { send, unmount } = renderViewer()

    await userEvent.click(rotateButton())
    expect(rotateCalls(send)).toHaveLength(1)

    unmount()
    expect(rotateCalls(send)).toHaveLength(2)
    // The session it is addressed to, not only that something went out — the cleanup reads
    // `sessionId` at unmount now rather than capturing it at mount.
    expect(rotateCalls(send)[1][0]).toEqual({ type: 'input:rotate', sessionId: 's1' })
  })

  it('leaves a simulator it never turned alone', () => {
    const { send, unmount } = renderViewer()
    unmount()
    expect(rotateCalls(send)).toHaveLength(0)
  })

  it('does not undo a rotation the tester already undid', async () => {
    // Two presses is back where it started, and a third message on unmount would turn a simulator
    // the tester left upright.
    const { send, unmount } = renderViewer()
    await userEvent.click(rotateButton())
    await userEvent.click(rotateButton())

    unmount()
    expect(rotateCalls(send)).toHaveLength(2)
  })
})
