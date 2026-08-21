---
"@tapflowio/android-agent": minor
---

Take an Android emulator off the network and put it back (#607), via airplane mode.

`adb shell cmd connectivity airplane-mode` takes the **OS** offline rather than lying to the app, so
the app's own connectivity callbacks fire and the status bar follows with nothing faked. Measured on
API 34: `dumpsys connectivity` reports no active network and a ping from the guest fails.

Every write is confirmed by reading the state back. An image that does not know the subcommand exits
non-zero and is reported as a device that cannot do this — an answer the viewer can render, not an
error — but a command that succeeds and changes nothing would otherwise be reported as a device
taken offline, and tapflow's output is a judgement about someone else's app.

A device left offline by whoever had it last is cleared **on the way up**, not at teardown. Airplane
mode lives in the AVD's userdata and outlives `emu kill`, and a session that ended in a crash or a
closed terminal never reaches a teardown path at all.
