---
"@tapflowio/android-agent": patch
---

Fix `ScrcpySession`'s spawned scrcpy server process crashing the whole agent (every device it manages, not just the one session) on an unhandled child-process `error` event — e.g. `kill()` racing an already-exited process. An `EventEmitter` throws an uncaught error when `'error'` fires with no listener attached, and no bootstrap-level `uncaughtException` handler exists to catch it. Adds an `.on('error', ...)` handler that logs instead, matching the pattern already used for every other spawned child process in the codebase (`EmulatorLauncher`, `EmulatorVideo`, ios-agent's `ScreenCaptureStreamer` and `KeyboardHelperDaemon`).
