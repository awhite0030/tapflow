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

- **A malformed command is refused before it reaches a device, and the caller is told which field was
  wrong.** A `device:boot` with no payload, an `open-url` with no URL, an `app:install` whose `buildId`
  is an object — these were forwarded to an agent before, and the agent's own guard answered if it had
  one. The relay answers now, in the shape that request's waiter reads, so the diagnosis arrives sooner
  and does not depend on which agent is on the other end. A request that has no reply at all is dropped
  and logged with the field that failed. No client shipped here can produce any of these; a third-party
  one can.
- **A command with no usable session id or request id is refused outright**, including the empty
  string, which type-checks and which an LLM driving the MCP tools could produce. Answering one is not
  possible — the reply's own required fields would be missing, and every client discards such a frame —
  so it is dropped with a log rather than turned into a caller waiting out its deadline.
- **A key appended to a browser message no longer reaches a device.** Browser-origin frames are
  forwarded as the parse product, so anything the contract does not declare is gone before an agent
  sees it. Agent-origin frames are forwarded unchanged, so a field a newer agent adds still survives a
  relay that does not know it.
- **Nothing else changes.** Every well-formed frame routes exactly as before.

`@tapflowio/protocol` gains a `./validate` subpath and, with it, a runtime dependency on `zod` — its
first dependency of any kind. The main entry is unchanged: still types only, still fully erased by
`import type`, and it does not reach `zod`. A consumer that imports only `@tapflowio/protocol` gains
nothing in its bundle and one package in its install.

Agent payloads are deliberately not validated, and that is a decision with a reason rather than a gap:
`AgentRegister.platform` is `string` — open, so a third-party platform can register through
`AgentRegistry.register()` — while `ChromePayload` is a closed two-member union. A platform this
project promises to support has no valid `session:chrome` variant to send, and refusing one would cost
it bezel and buttons for the life of the session. The six messages the relay consumes are validated,
each with a default for every field the relay previously read through a `??`, so an agent older than a
field keeps working exactly as it did.
