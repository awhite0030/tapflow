import { describe, it, expect } from 'vitest'
import { parseDisplayMetrics } from '../displayMetrics'

// Verbatim from a Pixel 9 Pro Fold (API 36), 2026-09-18. The two postures are the whole point: the
// panel changes, and so does whether Android is rotating it.
const UNFOLDED = `  Display: mDisplayId=0
    init=2076x2152 390dpi mMinSizeOfResizeableTaskDp=220 cur=2152x2076 app=2152x2076 rng=2076x2076-2152x2152
  overrideConfig={1.0 [en_US] land winConfig={ mBounds=Rect(0, 0 - 2152, 2076) mDisplayRotation=ROTATION_270 mRotation=ROTATION_270} }`

const FOLDED = `  Display: mDisplayId=0
    init=1080x2424 390dpi mMinSizeOfResizeableTaskDp=220 cur=1080x2424 app=1080x2424 rng=1080x1080-2424x2424
  overrideConfig={1.0 [en_US] port winConfig={ mBounds=Rect(0, 0 - 1080, 2424) mDisplayRotation=ROTATION_0 mRotation=ROTATION_0} }`

describe('parseDisplayMetrics', () => {
  it('separates the panel from what is drawn on it', () => {
    expect(parseDisplayMetrics(UNFOLDED)).toEqual({
      natural: { width: 2076, height: 2152 },
      current: { width: 2152, height: 2076 },
      rotation: 270,
    })
  })

  it('reads a folded device, where the panel changed and the rotation went back to 0', () => {
    expect(parseDisplayMetrics(FOLDED)).toEqual({
      natural: { width: 1080, height: 2424 },
      current: { width: 1080, height: 2424 },
      rotation: 0,
    })
  })

  it('reads the rotation rather than deriving it from the aspect', () => {
    // The unfolded panel is 2076x2152 — nearly square. Deriving rotation from which side is longer
    // cannot tell 0 from 180, and cannot tell 90 from 270 at all, so a derived value would be a
    // coin flip on exactly the device this exists for.
    const halfTurn = UNFOLDED.replace(/ROTATION_270/g, 'ROTATION_180')
    expect(parseDisplayMetrics(halfTurn)?.rotation).toBe(180)
  })

  it('defaults to 0 when the rotation is absent rather than guessing', () => {
    const noRot = FOLDED.replace(/mRotation=ROTATION_0/, '')
    expect(parseDisplayMetrics(noRot)?.rotation).toBe(0)
  })

  it('returns null when the dump has no display line', () => {
    expect(parseDisplayMetrics('')).toBeNull()
    expect(parseDisplayMetrics('WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)')).toBeNull()
  })
})
