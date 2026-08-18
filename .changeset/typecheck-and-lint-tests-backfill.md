---
'@tapflowio/agent-core': patch
'@tapflowio/android-agent': patch
'@tapflowio/audiotap-helper': patch
'@tapflowio/cli': patch
'@tapflowio/flow-runner': patch
'@tapflowio/ios-agent': patch
'@tapflowio/mcp-server': patch
'@tapflowio/relay': patch
---

Type-check and lint the test trees

Backfills: #537

<!-- changelog: internal — a `typecheck` script and a test-tree tsconfig per package; no runtime or
     interface change a self-hoster can observe. What it found was inside the tests themselves: a double
     declaring `implements DeviceAgent` while missing two members, five duplicate object keys, a call
     passing one argument to a two-argument method, and a `test-utils` constraint no named message could
     satisfy. -->

Every package's build tsconfig excluded `src/__tests__` and eslint ignored it, so a test double could
drift from the interface it doubled with both gates green. The manifests gained a `typecheck` script and
the test trees a tsconfig of their own, which is the only reason this touches published files at all.
