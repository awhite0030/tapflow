---
type: diagnosis
topics: [android, foldable, touch, emulator, grpc]
status: stable
---

# Why a folded foldable's taps land on the wrong icon, and which size fixes it

> Read this before changing how `AndroidAgent.toDevicePx` scales a normalised point, or before
> "correcting" `toNaturalPoint`. The rotation maths is not the bug and was suspected three times.

## The symptom, and why it reads as a rotation bug

Folded and in landscape, a tap on the Pixel 9 Pro Fold's launcher opened the app **one grid row
above** the one under the cursor. Unfolded, every tap was fine. That shape — a device that works in
one configuration and misses in another — points straight at the rotation maths, and it is wrong.

Two measurements rule rotation out, and either one is enough:

- **A swipe keeps its direction.** Swiping up opened the app drawer. A 90°, 180° or 270° error
  turns an upward swipe sideways or downward; none of them leaves it upward.
- **The miss has no horizontal component.** Tapping Camera opened the app directly above it, in the
  same column. A rotation error moves both axes.

## What it actually is

`EmulatorController.sendTouch` takes pixels and the emulator converts them into its touch device's
range. **The divisor is the emulator's own display size, not the panel the guest is drawing on.**

On this device they are the same number until it folds:

| | guest panel (`dumpsys`) | emulator display 0 |
|---|---|---|
| unfolded | 2076x2152 | 2076x2152 |
| folded | 1080x2424 | 2076x2152 |

So scaling by the panel sent every folded tap 2076/1080 = **1.92x** too far along one axis and
2152/2424 = **0.89x** along the other. The vertical term dominated what a person saw, which is why
it looked like a pure offset.

The unfolded column is why this shipped: the panel *is* `hw.lcd` there, the two divisors agree, and
nothing about the code looks conditional.

## The three sources that are not the answer

- **`dumpsys window displays`.** The guest's current panel. Correct about what is being drawn,
  which is a different question from what input is measured in.
- **`getevent -lp`.** The touchscreen's `ABS_MT_POSITION_X/Y` range, which on this emulator is a
  normalised **32768x32768** — not pixels at all. Dividing by it broke touch outright.
- **The proto comment.** `Touch.x/y` are documented as "the physical location on the screen", which
  reads as the panel and is the sentence that makes this look settled. It predates foldables.

The answer is `getDisplayConfigurations`, display 0 — ask the component doing the conversion.
`EmulatorGrpcClient.getDisplaySize` is that call, read once per stream before the first frame, and
`null` on any failure so an emulator too old to answer falls back to the panel size, which is what
every release before this one used.

**scrcpy is excluded.** Its control channel takes the frame's own pixels, so the panel size is
already right there; applying the emulator's display size would break the backend that works.

## The method, since the shape of this recurs

Four attempts fitted a constant to one screenshot, and each one fixed the case in front of it and
broke another. What ended it was not a better guess:

1. **Instrument the whole chain, not the ends.** `TAPFLOW_TOUCH_DEBUG=1` prints the viewer point,
   the rotation, the natural point, the divisor and the pixels for one tap. Every stage of this
   transform is invisible from the outside, and a tap that lands wrong says nothing about which
   stage moved it.
2. **Ask for a measurement that separates the candidates**, not for another report of the bug. The
   swipe distinguishes a rotation from an offset in one gesture and needs nothing measured.
3. **Read the constant from the device.** Deriving 2076x2152 from the posture list would give the
   same two numbers on this device and nothing on the next one.
