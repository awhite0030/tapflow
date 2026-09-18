import { describe, it, expect } from 'vitest'
import { iosToNormScreen,
  androidToNorm,
  toPinchFingers,
  iosDisplayScale, placeTurnedFrame, turnedSize, surfaceBox, composeTurn, overlaySpace, showsPicture } from '@/lib/coordinate-transform'

// ── helpers ──────────────────────────────────────────────────────────────────

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height }
}

function srect(x: number, y: number, width: number, height: number) {
  return { x, y, width, height }
}

// ── iosToNormScreen — portrait ────────────────────────────────────────────────

describe('iosToNormScreen — portrait', () => {
  const r = rect(0, 0, 200, 400)
  const cw = 200, ch = 400
  const fullScreen = srect(0, 0, 200, 400)

  it('정중앙 → {0.5, 0.5}', () => {
    expect(iosToNormScreen({ x: 100, y: 200 }, r, cw, ch, fullScreen, false))
      .toEqual({ x: 0.5, y: 0.5 })
  })

  it('bezel 클릭(screenRect 바깥) → null', () => {
    const inner = srect(50, 50, 100, 300)
    expect(iosToNormScreen({ x: 10, y: 10 }, r, cw, ch, inner, false)).toBeNull()
  })

  it('screenRect 우하단 경계 정확히 → {1, 1}', () => {
    const inner = srect(50, 50, 100, 300)
    // click at (50+100, 50+300) = (150, 350)
    // cx = 150 * (200/200) = 150, cy = 350 * (400/400) = 350
    // (cx - sx)/sw = (150-50)/100 = 1, (cy-sy)/sh = (350-50)/300 = 1
    expect(iosToNormScreen({ x: 150, y: 350 }, r, cw, ch, inner, false))
      .toEqual({ x: 1, y: 1 })
  })
})

// ── iosToNormScreen — landscape ───────────────────────────────────────────────
// In landscape the rect is the outer unrotated div (width=portraitH, height=portraitW).
// Mapping: portrait_x = 1-v, portrait_y = u  (where u=xFrac, v=yFrac of landscape rect)

describe('iosToNormScreen — landscape rotation (off-by-one guard)', () => {
  // Landscape rect: width=compositeH, height=compositeW so that u/v are direct fractions
  const cw = 200, ch = 400
  const fullScreen = srect(0, 0, 200, 400)
  const landscapeRect = rect(0, 0, ch, cw) // width=400, height=200

  it('시각 좌상단(u=0,v=0) → portrait {1, 0}', () => {
    // u=0,v=0 → cx=(1-0)*200=200, cy=0*400=0 → {(200-0)/200, (0-0)/400} = {1, 0}
    expect(iosToNormScreen({ x: 0, y: 0 }, landscapeRect, cw, ch, fullScreen, true))
      .toEqual({ x: 1, y: 0 })
  })

  it('시각 정중앙(u=0.5,v=0.5) → portrait {0.5, 0.5}', () => {
    // u=0.5,v=0.5 → cx=0.5*200=100, cy=0.5*400=200 → {0.5, 0.5}
    expect(iosToNormScreen({ x: ch * 0.5, y: cw * 0.5 }, landscapeRect, cw, ch, fullScreen, true))
      .toEqual({ x: 0.5, y: 0.5 })
  })

  it('시각 우하단(u=1,v=1) → portrait {0, 1}', () => {
    // u=1,v=1 → cx=(1-1)*200=0, cy=1*400=400 → {0, 1}
    expect(iosToNormScreen({ x: ch, y: cw }, landscapeRect, cw, ch, fullScreen, true))
      .toEqual({ x: 0, y: 1 })
  })

  it('시각 우상단(u=0,v=1) → portrait {0, 0}', () => {
    // u=0,v=1 → cx=0, cy=0 → {0, 0}
    expect(iosToNormScreen({ x: 0, y: cw }, landscapeRect, cw, ch, fullScreen, true))
      .toEqual({ x: 0, y: 0 })
  })
})

// ── androidToNorm — portrait ──────────────────────────────────────────────────

