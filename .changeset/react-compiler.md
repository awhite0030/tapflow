---
'@tapflowio/relay': patch
---

The dashboard is built with the React Compiler. It memoises the work React would otherwise repeat on every render, without the hand-written `useCallback` and `useMemo` that were doing part of that job.

The bundle grows: the first load is 3,810 B larger compressed (170,543 → 174,353), because the memoisation the compiler adds is code. Nothing about how the dashboard behaves changes.
