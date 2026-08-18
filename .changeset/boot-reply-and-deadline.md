---
'@tapflowio/ios-agent': patch
'@tapflowio/android-agent': patch
'@tapflowio/agent-core': patch
'@tapflowio/mcp-server': patch
'@tapflowio/flow-runner': patch
'@tapflowio/relay': patch
---

A boot that will not finish says so, instead of letting you wait

Two halves of one question — what ends the wait for a device to come up — and both used to be answered by
a timeout somewhere else.

What you can observe:

- **A boot that gets overtaken fails immediately, with the reason.** Re-pick a device while the first one
  is still starting, or shut it down mid-boot, and the agent used to abandon the earlier boot silently.
  Nothing was sent in either direction, so whoever asked found out by waiting: 30 seconds for an MCP
  caller, two minutes for a flow run, forever for a spinner. Each abandoned boot now gets an answer
  addressed to its own request, saying which of the three things happened to it.
- **A slow cold boot is no longer reported as a failure that never happened.** The agents poll a booting
  device for up to 90 seconds (iOS) or 120 (Android) and then explain what went wrong. `mcp-server` gave
  up at 30 — inside both — so a device that was simply slow came back to the model as a bare timeout
  while the explanation was still on its way. `flow-runner` sat at exactly Android's 120, which left no
  room at all. Both now wait past the agent, and a check across the packages keeps them there: the
  numbers may change, the relationship may not.
- **A tester is no longer told a boot failed when the failure belongs to a boot they replaced.** The
  viewer reports the failure of the boot it is waiting on, and an uncorrelated one — which is how a dead
  video stream is reported, and has no request behind it — exactly as before.
- **Losing the relay mid-boot no longer leaves Android finishing a boot nobody owns.** Both agents drop
  their device state when the connection goes, but a boot already running holds its own reference to
  one; on Android it ran to completion against that, standing up a video stream and announcing the
  device ready for a session that no longer existed. iOS has invalidated in-flight boots there since its
  helper-leak fix. The two now agree.

One thing deliberately stays silent: a boot abandoned when the agent has no open connection to the relay.
The reply's own channel is what is missing. That case is covered by the relay, which declares the agent
away and ends the session's waits inside its grace window — and `sendMsg` now checks that the socket is
open rather than merely present, because sending to a closing one buffers the message and reports nothing,
which is how an answer becomes a silence.
