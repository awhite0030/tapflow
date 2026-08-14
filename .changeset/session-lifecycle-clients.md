---
'@tapflowio/flow-runner': minor
'@tapflowio/mcp-server': minor
---

fix: read the relay's session-lifecycle messages instead of dropping them

The last finding in #512. The relay reports a session's fate on three messages — `session:agent-away`,
`session:rebound`, `session:terminated` — and sends them **without closing the socket**. Both clients
were browser-role sockets receiving all three and discarding them, so the `close` handler never ran, no
waiter was ever settled, and a flow learned that its agent had died by burning a 120s install deadline.

## The worse half was not the deadline

`mcp-server` reported an input as **landed** while the relay was saying the agent was gone. Silence from
a session that has never acknowledged an input takes the optimistic path — that exemption is for agents
predating the ack contract — and `agent-away` is exactly when the ack cannot come: the relay only refuses
inputs sent *after* the agent's socket closes, so one already in flight gets nothing at all. The
exemption's usual case is the first input after a boot, which is the same input. So #457's defect was
reachable through a door the client could see through and was not looking at. It now reports "could not
confirm", naming the agent's departure as the cause.

`flow-runner` had the mirror image: `warnInputAckSilence` accused the agent of predating input
correlation or of being slow, both false when the relay has already said the agent left. That
accusation is withheld now, on the same reasoning that already withheld it for a closed socket.

## Only `session:terminated` settles a waiter

The other two are **ambiguous about a request in flight**, and this is the part that looks like an
oversight and is not. Both agents reconnect without restarting the process, so the request is still
executing and its reply closure reads the socket at *completion* time: finish after the reconnect and
the reply lands on the new socket, the relay forwards it to the same session, and the waiter matches it
on `requestId` and resolves. Finish during the backoff and the socket is null and the reply is dropped.
So a rebound is not evidence that no answer can come, and rejecting on it would fail requests that
succeed today — which is what the relay's 15-second grace window exists to protect. Both are held as
state and read at the deadline instead, which is where they turn "timed out" into a cause — three of
each client's waiters are shorter than that 15-second window and three more sit exactly on it, so those
never hear the outcome message at all.

A rebound leaves the session needing `boot_device` again, because the agent's reconnect clears its own
device bindings. It does **not** reset the device: the simulator stays booted and the app stays running,
so the advice says so rather than sending a caller at a reinstall it does not need.

## Also

- Waiters now carry their session, so one session ending settles that session's requests and no others.
  `agents:list` carries no session on the wire and is explicitly unaffected.
- `mcp-server` refuses a `shutdown_device` on a terminated session locally. It is the one command the
  relay drops in silence when it cannot dispatch it — there is no `device:shutdown-error` on the wire to
  answer with — so it was the only waiter whose 30 seconds of nothing had no explanation. The relay half
  is tracked in #542.
- `mcp-server`'s timeout and disconnect branches are distinguished by error class rather than by
  comparing the message string, which stopped being reliable the moment a deadline started carrying why
  it expired.
- `flow-runner` exports `SessionEndedError` from its package entry, so a consumer can branch on the type
  rather than on the message — the thing the point above stopped doing internally.
