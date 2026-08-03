import { defineConfig } from 'vitest/config'

/**
 * Shared by every package whose tests import a sibling workspace package.
 *
 * Without it those imports resolve through `exports` to `dist/`, so a test in one package
 * exercises whatever was last *built* of another. #459 shipped a regression behind a green
 * 1889-test run for exactly that reason: `ios-agent` stands up a real `RelayServer`, and the relay
 * it stood up was the previous one. It surfaced only when the pre-commit `tsc -b` refreshed `dist`.
 *
 * `ssr.resolve`, not `resolve`: vitest runs in node, so it takes the SSR resolution path. Measured
 * — `resolve.conditions`, `NODE_OPTIONS=--conditions=source` and `server.deps.inline` all still
 * loaded `dist`; only this one switched.
 *
 * Why not point the manifests at source instead, which would need no config at all: `pnpm deploy`
 * does not apply `publishConfig`, so the Docker image would ship `node_modules` full of `.ts` and
 * die on boot with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING — and `packages/cli/bin/tapflow.js`
 * is plain node too. Covering every consumer uniformly means covering the ones that cannot read
 * TypeScript. Opting in per tool is the point, not the cost.
 */
export const sourceFirst = defineConfig({
  // `source` PREPENDED to vite's own defaults, never replacing them. Replacing looks equivalent and
  // is not: the list applies to every dependency, not just workspace ones, and dropping `node` sent
  // jsdom to the wrong entry of `decimal.js` — ten dashboard tests died on
  // `TypeError: Decimal is not a constructor`, nowhere near anything this change is about.
  //
  // The defaults are copied rather than imported because `vite` is not a dependency of most of the
  // packages that load this file. `scripts/__tests__/testsReadSource.test.mjs` compares this list
  // against vite's real `defaultServerConditions`, so a version that changes them fails by name
  // instead of by whatever breaks next.
  ssr: { resolve: { conditions: ['source', 'module', 'node', 'development|production'] } },
})

export default sourceFirst
