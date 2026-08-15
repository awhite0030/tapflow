---
'@tapflowio/protocol': minor
'@tapflowio/relay': minor
---

Validate every message the relay receives, and make the inbound frame a discriminated union

The outbound direction has been compile-checked since #419 — `sendTo` refuses a message outside its
union. Nothing checked the inbound direction: the relay's `RelayMessage` was a flat interface where
`type` was the only required member, so every field it read was optional by construction and every
field it needed came with a `!`. That is how the two type systems could disagree about the same wire
field — `format?` in the relay against a required `format` in the protocol — with nothing to report it.

`@tapflowio/protocol/validate` is a second entry point, imported only by the relay, that parses an
inbound frame into a discriminated union at the door. It is a parse rather than a cast on purpose:
narrowing the union with `as` would have turned the relay's one visible `msg.payload as ChromePayload`
into an invisible `msg.payload`, with the compiler vouching for JSON that arrived over a socket.

What a user can observe:

- **A malformed command is refused where it used to be forwarded.** A `device:boot` with no payload, a
  `session:start` whose `sessionId` is the empty string, an `app:install` whose `buildId` is an object
  — these reached an agent before, or produced a reply whose own required field was missing. Where the
  request has an error reply the caller still gets one; where it has none it is dropped and logged with
  the field that failed, instead of silently doing nothing.
- **A key appended to a browser message no longer reaches a device.** Browser-origin frames are
  forwarded as the parse product, so anything the contract does not declare is gone before an agent
  sees it. Agent-origin frames are forwarded unchanged, so a field a newer agent adds still survives a
  relay that does not know it.
- **Nothing else changes.** Every well-formed frame routes exactly as before.

Agent payloads are deliberately not validated, and that is a decision with a reason rather than a gap:
`AgentRegister.platform` is `string` — open, so a third-party platform can register through
`AgentRegistry.register()` — while `ChromePayload` is a closed two-member union. A platform this
project promises to support has no valid `session:chrome` variant to send, and refusing one would cost
it bezel and buttons for the life of the session. The six messages the relay consumes are validated,
each with a default for every field the relay previously read through a `??`, so an agent older than a
field keeps working exactly as it did.
