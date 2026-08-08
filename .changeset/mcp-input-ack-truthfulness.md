---
'@tapflowio/mcp-server': patch
---

fix(mcp-server): stop reporting an unacknowledged input as success

`awaitInputAck` waited 2s for `input:done` / `input:error` and, on timeout, **returned successfully**.
So `tap`, `swipe` and every other terminal gesture reported success when nothing had acked, and the
model driving the session was told the tap landed and moved on.

The fallback existed for agents predating the input-ack protocol and outlived them: both agents ack
every terminal input unconditionally (#484, #488), and since #495 every producer also sends a
machine-readable reason. When both ends are current, silence means something is actually wrong — which
is exactly the case the fallback converted into a success.

**Silence is now reported as "could not confirm", not as a drop.** That distinction is load-bearing:
`ackInput` awaits a device verify on the first input after a boot or reconnect, on the same Mac the
relay gates at 80% CPU, so an ack past the window can belong to an input that *did* land. Calling that
a drop invites a retry, and a retry of a landed input duplicates it. The error tells the caller the
input may have landed and to check device state rather than repeat it.

**Whether silence is fatal is decided by what the session has already done.** A session that has
answered an input with `input:done` is judged strictly; one that never has keeps the optimistic path,
because an agent that does not ack at all is exactly what the fallback was for. This degrades in the safe
direction and needs nothing on the wire.

`input:done` specifically, not any ack: the relay originates `input:error` to the client for a terminal
input it cannot dispatch, so counting those would let one agent-offline blip mark a session as acking
when its agent may never have answered anything — and then report every later input as unconfirmed on
evidence the agent did not produce. A session that has never had an answer keeps the optimistic path
indefinitely, so #457 is unchanged for an agent whose acks never arrive; what this buys is that once a
session answers, silence after that is reported.

One gap stays open and is documented rather than papered over: an ack carries no correlation id, so an
ack arriving after its own input timed out is consumed by the next input's waiter. That needs a field on
the wire (#499).

**An `input:error` now carries advice, not just prose.** Each reason maps to what the caller should do
— boot the device, reconnect, send the same input again in a moment, or never retry this one. The
`no-gesture` advice warns that part of the input may already have been applied, because that reason
covers both "nothing landed" and "the opening frames landed and only the last was refused".

Nothing is retried automatically. That was the first design and was discarded after review: the wire
cannot distinguish those two `no-gesture` cases, so a client that retried would sometimes apply a drag
twice with nobody able to see it had — and `TapflowClient` also drives `run_flow`, where a retry would
make deterministic replay non-deterministic. Retrying is the caller's decision, which is why the reason
now comes with advice instead of an action.
