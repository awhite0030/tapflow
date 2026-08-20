---
"@tapflowio/protocol": minor
"@tapflowio/agent-core": minor
"@tapflowio/relay": minor
"@tapflowio/ios-agent": minor
---

Gate the dashboard's Full reset toggle on an agent capability instead of the platform string.

`AgentCapability` gains `full-reset`, `IOSAgent` advertises it, and `SessionInfo` now carries the
agent's capabilities so the viewer can gate while picking a device — before any session exists to
join. The old `os !== 'android'` check said "Android cannot" when it meant "this agent did not say
it can", and got both directions wrong: an iOS agent too old to implement Full reset was still
offered the toggle, and an Android agent that implements it later would still have it hidden.
