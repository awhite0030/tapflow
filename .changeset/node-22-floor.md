---
"tapflow": minor
"@tapflowio/protocol": minor
"@tapflowio/agent-core": minor
"@tapflowio/ios-agent": minor
"@tapflowio/android-agent": minor
"@tapflowio/relay": minor
"@tapflowio/flow-runner": minor
"@tapflowio/mcp-server": minor
"@tapflowio/audiotap-helper": minor
---

**Requires Node.js ≥ 22.** Node 20 reached end of life on 2026-04-30 and no longer receives security patches.

Three declarations disagreed about what was supported, and none of them matched what was actually run. The manifests said `>=20.12.0`, the documentation said "≥ 20" — meaning 20.0.0 — and CI ran 20 while Docker ran 22 and the release job ran 24. There was also a band that was declared but unusable: every `undici` 7.x requires Node `>=20.18.1`, so 20.12 through 20.17 could not complete a development install regardless of what the manifests promised.

The floor is now 22 everywhere, and 22 is a version that will be tested rather than merely claimed — CI runs the suite on both 22 and 24. That is the part that had been missing: `>=20.12.0` was declared for a year and never once exercised on 20.12, which is how it drifted below what the dependency tree already required.

`tapflow`, `@tapflowio/flow-runner` and `@tapflowio/mcp-server` declared no `engines` at all and now do. `tapflow` is the package installed with `npm i -g`, so until now the CLI announced no Node requirement to the people most likely to need it.

`tapflow doctor` moves with it and reports `Node ≥ 22 required` below the floor. Without that change it would have printed a green check on Node 20 while the package manifest called the same version unsupported.

Node 22 is supported until 2027-04-30; Node 24 is the active LTS. Containers and the published image now run 24.
