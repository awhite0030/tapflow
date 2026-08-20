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
is still coming up as shut down, and a second emulator on the same AVD would race its lock file. With
nothing running the launch is immediate; a running one is stopped first and launches once its process
is confirmed gone.

The probe holds both of those apart from a third state — the lookup could not run — which launches
nothing at all. Neither does an emulator that will not exit. Proceeding in either case would report a
Full reset that never happened: the relaunch loses the lock and exits unseen, and the survivor is what
the agent finds and announces ready.

The agent advertises the `full-reset` capability now, which is what puts the toggle on screen.
