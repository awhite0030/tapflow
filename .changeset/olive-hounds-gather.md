---
"@tapflowio/protocol": minor
"@tapflowio/relay": minor
"@tapflowio/android-agent": minor
---

A viewer that reconnects now learns whether its device is on the network (#614).

`network:state` is produced by the agent, and the relay replays only three things to a re-joining
browser — so the network toggle had no value to render and would have shown a guessed position. The
relay now asks the agent to re-read the device, from the same block that already asks for a
keyframe, and the Android agent answers with an uncorrelated report.

Caching it in the relay would have been cheaper and wrong: the relay caches only what it can
invalidate, and airplane mode changes when someone types `adb` in a terminal.
