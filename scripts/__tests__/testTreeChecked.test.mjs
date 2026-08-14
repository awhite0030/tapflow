import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// #422 brought the test trees under `tsc` and eslint. The arrangement it landed is easy to half-copy:
// a new package clones a build tsconfig that excludes `src/__tests__` and does not add the second
// tsconfig, and its whole test tree is then outside every project with `pnpm typecheck` still green —
// which is the state #422 existed to end.
//
// Found by inspection rather than by a list, for the same reason `testsReadSource.test.mjs` is:
// a hardcoded list is satisfied by not being edited.
const REPO = path.resolve(import.meta.dirname, '../..')
const PACKAGES_DIR = path.join(REPO, 'packages')
const TSC = path.join(REPO, 'node_modules/.bin/tsc')

// Recursive, and both suffixes. A flat `readdirSync` misses `__tests__/commands/foo.test.ts` — which
// `cli` already has — and matching only `.test.` misses the `.spec.` half of the vitest pattern. A
// guard that cannot see a test tree reports nothing about it, which is indistinguishable from a pass.
function packagesWithTests() {
  return fs.readdirSync(PACKAGES_DIR)
    .filter((d) => fs.existsSync(path.join(PACKAGES_DIR, d, 'src/__tests__')))
    .filter((d) => fs.readdirSync(path.join(PACKAGES_DIR, d, 'src/__tests__'), { recursive: true, withFileTypes: true })
      .some((e) => e.isFile() && /\.(test|spec)\.tsx?$/.test(e.name)))
}

/**
 * Whether a tsconfig's file set actually contains this package's tests.
 *
 * **Asks `tsc`, rather than parsing `exclude`.** Two drafts matched the pattern as a string and both
 * were bypassed in review: first by `src/__tests__/**`, then by `**\/__tests__/**` — and `exclude`
 * takes arbitrary globs, so a third spelling was always available. Reimplementing tsc's matcher to
 * guard tsc's behaviour is the shape `contributing/test-and-guard-coverage.md` §3 calls a floor
 * rather than a fence. `--listFilesOnly` resolves the config the way the compiler will and prints the
 * answer; it type-checks nothing, so it costs well under a second per package.
 */
function fileSetIncludesTests(tsconfigPath, pkgDir) {
  const out = execFileSync(TSC, ['-p', tsconfigPath, '--listFilesOnly'], { encoding: 'utf8', cwd: REPO })
  const testDir = path.join(pkgDir, 'src', '__tests__') + path.sep
  return out.split('\n').some((line) => line.trim().startsWith(testDir))
}

describe('every test tree is inside a tsconfig', () => {
  const pkgs = packagesWithTests()

  // Anti-vacuity floor from the measured count at the time of writing, not a round number: a scan
  // that silently stopped finding packages would otherwise pass by covering nothing.
  it('finds the packages that have tests', () => {
    expect(pkgs.length).toBeGreaterThanOrEqual(9)
  })

  it.each(pkgs)('%s: its tests are in a project', (pkg) => {
    const dir = path.join(PACKAGES_DIR, pkg)

    // Two shapes are valid. Either the build config already covers the tests (dashboard), or the
    // tests have their own — which must be named `tsconfig.json` and sit in `src/__tests__`, because
    // typescript-eslint's `projectService` walks up for that name and finds nothing else.
    if (fileSetIncludesTests(path.join(dir, 'tsconfig.json'), dir)) return

    const testConfig = path.join(dir, 'src/__tests__/tsconfig.json')
    expect(fs.existsSync(testConfig), `${pkg}'s build tsconfig omits its tests and it has no src/__tests__/tsconfig.json`).toBe(true)
    expect(fileSetIncludesTests(testConfig, dir), `${pkg}'s src/__tests__/tsconfig.json does not actually cover its tests`).toBe(true)

    const scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts ?? {}
    expect(scripts.typecheck ?? '', `${pkg}'s typecheck script does not run its test tsconfig`)
      .toContain('src/__tests__/tsconfig.json')
  }, 30_000)
})

describe('the test trees are linted', () => {
  it('eslint does not ignore __tests__', () => {
    const config = fs.readFileSync(path.join(REPO, 'eslint.config.mjs'), 'utf8')
    // Anchored on the ignore entry rather than on a comment: re-adding it is the one edit that
    // silently turns the second gate back off. A spelling assertion is a floor — `__tests__` reached
    // by a computed string would walk past it — and the typecheck half above is what does not depend
    // on spelling at all.
    expect(config).not.toMatch(/ignores:\s*\[[^\]]*__tests__/)
  })
})
