---
"@tapflowio/protocol": minor
"@tapflowio/agent-core": minor
"@tapflowio/relay": minor
---

Add the wire contract for taking a device under test off the network (#607): `network:set` from the
viewer, `network:state` and `network:error` back, and a `NetworkControlCapability` beside
`DeviceAgent` for the agents that implement it.

No agent implements it yet and no control renders it — this is the contract, landing before the
platforms so each one has something to build against.

**`network-control` in `capabilities` claims less than the other two entries do.** `clipboard` and
`full-reset` are settled facts about an agent's own code, but that string is sent once at
`agent:register`, before any device is booted or app launched — so it can only mean "this agent has
the code". Whether the mechanism actually takes is per device and per app, and `network:state`
carries that as `available` plus a closed `reason`. A single boolean was tried and rejected: with the
capability gating the control, `available: false` would have been unreachable, and the state it
describes — conditioned but no longer steerable — would have hidden the only control that could undo
it.
