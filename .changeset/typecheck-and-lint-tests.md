---
'@tapflowio/test-utils': patch
---

test: type-check and lint the test trees, which nothing did

Two exclusions overlapped — `packages/*/tsconfig.json` excluded `src/__tests__`, and
`eslint.config.mjs` ignored `**/__tests__/**` — so a test could reference a field that does not
exist, shadow an object key, or drift from the interface it exercises with both gates green (#422).

Test doubles are exactly where that matters, and turning the checker on named the drift:

- `AgentRegistry.test.ts` declared `implements DeviceAgent` while missing `openUrl` and
  `queryUITree`. The clause had been there all along, proving nothing.
- `EmulatorVideo.test.ts` was three members short of `RawEmulatorController` — the same shape #418
  shipped behind a cast, and a comment in a sibling test even said the annotation "only helps in an
  editor".
- Five duplicate object keys in `SimctlWrapper.test.ts` (`execBinary` declared twice), which is the
  defect #422 was filed from. Harmless as written because the later, complete one wins; the reverse
  order would have handed back `undefined`.
- A `clearAppData('com.unknown')` call against a two-argument method, so the bundle id silently
  became the udid and the assertion held anyway.
- `test-utils`' `waitForType<T extends SocketMessage>` had a constraint no named message can satisfy
  (`Record<string, unknown>` needs an index signature; interfaces have none), so **all 25 call sites
  violated it invisibly** — the looseness had stopped accommodating the richer views it was for and
  started blocking them. `SocketMessage` stays the default; the constraint is now `{ type: string }`.
  That one change resolved 47 errors, and narrowing the relay's own suites to `RelayMessage` — the
  usage the type parameter exists for — resolved another 45.

## Shape

Each package with tests gets `src/__tests__/tsconfig.json`, wired into its `typecheck` script after
`tsc -b`. Tests still must not reach `dist`, so they do not join the build's `include` — the same
shape as `protocol/tsconfig.assertions.json`.

**The name and location are load-bearing.** typescript-eslint's `projectService` resolves a file's
project the way tsserver does, by walking up for a `tsconfig.json`, so a `tsconfig.test.json` at the
package root is invisible to it and every rule fails as `was not found by the project service`
instead of reporting. One file serves both gates only in this position.

`moduleResolution: bundler` rather than the build's Node16: vitest resolves through vite and does not
require the `.js` suffix. **166 of the 400 errors this first surfaced were nothing but that suffix
missing** — checking tests under a resolution they never run with would have meant rewriting every
import to satisfy a compiler no test obeys.

The root `typecheck` script also stops naming four packages by filter and runs `-r`, without which
the new check would not have run for the six it omitted — including relay and cli, which held 130 of
the errors between them.

Only `@tapflowio/test-utils` changes published source (the constraint above). Everything else is test
files, tsconfigs and scripts.
