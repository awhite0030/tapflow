---
"@tapflowio/protocol": patch
"@tapflowio/relay": patch
"@tapflowio/dashboard": patch
---

Make app install/launch failures reach the caller that asked.

Three paths through `handleBrowserAppInstall` / `handleBrowserAppLaunch` ended without a usable answer: an unknown session got a generic `error` with no `sessionId`, a missing build or bundle id got an app-specific error also without one, and an agent whose socket was not open got nothing at all — the `if` had no `else`. A dashboard viewer holds one session per socket, so an unattributed error still lands somewhere sensible and a human sees it. An MCP caller waits for the reply carrying its own `sessionId`, so all three looked the same from there: silence until the deadline. The caller was told "timed out" when the truth was "that build has no bundle ID".

- **relay**: every exit from both handlers carries the request's `sessionId`, including `Session not found` — a generic `error` cannot be correlated by construction. An unreachable agent is answered immediately instead of being left to time out, matching what `open-url` and `clipboard:read` already do.
- **relay**: `device:boot` gets the same treatment. A boot the agent never receives used to leave the viewer on "Waiting for first frame…" with nothing said. `device:shutdown` stays fire-and-forget — nothing waits on it, and inventing a reply type for it would grow the contract for a message no one reads.
- **protocol**: `app:install-error` and `app:launch-error` now declare `sessionId` as required, and `device:boot-error` joins `RelayToBrowser`. Because `sendTo` is typed against that union, an omission at those call sites is a compile error rather than a silent gap. Messages the relay merely forwards, and the agents' own raw literals, stay outside that check — and nothing yet validates an inbound `sessionId` (#444), so this is a much tighter contract than before rather than an airtight one.
- **relay**: `buildId` is checked before it reaches the query. `JSON.parse` does not honour `RelayMessage`, and an object or array there makes the driver throw — an exception the message loop used to swallow alongside genuine parse failures, leaving the caller with nothing. That loop no longer catches a parse failure and a routing failure in the same block, and it rejects payloads that are valid JSON but not messages (`null`, numbers, strings) before routing reads a field off them.
- **dashboard**: the viewer ignores messages addressed to another session, and its local union carries the new field. Adding `sessionId` without a consumer that reads it would not have fixed a correlation bug.
