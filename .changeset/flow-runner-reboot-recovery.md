---
"@tapflowio/flow-runner": patch
"@tapflowio/cli": patch
---

Let the runner recover from mid-flow agent reconnects by re-booting the session, rather than failing the remaining steps with a selector error.