describe('androidToNorm — portrait', () => {
  const r = rect(0, 0, 360, 800)

  it('정중앙 → {0.5, 0.5}', () => {
    expect(androidToNorm({ x: 180, y: 400 }, r, false)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('범위 밖 클릭 → null', () => {
    expect(androidToNorm({ x: -10, y: 50 }, r, false)).toBeNull()
  })
})

// ── androidToNorm — landscape CSS rotation ───────────────────────────────────
// Canvas rotated 90° CW: portrait_x = yv, portrait_y = 1 - xv

describe('androidToNorm — landscape (CSS rotate 90deg CW)', () => {
  const r = rect(0, 0, 1, 1) // unit rect so xv=x, yv=y

  it('시각 좌상단(xv=0,yv=0) → portrait {0, 1}', () => {
    expect(androidToNorm({ x: 0, y: 0 }, r, true)).toEqual({ x: 0, y: 1 })
  })

  it('시각 우하단(xv=1,yv=1) → portrait {1, 0}', () => {
    expect(androidToNorm({ x: 1, y: 1 }, r, true)).toEqual({ x: 1, y: 0 })
  })
})

// ── toPinchFingers ────────────────────────────────────────────────────────────

describe('toPinchFingers', () => {
  it('f1이 {0.3, 0.4} → f0는 점 대칭 {0.7, 0.6}', () => {
    const { f0, f1 } = toPinchFingers({ x: 0.3, y: 0.4 })
    expect(f0).toEqual({ x: 0.7, y: 0.6 })
    expect(f1).toEqual({ x: 0.3, y: 0.4 })
  })

  it('f1이 정중앙 → f0도 정중앙', () => {
    const { f0, f1 } = toPinchFingers({ x: 0.5, y: 0.5 })
    expect(f0).toEqual({ x: 0.5, y: 0.5 })
    expect(f1).toEqual({ x: 0.5, y: 0.5 })
  })
})

// ── iosDisplayScale ───────────────────────────────────────────────────────────

describe('iosDisplayScale', () => {
  it('compositeH < maxH → scale 1', () => {
    expect(iosDisplayScale(500, 800)).toBe(1)
  })

  it('compositeH > maxH → maxH / compositeH', () => {
    expect(iosDisplayScale(1600, 800)).toBe(0.5)
  })

  it('compositeH = 0 → 1 (division-by-zero guard)', () => {
    expect(iosDisplayScale(0, 800)).toBe(1)
  })
})

describe('turnedSize / placeTurnedFrame — what a capture is sized to', () => {
  // The measured case. An unfolded Pixel 9 Pro Fold at rotation 0: the emulator captures the panel
  // in its own physical orientation (2152x2076, landscape) and the viewer turns it 270 to show
  // 2076x2152. Recording and screenshot used to save the frame, so both came out landscape.
  it('swaps the axes on a quarter turn, which is the bug that shipped', () => {
    expect(turnedSize(2152, 2076, 270)).toEqual({ width: 2076, height: 2152 })
    expect(turnedSize(2152, 2076, 90)).toEqual({ width: 2076, height: 2152 })
  })

  it('leaves them alone on a half turn — the case an aspect comparison cannot see', () => {
    // The old code inferred the turn by comparing the canvas's aspect to the frame's. That cannot
    // tell 90 from 270, and 180 is invisible to it entirely: same shape, upside down.
    expect(turnedSize(2152, 2076, 180)).toEqual({ width: 2152, height: 2076 })
    expect(turnedSize(2152, 2076, 0)).toEqual({ width: 2152, height: 2076 })
  })

  it('fills a canvas sized to the picture exactly, with no offset', () => {
    // The normal recording: the canvas was sized from `turnedSize` at record start.
    const { picW, picH, scale, left, top } = placeTurnedFrame(2076, 2152, 2152, 2076, 270)
    expect([picW, picH]).toEqual([2076, 2152])
    expect(scale).toBe(1)
    expect([left, top]).toEqual([0, 0])
  })

  it('letterboxes when the device folds mid-recording rather than stretching', () => {
    // MediaRecorder fixed the canvas at 2076x2152 (unfolded). The device folds: the frame is now
    // 2424x1080 and, at rotation 0, the picture is 1080x2424 — taller and narrower.
    const { picW, picH, scale, left, top } = placeTurnedFrame(2076, 2152, 2424, 1080, 270)
    expect([picW, picH]).toEqual([1080, 2424])
    // Height-bound: 2152/2424 < 2076/1080, so the fit takes the smaller of the two.
    expect(scale).toBeCloseTo(2152 / 2424, 10)
    expect(top).toBe(0)
    expect(left).toBeGreaterThan(0)
    // Centred, and inside the canvas on both axes — the property that says it is not stretched.
    expect(left * 2 + picW * scale).toBeCloseTo(2076, 6)
    expect(picH * scale).toBeCloseTo(2152, 6)
  })

  it('is width-bound the other way round, so the fit is not a height rule in disguise', () => {
    const { scale, left, top } = placeTurnedFrame(1000, 4000, 500, 500, 0)
    expect(scale).toBe(2)          // width-bound: 1000/500 < 4000/500
    expect(left).toBe(0)
    expect(top).toBe(1500)
  })
})

describe('composeTurn / surfaceBox — the one cell that had no owner', () => {
  // **The real rule, imported.** This suite used to re-declare the expression and assert the
  // copy, so it was green whatever the component did with it — including the layout bug below.
  it('adds the user\'s quarter to the stream\'s correction', () => {
    expect(composeTurn(270, false)).toBe(270)
    expect(composeTurn(0, true)).toBe(90)
  })

  it('wraps to 0 when the two cancel — the folded lock screen', () => {
    // Android refuses the rotation, so the stream still needs its 270 and the user's 90 goes on
    // top. The picture is right at 0; what was wrong was everything keyed on *which* of the two
    // conditions was true, because here they disagree.
    expect(composeTurn(270, true)).toBe(0)
  })

  it('gives a full-size box at every half turn and a swapped, centred one at every quarter', () => {
    expect(surfaceBox(0, 800, 400)).toEqual({ width: 800, height: 400, left: 0, top: 0 })
    expect(surfaceBox(180, 800, 400)).toEqual({ width: 800, height: 400, left: 0, top: 0 })
    // Swapped and centred, so rotating it lands exactly on the shell — which is what keeps the
    // bezel still and makes `getBoundingClientRect()` the basis every tap is normalised against.
    expect(surfaceBox(90, 800, 400)).toEqual({ width: 400, height: 800, left: 200, top: -200 })
    expect(surfaceBox(270, 800, 400)).toEqual({ width: 400, height: 800, left: 200, top: -200 })
  })

  it('sizes the cancelled cell, which is the regression', () => {
    // `composeTurn(270, true) === 0` while the CSS condition is still true. The layout used to be
    // chosen by that condition and the transform by the total, so this cell got neither a class
    // nor a size and laid out only by an aspect coincidence. One function owns it now.
    const shell = { w: 800, h: 400 }
    expect(surfaceBox(composeTurn(270, true), shell.w, shell.h))
      .toEqual({ width: 800, height: 400, left: 0, top: 0 })
  })

  it('always covers the shell once rotated, for all four turns', () => {
    // The property behind both cases: the box's rotated extent equals the shell exactly.
    for (const turn of [0, 90, 180, 270] as const) {
      const b = surfaceBox(turn, 800, 400)
      const quarter = turn === 90 || turn === 270
      expect(quarter ? b.height : b.width).toBe(800)
      expect(quarter ? b.width : b.height).toBe(400)
      expect(b.left * 2 + b.width).toBe(800)
      expect(b.top * 2 + b.height).toBe(400)
    }
  })
})

describe('overlaySpace — where a recording draws the cursor', () => {
  // The frame is the panel as the emulator captures it. The pointer is stored in the space
  // Android draws, which is the frame turned by the stream's correction alone.
  it('is the shown screen, and needs no further turn when the user asked for nothing', () => {
    expect(overlaySpace(2152, 2076, 270, 270)).toEqual({ width: 2076, height: 2152, turn: 0 })
  })

  it('keeps the user\'s quarter as the turn, not as part of the space', () => {
    // scrcpy with a portrait-locked app and Rotate pressed: no stream correction, and the
    // overlay space stays the frame while the canvas turns 90. Drawing in the *picture's* space
    // here is the regression — it put the cursor a quarter turn from the finger on the backend
    // where this had always worked.
    expect(overlaySpace(1080, 2400, 90, 0)).toEqual({ width: 1080, height: 2400, turn: 90 })
  })

  it('splits both corrections on a folded foldable at the lock screen', () => {
    // Stream 270 and user 90 cancel in the total, but the space is still the shown screen and
    // the canvas still owes the user's quarter. A single composed number cannot express this,
    // which is why the two are carried separately.
    expect(overlaySpace(2424, 1080, 0, 270)).toEqual({ width: 1080, height: 2424, turn: 90 })
  })

  it('leaves the frame alone when nothing is turned at all', () => {
    expect(overlaySpace(1080, 2400, 0, 0)).toEqual({ width: 1080, height: 2400, turn: 0 })
  })
})

describe('showsPicture — the gate that latched', () => {
  const gate = (o: Partial<Parameters<typeof showsPicture>[0]> = {}) => showsPicture({
    ready: true, aspectAgrees: true, frameIsAhead: false, rotating: false, ...o,
  })

  it('shows the picture when the frame and the description agree', () => {
    expect(gate()).toBe(true)
  })

  it('hides the flash: a new frame with the old description still on screen', () => {
    // The frame changes the moment the device does, so for a beat it is drawn into the previous
    // box — stretched and a quarter turn out. The description is already on its way.
    expect(gate({ aspectAgrees: false, frameIsAhead: true })).toBe(false)
  })

  it('does NOT hide a description that arrived with no frame behind it', () => {
    // **The latch.** The agent also learns of a panel change from its own poll, and the
    // emulator's capture is frame-driven — a screen that is static after a fold sends nothing.
    // Measured: a foldable sat on "Changing posture…" until the tester touched the device.
    expect(gate({ aspectAgrees: false, frameIsAhead: false })).toBe(true)
  })

  it('still waits for the first frame, and for a rotation in flight', () => {
    // The two holds that are bounded by something other than a frame arriving.
    expect(gate({ ready: false })).toBe(false)
    expect(gate({ rotating: true })).toBe(false)
    // And neither is overridden by the agreement above.
    expect(gate({ ready: false, aspectAgrees: false, frameIsAhead: false })).toBe(false)
  })
})
