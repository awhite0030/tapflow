import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * **What a recorded frame is turned by, while it is being recorded.**
 *
 * `composeFrame` draws each recorded frame into the record canvas and reads the turn *per frame*
 * rather than inferring it from the canvas — an aspect ratio cannot tell 90 from 270 and cannot
 * see 180 at all. That is the whole reason `AndroidViewer` mirrors `totalTurn` and
 * `streamRotation` into refs: `MediaRecorder` took `composeFrame` when recording started, and a
 * rotation after that has to reach the frames anyway.
 *
 * None of it was covered. `composeFrame` and `startClientRecording` appeared in no test in this
 * package, so rotating mid-recording — an ordinary thing to do while testing — was held by nothing.
 * It is held here because the mirroring is what the React Compiler refuses to compile, and any
 * rewrite of it has to keep this true.
 *
 * **What this file does not hold: that registration is a layout effect rather than a passive one.**
 * The production comment gives a measured reason — `requestAnimationFrame` fires between the
 * layout effects and the paint, so a passive effect would draw the first frame after a rotation
 * with the old turn — and nothing here can fail if that changes. Every point these tests act at is
 * inside `act()`, which flushes passive effects synchronously, so jsdom cannot tell the two apart.
 * Holding it would mean ordering rAF against React's passive flush, which jsdom does not model;
 * that is a decision to take deliberately rather than a missing assertion. Recorded because a
 * green suite beside a stated reason reads as having held it.
 */

type Compose = () => void

const { recordCanvas, captured } = vi.hoisted(() => ({
  recordCanvas: { current: null as HTMLCanvasElement | null },
  captured: {
    compose: null as Compose | null,
    started: false,
    onResize: null as ((s: { width: number; height: number }) => void) | null,
    onDecoderReady: null as ((d: { surface: unknown }) => void) | null,
  },
}))

// **Stable, like the real one.** `useClientRecording` builds these with `useCallback(…, [])`, and
// a mock that rebuilds them every render makes every dependency array containing them change every
// render — which silently re-runs the registration effect and hides a missing dependency. Measured:
// with unstable mocks, removing `composeFrame` from that effect's deps failed nothing.
const stableSetComposeFrame = (compose: Compose) => { captured.compose = compose }
const stableStart = () => { captured.started = true }
const stableStop = () => {}

vi.mock('@/hooks/useClientRecording', () => ({
  useClientRecording: () => ({
    recordState: 'idle',
    recordCanvasRef: recordCanvas,
    // The recorder keeps whichever composer was registered last, and its frame loop reads that on
    // every tick. Capturing the registration is how this test gets hold of the newest one — which
    // is the behaviour under test, not an implementation detail of the mock.
    setComposeFrame: stableSetComposeFrame,
    startClientRecording: stableStart,
    stopClientRecording: stableStop,
  }),
}))

