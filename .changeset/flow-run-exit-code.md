---
"@tapflowio/flow-runner": patch
"tapflow": patch
"@tapflowio/mcp-server": patch
---

`tapflow flow run` now exits 2 when every failed flow failed for environmental reasons (relay, agent or session level: a refused input with an environmental reason, a session lost to an agent restart, a dropped relay connection). Those used to reach CI as exit 1, reading as product regressions on the dashboards that rely on the 1-vs-2 distinction. Selector, assertion and other product failures still exit 1, successful runs still exit 0, and a run with both kinds keeps exit 1 so a real regression is never masked by a blip. The engine carries the kind on the flow result, so consumers never branch on prose; `run_flow` (MCP) reports results exactly as before.
