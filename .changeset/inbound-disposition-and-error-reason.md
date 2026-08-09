---
'@tapflowio/protocol': patch
'@tapflowio/relay': patch
---

fix(dashboard): tell the second tester the device is in use, and make an unhandled message a compile error

`Session busy` reached the viewer and did nothing. The relay sends it when another browser socket already
holds the session, so **two testers opening the same device** — the likeliest collision in a product whose
premise is that the whole team opens a browser — left the second tab waiting on a `session:joined` that
cannot arrive.

Nothing reported it, because from the outside `error` *was* a handled type. The viewer branched on the
free-prose `message` and covered two of the three wordings the relay sends.

`error` now carries a closed `reason` — the same split #491 gave `input:error`: `message` stays prose the
producer owns, the machine field is closed. **Required here, unlike `InputErrorReason`**, because that
one's producer set is open by design (a third-party platform registers through `AgentRegistry.register()`
and may predate the field) while this one has a single producer: the relay, at three sites. So `sendTo`
enforces it. The viewer switches on `reason` exhaustively, and a fourth reason is a compile error instead
of another silent case.

`busy-elsewhere` and `mac-overloaded` are dashboard-local stop reasons rather than new
`SessionTerminatedReason` values, because in both cases the session is **alive** — widening the protocol
vocabulary would let `session:terminated` carry a reason it can never mean. The copy record is keyed on the
union, so it forced both wordings.

The busy wording deliberately does **not** name another person. The relay answers `session-busy` whenever
the session's browser socket still reads OPEN, and the commonest cause is the tester's *own* previous
socket: a sleeping laptop reconnects in 2s while the relay takes up to a heartbeat (30s) to notice the old
one died. "Someone else is testing this device" would be false in exactly the case the viewer's own comment
calls routine. Relatedly, the relay now checks occupancy *before* the resource gate — with both true, the
tester was told to pick a different Mac while the real reason went unreported — and skips the check for a
socket re-joining the session it already holds, which is what `SessionList` does before a shutdown.

`agent-resources-exhausted` also gained an exit. It only toasted, and the relay `return`s after sending it,
so the tab sat on "Starting device…" indefinitely: making `reason` required stopped a case from being
unhandled without making the handled cases *end*.

**`SessionList` was dropping `error` too**, and the same shape of bug: `handleShutdown` sends
`session:start` on its own socket, a refused join is answered there, and `device:shutdown-done` — the only
message that clears `shutting` — never arrives. The badge read "Shutting down..." permanently and the gate
on it hid both buttons, so the row went inert.

## The layer this belongs to

Browser-inbound is 28 message types; the dashboard handled 22 and dropped 6. The three reasons for
dropping — handled elsewhere, deliberately ignored, nobody wrote it — were **indistinguishable in code**,
since all three look like an absent branch. `lib/inboundDisposition.ts` states one per message under
`satisfies Record<BrowserInbound['type'], Disposition>`, so a message added to the wire breaks the file
until someone picks a category. Measured: adding one produces `TS1360` at the table.

Deriving the *reachable* subset and obliging only that was designed and discarded, and it is the obvious
idea, so both reasons are recorded in the file: `send()` is shared by four sockets that each open their
own WebSocket, and a reply does not go to whoever asked — the relay forwards to whichever socket holds the
session now, so "we never send `input:type`" is true per session, not per socket.

Also corrects a false comment: `DeviceDetails` was documented as "what the viewer shows in its info card".
Nothing reads it — both agents send `session:deviceInfo` and the relay replays it, while the viewer takes
device name and OS from `agents:listed`. It stays on the wire because third-party agents send it.
