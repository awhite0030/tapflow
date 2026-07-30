---
"@tapflowio/ios-agent": patch
---

Remove the dead `Simulator.app` hide from `SimctlWrapper.boot`. On the supported Xcode (26.x) `simctl boot` does not open Simulator.app, so the `osascript` call failed with `-10006` on every boot while its callback swallowed the error — it hid nothing, and its silence meant nobody would notice if the assumption changed back. The occlusion throttle it was guarding against only applies to a window that is on screen. Verified by quitting Simulator.app entirely and booting from the dashboard: no Simulator process appears.

Also make `SimctlWrapper.shutdown` tolerate an already-stopped device, mirroring the guard `boot` has had. Tearing down a session whose device is already `Shutdown` raised `code=405 / Unable to shutdown device in current state: Shutdown`, so a routine teardown logged `shutdown failed` and became indistinguishable from a device that genuinely refused to stop.
