---
"@tapflowio/flow-runner": patch
"@tapflowio/mcp-server": patch
---

Fix `run_flow` failing the step on the first transient error by wrapping them in `TransientQueryError` and wiring `AbortSignal`.
