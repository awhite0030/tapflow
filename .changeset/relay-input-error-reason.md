---
'@tapflowio/relay': patch
---

fix(relay): carry a reason on `input:error`, and stop blaming an agent for a session it never had

The relay answers a terminal input it cannot dispatch — `input:touch:end`, `input:pinch:end`,
`input:key`, `input:button` — so an MCP or browser caller fails immediately instead of waiting out its
own timeout, which its fallback would report as success. That reply carried no `reason`, making the
relay the last producer of `input:error` without one, and the one whose answer was least in doubt: an
agent infers a reason from its own state, while the relay is looking straight at the socket.

It now sends `reason: 'channel-unavailable'`. Consumers that switch on the reason — the dashboard's
per-reason notice, and `mcp-server`, which includes it in the error it raises — no longer have to fall
back to the "unknown reason" rule for a message whose reason was never unclear.

The prose was also wrong for half the cases it covered. Two situations reach that reply: the session
is held with a socket that is no longer open, or there is no such session — evicted after the reconnect
grace expired, or never valid. Only the first is the agent's fault; in the second the agent can be
perfectly healthy, and `agent offline` sent the reader after the wrong problem. It now says
`Session not found` there, the same two strings `device:boot` already used for the same pair.

Both keep `channel-unavailable` rather than splitting into two wire reasons. The set is derived from
what a consumer must do differently, and a reconnect or a re-join answers both — the machine field was
right for both cases while the prose was wrong for one, which is exactly why consumers should branch on
`reason` and display `message`.

No protocol change: `reason` has been optional on this message since it was introduced, so this is
additive. Absence of the field now means an agent older than it, and nothing else.
