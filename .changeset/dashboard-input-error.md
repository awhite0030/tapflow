---
'@tapflowio/relay': patch
---

fix(dashboard): tell the tester when an input never reached the device

The relay forwarded `input:done` / `input:error` to the browser and the dashboard dropped both. They
were declared in `lib/types.ts` and had no handler anywhere, so the only consumer of a failed input
was `mcp-server` — the experimental path. Manual testing, which is tapflow's primary use, heard
nothing.

That mattered more after #484/#488/#490. Before those, an agent reported a dropped input as success;
now it reports the truth with a machine-readable `reason`, and the truth was being discarded before it
reached a human. Concretely, a session whose input channel has permanently failed (a helper binary
that is missing or built for the wrong architecture) showed a stream that kept updating, taps that did
nothing, and no indication anywhere.

A failed input now raises a toast whose copy is chosen by `reason`, so the tester is told what to do
rather than just that something failed — reconnect, start the device, report a bug, or that the input
has no equivalent on this device. `not-booted` gets its own wording because the protocol prescribes a
different action for it than for `channel-unavailable`. The wire `message` rides along as the
description, which is where its detail (`unknown key code: KeyFoo`) is useful; it is not used as the
headline, because it is free prose each agent owns and cannot be localised.

Two reasons are deliberately shown nowhere: `channel-starting` (the input channel is up ~200ms later)
and `no-gesture` (the gesture is gone; a fresh one works). Reporting an error for something already
fixed by the time it is read is noise.

There is **no session-level "input unavailable" state**, which was the first design and was discarded
after review. Per-input acks cannot support one: no message carries evidence that input is working
again — a replaced helper announces nothing, and an agent restart is not the same as a healthy channel —
the acks are not ordered (a dispatch is awaited before its ack while a refusal is not), and an ack does
not say which channel answered, so on Android, where buttons always take the adb path, a working Home
button would have erased a warning about a dead touch channel. The toast's own lifetime carries it instead:
repeats reuse one id, so it stays up while inputs keep failing and fades when they stop.

Nothing is shown while the agent is away, either: the relay answers every terminal input itself in that
state, and the viewer already says the session is being held open and waiting.

Dashboard-only change, released as part of `@tapflowio/relay` because that is the package the built
dashboard ships inside.
