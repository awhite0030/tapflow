---
'@tapflowio/protocol': patch
'@tapflowio/relay': patch
---

refactor(protocol): complete the browser-inbound surface by direction, and delete the dashboard's hand-copy of it

A browser receives 28 message types. `@tapflowio/protocol` declared 17 of them — one of which does
not go to a browser at all — and the dashboard declared its own copy of 24 in `lib/types.ts`. The
twelve an agent sends were in neither, because the relay forwards them with `JSON.stringify(msg)` and
so nothing on its typed send path ever mentions them.

The two copies had drifted in four places, and nothing reported any of it: three error types were
`sessionId?` in the dashboard against protocol's required, `session:joined.capabilities` was optional
against required, four members were declared with no `sessionId` the wire always carries, and four
more were missing outright.

- `AgentToBrowser` — the twelve forward-only messages, shapes derived from both agents' send literals.
- `RelayOrAgentToBrowser` — the ten with both producers, declared **once** and referenced by both
  directions rather than written into each. `session:chrome`, `session:deviceInfo` and `device:ready`
  carry `sessionId?` here because the two producers genuinely differ: both agents stamp it, and the
  relay's replay to a re-joining viewer does not.
- `BrowserInbound` — what a consumer should use. The dashboard's `RelayMessage` is gone; view code
  imports this.
- `RelayToStream` — `stream:registered` goes to an agent's stream socket, not a browser.

`scripts/__tests__/browserInboundRouting.test.mjs` now compares the relay's forward case labels
against `AgentToBrowser` in both directions, because no compiler can: a forwarded message is never
constructed by the relay, so `sendTo(socket, msg: RelayOutbound)` does not see it.

Two silent drops surfaced once the dashboard read the real union. The clipboard bridge had declared
its own `{ type: string; payload?: unknown }`, wide enough that a `clipboard:write-done` answering a
read parsed as "no text" and cancelled the claim with nothing said; the same for `clipboard:data`
answering a write. Both now report. Five test fixtures were also sending a `device:booting` with no
`sessionId` — a message the wire does not produce, and one that bypasses the viewer's session
scoping; they compiled because the injection ended in `as never`.
