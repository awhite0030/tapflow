---
'@tapflowio/android-agent': patch
---

fix(android-agent): answer input acks from the dispatch, not from a proxy for it

Every terminal input reported success for input that never reached the device, so `input:error` was
unreachable. The acks were computed from proxies: a channel reference, a serial that resolved, or
`state.touchHelper !== null` — which is effectively a constant, because that helper has no process to
lose. Meanwhile the dispatch itself was fire-and-forget on all three paths, its promise discarded.

This is the Android half of what #484 fixed on iOS, though not the same defect: iOS computed
`dispatched` wrongly, Android threw the value away.

- Acks now carry a reason. `input:done` means the input reached a live channel on a booted device;
  otherwise `input:error` says which of `channel-down`, `failed`, `unsupported`, `not-booted`,
  `no-session`, `malformed` or `no-gesture` it was. A single boolean could not express the new answers, and collapsing them would
  have reported `input channel not ready` for a perfectly healthy channel. `not-booted` and
  `channel-down` keep their previous wording, so the part that overlaps iOS stays symmetric.
- `PointerControl` gains `isReady()`, because the two backends have nothing in common:
  `ScrcpyControl` writes to a socket and `write()` never throws for a dead peer, so local writability
  is the only signal it has; `EmulatorGrpcClient` rejects, and now also carries a deadline on input
  RPCs. Measured, an unreachable emulator rejects in 4ms on its own, so the deadline is there for a
  client that is connected but unresponsive — where it bounds our wait rather than undoing anything
  the emulator may already have applied.
- The adb fallback stops swallowing its own failures, and says `unsupported` where it does nothing at
  all — pinch, which had three empty methods and answered success, and a button name it has no
  mapping for. It also answers `no-gesture` rather than a channel error for a terminal frame with no
  gesture behind it, which the viewer sends on any pointerup that did not start on the video. Buttons take this path on every backend, so it is the one that runs in production.
- `input:key` reports whether it dispatched rather than whether it threw. Two branches deliberately
  send nothing — a Ctrl/Cmd chord outside copy/cut/paste, and any code with no character mapping —
  and both used to answer success.
- A terminal input for a session this agent holds no state for now answers instead of returning
  silently. The relay only replies on an agent's behalf when the agent is *offline*, so nothing
  answered at all and the caller waited out its own timeout.
- A key code or button name is looked up with `Object.hasOwn`, so a name arriving off the wire that
  happens to be a prototype member (`constructor`) answers `unsupported` instead of being dispatched
  as a keycode and answering `failed`.

Callers that treat an `input:error` as fatal will see failures they did not see before, because those
failures were previously reported as success: a `press_key` for a modifier chord, or for a key with no
character mapping, now answers an error rather than silently doing nothing. Empty `type_text` is
unchanged — it stays a successful no-op, matching iOS.
