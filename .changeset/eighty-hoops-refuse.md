---
"@tapflowio/agent-core": minor
"@tapflowio/android-agent": minor
---

Refuse an ambiguous device instead of picking one, and drop the audio capability interface

`AndroidAgent`'s session-less entry points resolved their device with
`deviceStates.values().next().value` — the entry the relay happened to register first. On a Mac
running two emulators that meant answering about a device nobody asked about, and for
`setNetworkOffline` it meant taking a device off the network while somebody else was testing on it.
`IOSAgent` has refused this since the same feature shipped; Android never got the fix.

Eleven entry points now go through one resolver that throws when it cannot choose. `sessionId` keeps
answering, deliberately: a read's worst case is naming the wrong device, and it answers before any
device is chosen.

`AudioStreamCapability` and `hasAudioCapability` are removed. Nothing implemented them, nothing
detected them, and audio has no `AgentCapability` string because it is not gated — the dashboard plays
whatever frames arrive. The audio *data* types move to `agent-core`'s shared types and keep their
names.
