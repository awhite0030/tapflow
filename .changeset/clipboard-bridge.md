---
"@tapflowio/relay": minor
"@tapflowio/ios-agent": minor
"@tapflowio/android-agent": minor
---

Share the clipboard between the dashboard and the simulator/emulator.

**Paste** works everywhere, including plain-HTTP LAN deployments: Cmd/Ctrl+V in the viewer sends your clipboard to the device and pastes it there.

**Copy** needs the dashboard served over HTTPS (or localhost). Cmd/Ctrl+C then brings what you copied on the device to your own clipboard in one press. On plain HTTP the copy still lands on the device and the dashboard says why it stopped there: proving the copy actually happened takes a round trip, and no clipboard API available on plain HTTP accepts a value that arrives that late. tapflow already supports LAN HTTPS, which WebCodecs hardware decoding also benefits from.

Previously neither direction existed: text copied inside the simulator had no way out, so accounts, tokens and deep links had to be retyped by hand.

- iOS reads and writes the device pasteboard through `simctl pbpaste`/`pbcopy`.
- Android uses the emulator's gRPC clipboard API (the AVD images do not implement `adb shell cmd clipboard`). Devices on the scrcpy backend report the feature as unsupported instead of failing silently.
- The agent presses the device-side chord itself and confirms the clipboard actually changed before answering, so a slow or busy device cannot hand back the previous value as if it were freshly copied.
- Adds the `clipboard:read` / `clipboard:write` / `clipboard:data` / `clipboard:write-done` / `clipboard:error` messages. Purely additive: an agent that does not know them never replies, and the viewer then presses the plain chord so the device still copies or pastes on its own.
