// The normalized 0-1 screen coordinate is the wire's own `Point` — the payload of
// `input:touch:*`. Re-exported under this package's name, which says the units out loud.
import type { Point } from '@tapflowio/protocol'
export type { Point as NormPoint }

/**
 * Convert a raw pointer position to a normalized screen coordinate for iOS.
 *
 * In landscape mode the container div is not CSS-rotated (the inner element is),
 * so `rect` is always the unrotated bounding rect. The rotation mapping is:
 *   portrait_x = 1 - v,  portrait_y = u
 * where u = horizontal fraction, v = vertical fraction of the unrotated rect.
 *
 * `compositeW` / `compositeH` and `screenRect` fields should already be halved
 * (chrome JSON stores 2× values; the caller divides by 2 before passing here).
 */
export function iosToNormScreen(
  point: Point,
  rect: { left: number; top: number; width: number; height: number },
  compositeW: number,
  compositeH: number,
  screenRect: { x: number; y: number; width: number; height: number },
  isLandscape: boolean,
): Point | null {
  const { x: sx, y: sy, width: sw, height: sh } = screenRect
  let cx: number, cy: number
  if (isLandscape) {
    const u = (point.x - rect.left) / rect.width
    const v = (point.y - rect.top) / rect.height
    cx = (1 - v) * compositeW
    cy = u * compositeH
  } else {
    cx = (point.x - rect.left) * (compositeW / rect.width)
    cy = (point.y - rect.top) * (compositeH / rect.height)
  }
  if (cx < sx || cx > sx + sw || cy < sy || cy > sy + sh) return null
  return { x: (cx - sx) / sw, y: (cy - sy) / sh }
}

/**
 * Convert a raw pointer position to a normalized screen coordinate for Android.
 *
 * When the canvas is CSS-rotated 90° CW (portrait content in landscape shell):
 *   portrait_x = yv,  portrait_y = 1 - xv
 */
export function androidToNorm(
  point: Point,
  rect: { left: number; top: number; width: number; height: number },
  needsCSSRotation: boolean,
): Point | null {
  const xv = (point.x - rect.left) / rect.width
  const yv = (point.y - rect.top) / rect.height
  if (xv < 0 || xv > 1 || yv < 0 || yv > 1) return null
  if (needsCSSRotation) return { x: yv, y: 1 - xv }
  return { x: xv, y: yv }
}

/**
 * Given the second finger's normalized position, return both finger positions
 * for a pinch gesture. The first finger is the point-symmetric counterpart.
 */
export function toPinchFingers(f1: Point): { f0: Point; f1: Point } {
  return { f0: { x: 1 - f1.x, y: 1 - f1.y }, f1 }
}

/**
 * Compute the display scale factor for an iOS chrome composite.
 * Caps the rendered height at `maxDisplayH` CSS pixels.
 */
export function iosDisplayScale(compositeLogicalH: number, maxDisplayH: number): number {
  return compositeLogicalH > 0 ? Math.min(1, maxDisplayH / compositeLogicalH) : 1
}

/** Quarter turns the viewer applies between the frame and the picture it shows. */
export type Turn = 0 | 90 | 180 | 270

/**
 * The whole turn from the frame to the picture: the stream's own correction plus the user's.
 *
 * **They add, and a device can need both at once.** One turns the video because the capture is
 * not the orientation Android is drawing; the other turns it again because the tester asked for
 * landscape and the app refused. Measured on a folded foldable at the lock screen: Android keeps
 * `rotation 0`, so the stream still needs its 270, and the rotate button wants a further 90 on
 * top. Two earlier versions each applied one and dropped the other, which is a half turn either
 * way — and in that same case the two cancel to 0, which is the cell that had no owner when the
 * layout was decided by one of them and the transform by the other.
 */
export function composeTurn(streamRotation: Turn, needsCSSRotation: boolean): Turn {
  return (((streamRotation + (needsCSSRotation ? 90 : 0)) % 360) as Turn)
}

/**
 * The size of the picture a turned frame produces — the frame's axes swapped by a quarter turn.
 *
 * **The frame is not the picture.** On the emulator's gRPC backend the capture is the panel in its
 * own fixed physical orientation, and the viewer turns it by `streamRotation`; a tester asking for
 * landscape on a portrait-locked app adds another quarter. Anything producing a file — a
 * screenshot, a recording — has to size itself to the picture, or it saves the frame behind it.
 * An unfolded foldable is portrait on screen and landscape in the frame, and recorded sideways.
 */
export function turnedSize(frameW: number, frameH: number, turn: Turn): { width: number; height: number } {
  const quarter = turn === 90 || turn === 270
  return { width: quarter ? frameH : frameW, height: quarter ? frameW : frameH }
}

/**
 * Where a turned frame lands inside a capture canvas: centred, scaled to fit, never stretched.
 *
 * The fit matters because `MediaRecorder` fixes the canvas size when recording starts. A device
 * folded *during* a take changes the frame's shape under it, and letterboxing is the honest
 * answer — the alternative is a picture stretched for the rest of the recording.
 */
