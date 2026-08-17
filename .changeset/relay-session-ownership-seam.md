---
'@tapflowio/protocol': minor
'@tapflowio/relay': minor
'@tapflowio/mcp-server': minor
---

Answer a shutdown the relay cannot deliver, release every session a closing socket held, and let a viewer re-join a session it already holds

Three defects that share a subject — who holds a session — and none of which needed the question that
sounds like their root. That one is *who should be allowed to*, and it is answered in this same release — see the note titled "A
session belongs to whoever opened it". It could not be answered in this slice because the dashboard's four
senders per tab are four connections, and a socket-shaped owner refuses the tab's own teardown.

What a user can observe:

- **A device shut down from an MCP client fails in a second instead of half a minute.** `device:shutdown`
  was the one browser command the relay never answered when it could not deliver it — a stale session id
  or an agent that went away produced no reply at all, and `shutdown_device` reported `Request timed out`
  with no cause after 30 seconds. It now says which of the two happened.
- **A device list stops getting stuck on "Shutting down…".** The same silence left that row inert with
  both its buttons hidden for the life of the page.
- **A tester whose browser reconnects lands back in their session instead of being thrown out of it.**
  Re-sending `session:start` for a session the socket already held was answered `session-not-found` — for
  a live session, held by the caller, that the device list reported as theirs two lines later. The viewer
  reads that reason as the agent having disconnected and takes the tester off a session that is fine.
  A re-join is idempotent now: same reply as a fresh join, and the session's cached state is replayed.
- **Devices no longer stay booted with nobody watching them.** The relay tracked one session per browser
  socket while the relation is one-to-many — `mcp-server` runs a single socket for the whole process and
  joins a session per device. Closing it released only the last one joined; the rest stayed marked in-use
  for the life of the relay, with no idle timer, so their simulators kept running. All of them are
  released now, each with its own idle timeout.

`@tapflowio/protocol` gains `device:shutdown-error` on the browser-inbound surface. It is relay-produced
only: neither agent has a failure path that emits a message, so a shutdown that reaches a device either
completes or times out. Its `requestId` is optional because the request's is — the relay originates
`device:shutdown` from its own idle timer, and a reply cannot demand a field the request need not carry.

`SessionManager.join()` returns its two expected failures instead of throwing them. It used to throw both
as `ValidationError`, which left the caller's `catch` unable to tell an expected refusal from a bug — so
it guessed a reason, and guessed wrong for the most common one. Nothing in tapflow depended on the throw;
this affects code outside it that called `SessionManager` directly. `getByBrowserSocket` returns an array
for the same reason the index changed.
