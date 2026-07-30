---
"@tapflowio/ios-agent": patch
---

Remove the dead `Simulator.app` hide from `SimctlWrapper.boot`. On the supported Xcode (26.x) `simctl boot` does not open Simulator.app, so the `osascript` call failed with `-10006` on every boot while its callback swallowed the error — it hid nothing, and its silence meant nobody would notice if the assumption changed back. The occlusion throttle it was guarding against only applies to a window that is on screen.
