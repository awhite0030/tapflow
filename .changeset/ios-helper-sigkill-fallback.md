---
"@tapflowio/ios-agent": patch
---

`TouchHelper` and `KeyboardHelperDaemon` now escalate to `SIGKILL` if their helper process (`touch-helper` / `keyboard-helper`) does not exit within 1s of `SIGTERM` on `stop()`, matching the fallback already used by `ScreenCaptureStreamer` and `XCUITreeReader`. Previously `stop()` sent `SIGTERM` only, so a wedged helper process would linger indefinitely.
