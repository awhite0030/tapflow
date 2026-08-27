---
"@tapflowio/relay": patch
---

Make network-state request coalescing deterministic in tests and prevent a delayed trailing timer from sending a duplicate request after a new window begins.

<!-- changelog: internal — relay scheduling and test determinism, nothing a user can observe -->
