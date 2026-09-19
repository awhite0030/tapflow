/** What the display is, and what it is currently showing. */
export interface DisplayMetrics {
  /** The panel's own dimensions, unrotated. `adb wm size` reports this, and the emulator's gRPC
   *  input takes coordinates in it. */
  natural: { width: number; height: number }
  /** What Android is drawing right now — `natural` with the rotation applied. This is the picture a
   *  viewer must frame, and the space a person points at. */
  current: { width: number; height: number }
  /** Quarter turns clockwise from `natural` to `current`: 0, 90, 180 or 270. */
  rotation: 0 | 90 | 180 | 270
}

/**
 * Parse `adb shell dumpsys window displays`.
 *
 * **Why not `wm size`.** That reports only the natural dimensions, and on a rotated display it is
 * the wrong way round for anything a person sees — measured on a Pixel 9 Pro Fold unfolded:
 * `wm size` 2076x2152 while the live screen was 2152x2076.
 *
 * **Why not the emulator's own rotation field.** The gRPC frame carries a `rotation`, and it is the
 * device's *physical* orientation rather than the display's. Folded, it still says
 * `REVERSE_LANDSCAPE` while Android has rotated the screen back to 0 — so a coordinate map built on
 * it is right unfolded and wrong folded. The two agreed until a foldable made them disagree.
 *
 * The line looks like:
 * `init=2076x2152 390dpi mMinSizeOfResizeableTaskDp=220 cur=2152x2076 app=2152x2076 rng=…`
 */
export function parseDisplayMetrics(output: string): DisplayMetrics | null {
  const dims = output.match(/init=(\d+)x(\d+)[^\n]*?cur=(\d+)x(\d+)/)
  if (!dims) return null
  const natural = { width: Number(dims[1]), height: Number(dims[2]) }
  const current = { width: Number(dims[3]), height: Number(dims[4]) }
  // `mRotation=ROTATION_270`. Read rather than derived: a square-ish display (the unfolded foldable
  // is 2076x2152) cannot tell 0 from 180, and derived-from-aspect cannot tell 90 from 270 at all.
  const rot = output.match(/mRotation=ROTATION_(\d+)/)
  const quarter = rot ? Number(rot[1]) : 0
  const rotation = ([0, 90, 180, 270] as const).find((r) => r === quarter) ?? 0
  return { natural, current, rotation }
}

/**
 * The rounded-corner radius, in device pixels, of the panel with these natural dimensions.
 *
 * **Read from Android rather than measured off the picture.** `detectCornerRadius` finds the run of
 * black down the frame's left edge, which is the radius only while the frame is upright — and the
 * emulator's capture is a quarter turn from the screen, so on a foldable it measured a side that
 * has no corner on it. Android already knows the number.
 *
 * Folding swaps to a different panel with a different curve: measured on a Pixel 9 Pro Fold, 85px
 * on the 2076-wide inner display and 115px on the 1080-wide cover, so 4.1% becomes 10.6%. The size
 * is what picks between them, because `dumpsys display` lists every panel whether it is on or not.
 *
 * **Returns device pixels, not a fraction.** It used to divide by the panel's natural width, which
 * is the wrong basis the moment the display is rotated: the corner is a physical property of the
 * panel and does not move, but the width the viewer scales it against is the *shown* width, which
 * swaps. Folded and turned to landscape, a cover panel's 115px over 1080 came out 2.24x too round.
 * Matching a panel still uses the natural size, because that is how `dumpsys` lists them — keeping
 * the match and the normalisation on one basis is what produced the bug.
 *
 * Returns null when no panel matches, which leaves the caller's existing value alone rather than
 * flattening the corners to square.
 */
export function parseCornerRadius(output: string, width: number, height: number): number | null {
  // Each panel prints its size and then, further into the same record, its corners.
  const blocks = output.split('"Built-in Screen"').slice(1)
  for (const block of blocks) {
    const size = block.match(/(\d+) x (\d+)/)
    if (!size || Number(size[1]) !== width || Number(size[2]) !== height) continue
    const radius = block.match(/RoundedCorner\{position=TopLeft, radius=(\d+)/)
    if (!radius) return null
    return Number(radius[1])
  }
  return null
}
