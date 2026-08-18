---
'@tapflowio/agent-core': patch
'@tapflowio/android-agent': patch
'@tapflowio/audiotap-helper': patch
'tapflow': patch
'@tapflowio/flow-runner': patch
'@tapflowio/ios-agent': patch
'@tapflowio/mcp-server': patch
'@tapflowio/relay': patch
---

Type-check and lint the test trees

Backfills: #537

<!-- changelog: internal — a per-package `typecheck` script and a test-tree tsconfig; no runtime or interface change a self-hoster can observe -->

Every package's build tsconfig excluded `src/__tests__` and eslint ignored it, so a test double could
drift from the interface it doubled with both gates green. The manifests gained a `typecheck` script and
the test trees a tsconfig of their own, which is the only reason this touches published files at all.
What the gates then found was inside the tests: a double declaring `implements DeviceAgent` while missing
two members, five duplicate object keys, a call passing one argument to a two-argument method, and a
`test-utils` constraint no named message could satisfy.

The CLI is `tapflow`, not `@tapflowio/cli` — the manifest name, which is what `changeset version` resolves.
