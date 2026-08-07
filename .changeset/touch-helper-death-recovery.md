---
'@tapflowio/ios-agent': patch
---

fix(ios-agent): recover from a dead touch-helper instead of dropping every input silently

When the `touch-helper` process died on its own, `TouchHelper` kept pointing at the corpse and
every write returned early at a `stdin.writable` guard. The session accepted no further input for
the rest of its life while the stream kept running, so the viewer tapped a screen that updated
normally and nothing happened — and nothing was reported to the browser or to an MCP caller.

- The helper is now replaced when it dies rather than on the next input — as soon as the spawn
  budget below allows it — so the first tap after a death does not wait for the replacement to
  start up.
- Replacing is bounded to 3 spawns in any 30-second window, which self-clears, so a helper that
  cannot run does not churn processes and a transient failure is not permanent.
- A helper that never announces readiness at all is replaced after a deadline. Otherwise
  running-but-never-ready has no exit: nothing asks for a replacement because it is running, and
  every input is refused because it is not ready.
- A gesture is only ever continued by the process that *received its opening frame*. A touch end or pinch end injects
  coordinates the *previous* process had latched, so delivering one to a replacement would release
  the touch at (0,0) and report success; a move with no preceding down is not the gesture the
  tester made either. Both are refused, even when a healthy replacement is available.
- A freshly spawned helper is not usable for its first ~200ms, and a frame written before it starts
  reading stdin lands nothing at all — the frames buffer and then drain in one go, which collapses a
  swipe into microseconds. The helper already announced when it was ready; that announcement is now
  what gates a write, so those frames report failure instead of reporting success and vanishing.
  This was reachable without any helper death: an MCP caller tapping as soon as `boot_device`
  returns is inside that window.
- Terminal inputs now ack on whether the write reached a helper that is ready to inject rather than
  on whether the helper object exists. `input:touch:end`, `input:pinch:end`, `input:key`, `input:button`,
  `input:type` and `clipboard:write` with `pasteAfter` answer an error instead of success when the
  input was dropped. Two `input:button` branches deliberately write nothing — a home press-down and
  a button with no HID mapping on this device's chrome — and those answer from the channel's health
  instead, so a healthy channel is not reported as a failure and a dead one is not reported as a
  success.
