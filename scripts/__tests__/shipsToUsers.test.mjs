// Decides whether a changed file needs a changeset. A previous review found six separate things
// this predicate missed while it was an allowlist over `src/**.ts`, and it then went a round with
// no tests at all — the twenty-line rule that had been wrong six ways was the one thing unchecked.
import { describe, it, expect } from 'vitest'
import { shipsToUsers } from '../check-changeset.mjs'

describe('shipsToUsers — files a released tapflow puts in front of users', () => {
  const SHIPS = [
    // The obvious case.
    'packages/ios-agent/src/IOSAgent.ts',
    'packages/relay/src/RelayServer.ts',
    // Not TypeScript, and not under a name the old extension filter knew about.
    'packages/relay/src/migrations/014_add_index.sql',
    'packages/android-agent/proto/emulator_controller.proto',
    'packages/flow-runner/schema/flow.schema.json',
    'packages/ios-agent/xctest-runner/TreeRunner/TreeServer.swift',
    // Committed binaries and entry points, shipped via `files[]`, never under `src/`.
    'packages/cli/bin/tapflow.js',
    'packages/ios-agent/bin/touch-helper',
    // The dashboard is `private`, but it is built into the relay's `public/` and shipped there.
    'packages/dashboard/src/main.tsx',
    'packages/dashboard/hooks/useClipboardBridge.ts',
    // A manifest carries `bin`, `files`, `postinstall` and dependencies — all user-visible.
    'packages/android-agent/package.json',
    // A brand-new published package. An allowlist of package names could not see this at all,
    // which is backwards: a new package is the change most in need of a release note.
    'packages/flow-capture/src/index.ts',
  ]

  for (const f of SHIPS) {
    it(`requires a changeset for ${f}`, () => expect(shipsToUsers(f)).toBe(true))
  }
})

describe('shipsToUsers — files that change nothing a user can observe', () => {
  const DOES_NOT_SHIP = [
    // Tests and their fixtures.
    'packages/ios-agent/src/__tests__/IOSAgent.test.ts',
    'packages/ios-agent/src/__fixtures__/the-app-tree.txt',
    'packages/relay/src/session.test.ts',
    'packages/dashboard/src/foo.spec.tsx',
    // The XCUITest runner's own test target — it drives the tree server, it is not shipped.
    'packages/ios-agent/xctest-runner/TreeRunner/TreeServerTest.swift',
    // Build output and local config.
    'packages/relay/dist/index.js',
    'packages/relay/tsconfig.json',
    'packages/dashboard/vitest.config.ts',
    'packages/ios-agent/.gitignore',
    'packages/dashboard/.env.development',
    // Prose.
    'packages/relay/README.md',
    'packages/dashboard/DESIGN.md',
    'packages/ios-agent/AGENTS.md',
    'packages/agent-core/CHANGELOG.md',
    // Packages that are never published.
    'packages/docs/guide/requirements.md',
    // Outside packages/ entirely.
    'playground/relay.ts',
    'scripts/dev-down.mjs',
    '.github/workflows/ci.yml',
    'AGENTS.md',
  ]

  for (const f of DOES_NOT_SHIP) {
    it(`does not require a changeset for ${f}`, () => expect(shipsToUsers(f)).toBe(false))
  }
})
