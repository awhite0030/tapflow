---
"@tapflowio/android-agent": minor
---

Honour Full reset on Android: `handleDeviceBoot` reads `resetMode`, and the emulator is launched with
`-wipe-data`.

`-no-snapshot` was already there and is not this — it is a cold boot, which skips the snapshot and
keeps `userdata`, so nothing wiped anything before. Because `-wipe-data` only applies at launch, an
emulator that is already running is stopped and relaunched, the same answer iOS gives for `simctl
erase` refusing a booted device.

Whether one is running is asked of the process rather than of adb, since adb reports an emulator that
is still coming up as shut down and a second emulator on the same AVD would race its lock file. That
probe distinguishes "nothing is running" from "the lookup could not run", and only the first permits a
launch. If the emulator will not exit, or cannot be observed at all, the boot fails with an error: a relaunch that loses the lock exits
unseen, and the surviving emulator is what the agent would then find and report ready — a Full reset
that never happened, announced as complete.

The agent advertises the `full-reset` capability now, which is what puts the toggle on screen.
