import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// #422 brought the test trees under `tsc` and eslint. The arrangement it landed is easy to half-copy:
// a new package clones a build tsconfig that excludes `src/__tests__` and does not add the second
// tsconfig, and its whole test tree is then outside every project with `pnpm typecheck` still green —
// which is the state #422 existed to end.
//
// Found by inspection rather than by a list, for the same reason `testsReadSource.test.mjs` is:
// a hardcoded list is satisfied by not being edited.
const PACKAGES_DIR = path.resolve(import.meta.dirname, '../../packages')

function packagesWithTests() {
  return fs.readdirSync(PACKAGES_DIR)
    .filter((d) => fs.existsSync(path.join(PACKAGES_DIR, d, 'src/__tests__')))
    .filter((d) => fs.readdirSync(path.join(PACKAGES_DIR, d, 'src/__tests__'))
      .some((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx')))
}

/** Comments are legal in these files (tsc reads JSONC), so strip them before parsing. */
function readJsonc(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '')
  return JSON.parse(raw)
}

describe('every test tree is inside a tsconfig', () => {
  const pkgs = packagesWithTests()

  // Anti-vacuity floor from the measured count at the time of writing, not a round number: a scan
  // that silently stopped finding packages would otherwise pass by covering nothing.
  it('finds the packages that have tests', () => {
    expect(pkgs.length).toBeGreaterThanOrEqual(9)
  })

  it.each(pkgs)('%s: its tests are type-checked', (pkg) => {
    const dir = path.join(PACKAGES_DIR, pkg)
    const build = readJsonc(path.join(dir, 'tsconfig.json'))
    const excluded = (build.exclude ?? []).some((e) => e.replace(/\/$/, '') === 'src/__tests__')

    // Two shapes are valid. Either the build config already includes the tests (dashboard), or the
    // tests have their own config — which must be named `tsconfig.json` and sit in `src/__tests__`,
    // because typescript-eslint's `projectService` walks up for that name and finds nothing else.
    if (!excluded) return

    const testConfig = path.join(dir, 'src/__tests__/tsconfig.json')
    expect(fs.existsSync(testConfig), `${pkg} excludes src/__tests__ but has no src/__tests__/tsconfig.json`).toBe(true)

    const scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts ?? {}
    expect(scripts.typecheck ?? '', `${pkg}'s typecheck script does not run its test tsconfig`)
      .toContain('src/__tests__/tsconfig.json')
  })
})

describe('the test trees are linted', () => {
  it('eslint does not ignore __tests__', () => {
    const config = fs.readFileSync(path.resolve(import.meta.dirname, '../../eslint.config.mjs'), 'utf8')
    // Anchored on the ignore entry rather than on a comment: re-adding it is the one edit that
    // silently turns the second gate back off.
    expect(config).not.toMatch(/ignores:\s*\[[^\]]*__tests__/)
  })
})
