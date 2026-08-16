---
'@tapflowio/mcp-server': minor
'@tapflowio/flow-runner': minor
---

Stop waiting when the answer is never coming: leaving a session fails what it was waiting on, and a dead session fails a flow step now instead of at its timeout

Both clients waited out their full deadline for replies that could not arrive. Three cases, one shape.

What a user can observe:

- **Disconnecting from a session no longer leaves a request hanging for thirty seconds.** An AI agent that
  calls `disconnect_device` while a `boot_device` is still in flight — ordinary, because tool calls run in
  parallel — used to get a bare timeout half a minute later. It now fails immediately and says the
  disconnect is what ended it. The message still warns that the request may have reached the device
  anyway, because leaving does not undo what was already sent.
- **A worse version of that could report a boot that never happened as success.** Re-joining a session
  reuses its id, so a reply meant for the new join could satisfy a request from before the disconnect.
  Nothing shipped could reach it — a missing field on one message happened to be in the way — but it was
  one field away, and it is now closed at the cause.
- **A flow run whose device dies stops blaming the wrong thing.** When the agent restarts mid-run the
  device binding is gone, and nothing in a flow can restore it — flows boot once, before the first step.
  Every remaining step used to poll for its full timeout and then fail with "no element matched",
  pointing at the selector — a restart three steps into a ten-step flow spent eighty seconds saying the
  wrong thing. Those steps now fail as soon as the query does, and say the session needs booting again.
- **The relay's fifteen-second grace is untouched.** While it holds a session open for an agent that may
  come back, queries keep retrying exactly as before. That window is what the retry is for, and cutting
  it short would kill runs that recover.

`@tapflowio/flow-runner` exports one new error, `SessionLeftError`, alongside `SessionEndedError`. They are
deliberately separate: one means the relay ended the session, the other means the caller walked away from
one that is still there, and they call for different next steps.