export function placeTurnedFrame(
  canvasW: number, canvasH: number, frameW: number, frameH: number, turn: Turn,
): { picW: number; picH: number; scale: number; left: number; top: number } {
  const { width: picW, height: picH } = turnedSize(frameW, frameH, turn)
  const scale = Math.min(canvasW / picW, canvasH / picH)
  return { picW, picH, scale, left: (canvasW - picW * scale) / 2, top: (canvasH - picH * scale) / 2 }
}

/**
 * The box the video surface occupies inside the device shell, for a composed turn.
 *
 * **One expression owns the whole box, deliberately.** It used to be two: a Tailwind
 * `block w-full h-full` chosen by whether the *user's* quarter turn applied, and an inline style
 * chosen by the *total* turn. Those were interchangeable until the stream gained a correction of
 * its own, and then one cell had neither — a folded foldable at the lock screen, where the
 * stream's 270 and the user's 90 cancel to 0 while the CSS condition is still true. It happened to
 * lay out correctly, because in that cell the frame's aspect always equals the shell's, so the
 * surface's `height: 100%` resolved through the intrinsic ratio to the right number. Correct by
 * coincidence is the thing worth removing: the coincidence holds only while the frame and the
 * reported screen agree, which during a fold they briefly do not — and `getBoundingClientRect()`
 * of this element is what every tap is normalised against.
 *
 * A quarter turn takes the shell's dimensions swapped and centred, so that rotating it lands
 * exactly on the shell — which is what keeps the bezel still and the pointer maths honest.
 */
export function surfaceBox(turn: Turn, containerW: number, containerH: number):
  { width: number; height: number; left: number; top: number } {
  const quarter = turn === 90 || turn === 270
  const width = quarter ? containerH : containerW
  const height = quarter ? containerW : containerH
  return { width, height, left: (containerW - width) / 2, top: (containerH - height) / 2 }
}

/**
 * The space a recording's pointer overlay lives in, and how far to turn the canvas to reach it.
 *
 * **Not the frame, and not the picture.** `androidToNorm` undoes the user's quarter, so a stored
 * pointer is a fraction of the screen Android is drawing. Two bases have been wrong here: against
 * the frame it missed by the stream's correction, which is only nonzero on a foldable; against
 * the picture it missed by the user's quarter, on every backend including scrcpy, where it had
 * been correct for as long as the feature existed. The shown screen is the frame turned by the
 * stream's correction alone, and the remainder of the total is the turn to reach the picture.
 */
export function overlaySpace(
  frameW: number, frameH: number, totalTurn: Turn, streamRotation: Turn,
): { width: number; height: number; turn: Turn } {
  const { width, height } = turnedSize(frameW, frameH, streamRotation)
  return { width, height, turn: (((totalTurn - streamRotation + 360) % 360) as Turn) }
}

/**
 * Whether to show the picture, or hold it back while the frame and the description disagree.
 *
 * **The disagreement has two directions and only one of them resolves itself.**
 *
 * The frame changes the moment the device does; `session:chrome` arrives once the agent has read
 * the settled display. In between, a new frame is drawn into the old frame's box — stretched and
 * a quarter turn out — which is the flash this gate exists to suppress. That case ends on its own,
 * because the description is already on its way.
 *
 * The other direction does not. The agent also learns of a panel change from its own poll, so the
 * description can arrive with **no frame behind it** — and the emulator's capture is frame-driven,
 * so a screen that is static after a fold sends nothing at all. Hiding until the frame catches up
 * then hides forever: measured, a foldable left on "Changing posture…" until the tester touched
 * the device. A gate with no exit is the defect, whatever kept the frame away.
 *
 * So the aspect check only holds the picture back when the **frame** is the newer of the two. When
 * the description is newer, the last frame is shown in the new box — stale, and visibly the
 * previous screen, which is a better answer than a placeholder that never clears.
 */
export function showsPicture(opts: {
  ready: boolean
  aspectAgrees: boolean
  frameIsAhead: boolean
  rotating: boolean
}): boolean {
  if (!opts.ready || opts.rotating) return false
  return opts.aspectAgrees || !opts.frameIsAhead
}

/**
 * Does the frame, once the stream's correction is applied, describe the same screen the agent does?
 *
 * The two arrive on different paths: the stream changes shape the moment the emulator does, and
 * `session:chrome` only once the agent has read the settled display. In the window between them a
 * new frame is drawn into the old frame's box — stretched and a quarter turn out — which is the
 * flash. Compared rather than timed: the question is not "how long does a fold take" but "do
 * these two describe the same screen", and both values are already to hand.
 *
 * **The stream's correction, not the composed turn.** The user's quarter does not change the
 * frame's shape, so folding it in would invert the test.
 *
 * Aspect rather than size, because the stream may be downscaled by the server-side resize and a
 * downscale preserves the ratio. The tolerance covers the encoder's 16-pixel alignment — a
 * 2076-wide panel is encoded 2080 wide. Unknown sizes agree: before the first frame there is
 * nothing to disagree with, and the first-frame hold is a separate gate.
 */
export function framesAgree(
  video: { width: number; height: number } | null,
  shown: { width: number; height: number } | null,
  streamRotation: Turn,
): boolean {
  if (!video || !shown) return true
  const { width, height } = turnedSize(video.width, video.height, streamRotation)
  return Math.abs(width / height - shown.width / shown.height) < 0.05
}
