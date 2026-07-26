---
"@tapflowio/relay": minor
"@tapflowio/ios-agent": minor
"@tapflowio/android-agent": minor
---

Share the clipboard between the dashboard and the simulator/emulator.

Cmd/Ctrl+C in the viewer now puts what you copied on the device onto your own clipboard, and Cmd/Ctrl+V pastes your clipboard into the device — the same shortcuts, the same meaning on both sides. Works on iOS and Android, and on plain-HTTP LAN deployments (no HTTPS required).

Previously neither direction existed: text copied inside the simulator had no way out, so accounts, tokens and deep links had to be retyped by hand.

- iOS reads and writes the device pasteboard through `simctl pbpaste`/`pbcopy`.
- Android uses the emulator's gRPC clipboard API (the AVD images do not implement `adb shell cmd clipboard`). Real devices on the scrcpy backend report the feature as unsupported instead of failing silently.
- Adds the `clipboard:read` / `clipboard:write` / `clipboard:data` / `clipboard:write-done` / `clipboard:error` messages. Purely additive — an older agent that does not know them just times out, and the viewer falls back to the previous plain-chord behaviour.
