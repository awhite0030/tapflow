---
"@tapflowio/ios-agent": patch
---

Target the session's simulator, not "whichever one is booted".

Every app command in `SimctlWrapper` passed `booted` — simctl's alias for the running device — instead of the session's udid: `install`, `launch`, `uninstall`, `terminate`, `get_app_container`, `io screenshot`. With one simulator up that happens to be right. With two, the command lands on whichever simctl picks, and the wrong device accepts it without complaint. Today the defect usually surfaces as `No devices are booted` — loud, and only because nothing was running at all. The quiet case is the one worth fixing.

`AndroidAgent` already passes an explicit serial; this brings iOS in line.

- The udid is a required leading parameter with **no default**. A default is how the alias would come back: every call site keeps compiling and every test stays green while the old behaviour returns. `ScreenCaptureStreamer`'s `udid: string = 'booted'` was exactly that, and it is gone too.
- Session call sites pass `DeviceState.deviceId`. `MjpegStreamer` takes the device through its constructor rather than reaching for the alias mid-stream.
- The three `DeviceAgent` entry points (`installApp`, `launchApp`, `screenshot`) have no device parameter — the interface is shared with Android and predates multi-session agents. They resolve the single live session and **throw** when there is none, the same shape `AndroidAgent` uses. Falling back to the alias there would be the original bug wearing a different hat.

One call the compiler could not catch: `screenshot(format)` stayed type-correct when a leading `udid: string` was added — the format string simply became the device id. Tests assert the arguments rather than trusting the signature.
