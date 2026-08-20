---
"@tapflowio/android-agent": minor
---

Honour Full reset on Android: `handleDeviceBoot` reads `resetMode`, and the emulator is launched with
`-wipe-data`.

`-no-snapshot` was already there and is not this — it is a cold boot, which skips the snapshot and
keeps `userdata`, so nothing wiped anything before. Because `-wipe-data` only applies at launch, an
emulator that is already running is stopped and relaunched, the same answer iOS gives for `simctl
erase` refusing a booted device. The agent advertises the `full-reset` capability now, which is what
puts the toggle on screen.
