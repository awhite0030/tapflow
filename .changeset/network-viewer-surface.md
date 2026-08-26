---
"@tapflowio/relay": patch
"@tapflowio/agent-core": patch
---

Stop the network control describing a device that is rebooting, and settle what the toolbar's groups mean.

A device that restarts keeps its session, and the control only forgot what it knew when the *session* changed — so for the 30–60 seconds an emulator takes to come back, the toolbar showed the position from before it. Worse than merely stale: the agent's boot path turns airplane mode off and reports the device online, so an amber "offline" sat over a device being reset to the opposite, and nothing ever replaced it. The control now forgets the moment the device stops being ready, and starts waiting for the report again.

The toolbar's buttons were grouped by a criterion nobody had written down. They are now grouped by what the tester is doing to the device — **move around the app → leave the device in a condition → take the state out of the session → change what the device is sitting in** — and the rule, with its worked examples, is in `packages/dashboard/AGENTS.md`. A new button has an answer before anyone argues: GPS goes in Environment, Shake in Device.

Where a button sits is now decided in one place. Android's toolbar was ordered by the *agent*, because its buttons arrive as a capability list and the dashboard rendered that array in array order — so reordering that list moved buttons in the browser, and nothing on either side would have said so. The dashboard names its own order now and looks each button up. A button the agent adds and no group claims does not render — deliberately, so that where it belongs is a decision rather than an accident, and a check fails if one is left unclaimed.

Also recorded rather than changed: `NetworkControlCapability` is an in-process API. `mcp-server` and `flow-runner` hold a relay client and address devices by session over the wire, so the network tool they would expose goes through `network:set`, which already names its session and answers with a correlated report. Two issues had been filed asking this interface to take a session id and report on the wire, on the premise that MCP calls it.