vi.mock('@/hooks/useDecoderStream', () => ({
  useDecoderStream: (opts: {
    onResize: (s: { width: number; height: number }) => void
    onDecoderReady: (d: { surface: unknown }) => void
  }) => {
    captured.onResize = opts.onResize
    captured.onDecoderReady = opts.onDecoderReady
  },
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { AndroidViewer } from '@/components/device/AndroidViewer'

/** Angles `ctx.rotate` was called with, in degrees, in order. */
const rotations: number[] = []

function stubCanvasContext() {
  const ctx = {
    clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(),
    drawImage: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
    closePath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), setTransform: vi.fn(),
    rotate: vi.fn((rad: number) => { rotations.push(Math.round((rad * 180) / Math.PI)) }),
    fillStyle: '', strokeStyle: '', lineWidth: 0,
  }
  HTMLCanvasElement.prototype.getContext =
    vi.fn(() => ctx) as unknown as HTMLCanvasElement['getContext']
}

function renderViewer(streamRotation: 0 | 90 | 180 | 270 = 0) {
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
    androidButtons: null,
    binaryFrameHandlerRef: { current: undefined },
    clipboardHandlerRef: { current: undefined },
    clipboardSupported: true,
    networkHandlerRef: { current: undefined },
    networkSupported: false,
    rebootPending: false,
    onReboot: vi.fn(),
    restartButtonRef: { current: null },
    screenWidth: 1080,
    screenHeight: 2400,
    streamRotation,
  // The prop surface is wide and none of it is what this file is about; the casts keep the
  // fixture from restating types the component already owns.
  } as unknown as React.ComponentProps<typeof AndroidViewer>
  const view = render(<AndroidViewer {...props} />)
  type Props = React.ComponentProps<typeof AndroidViewer>
  return {
    ...view,
    send,
    rotateStream: (next: 0 | 90 | 180 | 270) =>
      view.rerender(<AndroidViewer {...props} streamRotation={next} />),
    /** Anything else the agent can report in one go — a fold moves the turn and the screen together. */
    rerenderWith: (patch: Partial<Props>) =>
      view.rerender(<AndroidViewer {...props} {...patch} />),
  }
}

/** The `input:rotate` messages `send` was given, in order. */
const rotateCalls = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.filter(([m]) => (m as { type: string }).type === 'input:rotate')

/** The state `composeFrame` needs before it will draw anything: a surface, a size, a canvas. */
function readyToCompose() {
  const rc = document.createElement('canvas')
  rc.width = 1080; rc.height = 2400
  recordCanvas.current = rc
  act(() => {
    captured.onDecoderReady?.({ surface: document.createElement('canvas') })
    captured.onResize?.({ width: 1080, height: 2400 })
  })
}

/** The first `rotate` of a compose pass is the frame's own turn; the second is overlay space. */
const frameTurn = () => rotations[0]
/**
 * The turn the pointer overlay is drawn in — `totalTurn - streamRotation`, the user's own quarter
 * with the stream's correction taken back out.
 *
 * **Asserted separately because the two move independently.** A test that reads only the frame's
 * turn is blind to the overlay's arguments: passing `0` for `streamRotation` to `overlaySpace`,
 * or dropping it from `composeFrame`'s dependency list, leaves index 0 untouched and index 1
 * wrong. Both were measured green across all 681 tests before this existed — and drawing the
 * cursor in the wrong space is the defect the comment beside that call says has already shipped
 * twice, once against the frame and once against the picture.
 */
const overlayTurn = () => rotations[1]

describe('AndroidViewer — the turn a recorded frame is composed with', () => {
  beforeEach(() => {
    rotations.length = 0
    captured.compose = null; captured.started = false
    captured.onResize = null; captured.onDecoderReady = null
    recordCanvas.current = null
    stubCanvasContext()
  })
  afterEach(() => vi.restoreAllMocks())

  it('registers a composer, and starts the recorder', async () => {
    renderViewer()
    readyToCompose()
    expect(captured.compose).toBeTypeOf('function')
    await userEvent.click(screen.getByRole('button', { name: /record/i }))
    expect(captured.started).toBe(true)
  })

  it('draws the frame with the turn in force now, not the one recording began with', async () => {
    // **The reason the refs exist.** The recorder captured `composeFrame` at start; a rotation
    // after that must still reach the frames it draws.
    const { rotateStream } = renderViewer(0)
    readyToCompose()
    await userEvent.click(screen.getByRole('button', { name: /record/i }))

    act(() => captured.compose?.())
    expect(frameTurn()).toBe(0)

    rotations.length = 0
    act(() => { rotateStream(90) })
    act(() => captured.compose?.())

    expect(frameTurn()).toBe(90)
    // The stream turned the frame, so the overlay is already square with the screen.
    expect(overlayTurn()).toBe(0)
  })

  it('follows the rotate button too, which the stream never hears about', async () => {
    // **The other half, and the one only this test can see.** A turn reaches `composeFrame` two
    // ways: the agent reports a new `streamRotation`, or the tester presses rotate and the viewer
    // adds a CSS quarter of its own (`needsCSSRotation`) for a portrait-locked app that will never
    // report one. The tests above drive the first, which moves a prop `composeFrame` already
    // depends on — so they pass even if the composed turn is not a dependency at all. Measured:
    // dropping `totalTurn` from that dependency list failed nothing until this test existed.
    renderViewer(0)
    readyToCompose()
    await userEvent.click(screen.getByRole('button', { name: /record/i }))

    act(() => captured.compose?.())
    expect(frameTurn()).toBe(0)

    rotations.length = 0
    await userEvent.click(screen.getByRole('button', { name: /rotate the device/i }))
    act(() => captured.compose?.())

    expect(frameTurn()).toBe(90)
    // The quarter is the tester's alone this time, so the overlay carries all of it — the opposite
    // reading from the stream-driven test above, which is what makes the pair discriminating.
    expect(overlayTurn()).toBe(90)
  })

  it('keeps the overlay square when the stream takes over a turn the tester was holding', async () => {
    // **The one case that separates the two dependencies.** Unfolding turns the screen landscape,
    // so the viewer's own CSS quarter drops away at the same moment the stream starts correcting
    // by one — `totalTurn` holds at 90 while `streamRotation` goes 0 → 90. The frame is drawn
    // identically either way; only the overlay space moves. Every other test here moves both at
    // once, which is why dropping `streamRotation` from `composeFrame`'s dependencies was green.
    const { rerenderWith } = renderViewer(0)
    readyToCompose()
    await userEvent.click(screen.getByRole('button', { name: /record/i }))
    await userEvent.click(screen.getByRole('button', { name: /rotate the device/i }))

    act(() => captured.compose?.())
    expect(frameTurn()).toBe(90)
    expect(overlayTurn()).toBe(90)

    rotations.length = 0
    act(() => { rerenderWith({ streamRotation: 90, screenWidth: 2400, screenHeight: 1080 }) })
    act(() => captured.compose?.())

    expect(frameTurn()).toBe(90)
    expect(overlayTurn()).toBe(0)
  })

  it('follows a turn the other way too, so the reading is the angle and not merely "changed"', async () => {
    // 180 is the case an aspect-ratio inference cannot see at all, and 270 is the one it cannot
    // tell from 90. Asserting the angle rather than a difference is what makes this test able to
    // fail for the right reason.
    const { rotateStream } = renderViewer(0)
    readyToCompose()
    await userEvent.click(screen.getByRole('button', { name: /record/i }))

    for (const turn of [180, 270] as const) {
      rotations.length = 0
      act(() => { rotateStream(turn) })
      act(() => captured.compose?.())
      expect(frameTurn()).toBe(turn)
    }
  })
})

describe('AndroidViewer — putting the device back the way it was found', () => {
  beforeEach(() => {
    rotations.length = 0
    captured.compose = null; captured.started = false
    captured.onResize = null; captured.onDecoderReady = null
    recordCanvas.current = null
    stubCanvasContext()
  })
  afterEach(() => vi.restoreAllMocks())

  // **Held here because removing a suppression is not a refactor if nothing watched the code
  // under it.** The cleanup that undoes a rotation runs once, on unmount, so its dependency list
  // has to be empty — and an empty list closing over `send` and `sessionId` is what
  // `react-hooks/exhaustive-deps` was suppressed for. The React Compiler skips a whole file that
  // carries a suppression, whichever rule it names, so the suppression had to go; these say the
  // behaviour came through it. Nothing in this package asserted on `input:rotate` before.
  it('rotates the device back when the viewer goes away in landscape', async () => {
    const { send, unmount } = renderViewer(0)
    readyToCompose()

    await userEvent.click(screen.getByRole('button', { name: /rotate the device/i }))
    expect(rotateCalls(send)).toHaveLength(1)

    unmount()
    expect(rotateCalls(send)).toHaveLength(2)
    // The session the message is addressed to, not only that a message went out: the cleanup reads
    // `sessionId` at unmount now rather than capturing it at mount, and a count cannot tell a
    // rotate sent to this device from one sent to nobody.
    expect(rotateCalls(send)[1][0]).toEqual({ type: 'input:rotate', sessionId: 's1' })
  })

  it('leaves a device it never turned alone', () => {
    const { send, unmount } = renderViewer(0)
    readyToCompose()
    unmount()
    expect(rotateCalls(send)).toHaveLength(0)
  })

  it('does not undo a rotation the tester already undid', async () => {
    // Two presses is back where it started, and a third message on unmount would turn a device
    // the tester left upright.
    const { send, unmount } = renderViewer(0)
    readyToCompose()
    const rotate = screen.getByRole('button', { name: /rotate the device/i })
    await userEvent.click(rotate)
    await userEvent.click(rotate)

    unmount()
    expect(rotateCalls(send)).toHaveLength(2)
  })
})
