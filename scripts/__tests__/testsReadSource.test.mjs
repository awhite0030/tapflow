// A test in one package must exercise its sibling's SOURCE, not whatever was last built of it.
//
// #459 shipped a regression behind a green 1889-test run because that was not true: `ios-agent`
// stands up a real `RelayServer`, the import resolved through `exports` to `dist/`, and `dist` was
// stale. It surfaced only when the pre-commit `tsc -b` refreshed the build.
//
// The guard is `ssr.resolve.conditions` in `vitest.shared.ts`, which each affected package extends.
// Two ways that silently stops working — a package drops the config, or a NEW package starts
// importing a sibling and never adds it — so this checks both, and checks the resolution itself
// rather than trusting the config to mean what it says.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { readFileSync, readdirSync, existsSync, writeFileSync, appendFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PKGS = join(ROOT, 'packages')

const packageDirs = () =>
  readdirSync(PKGS).filter((d) => existsSync(join(PKGS, d, 'package.json')))

/** Does this package's own test files import a sibling workspace package? */
function testsImportASibling(dir) {
  const tests = join(PKGS, dir, 'src', '__tests__')
  if (!existsSync(tests)) return false
  try {
    execFileSync('grep', ['-rlq', '@tapflowio/', tests], { stdio: 'ignore' })
    return true
  } catch { return false }
}

const extendsShared = (dir) => {
  const cfg = join(PKGS, dir, 'vitest.config.ts')
  return existsSync(cfg) && readFileSync(cfg, 'utf8').includes('sourceFirst')
}

describe('every package whose tests import a sibling reads its source', () => {
  // Derived, not listed. A hardcoded list is exactly how vitest came to be the tool nobody had
  // switched on: it described the day it was written.
  const affected = packageDirs().filter(testsImportASibling)

  it('finds the packages by inspection, not from a list', () => {
    expect(affected.length).toBeGreaterThanOrEqual(5)
  })

  it.each(affected)('%s extends the shared config', (dir) => {
    expect(extendsShared(dir), `packages/${dir} imports a sibling in its tests but does not extend sourceFirst`).toBe(true)
  })
})

describe("the copied condition list still matches vite's", () => {
  // `vitest.shared.ts` cannot import `vite` — most packages that load it do not depend on it — so
  // it copies `defaultServerConditions`. Copies go stale silently, and the way this one goes stale
  // is ugly: dropping `node` from the list sent jsdom to the wrong entry of `decimal.js` and killed
  // ten dashboard tests with `Decimal is not a constructor`.
  it('has not drifted', () => {
    const actual = JSON.parse(execFileSync('node', ['--input-type=module', '-e',
      `import('vite').then(v => console.log(JSON.stringify(v.defaultServerConditions)))`],
      { cwd: join(PKGS, 'dashboard'), encoding: 'utf8' }))
    const copied = readFileSync(join(ROOT, 'vitest.shared.ts'), 'utf8')
      .match(/conditions:\s*\[([^\]]*)\]/)[1]
      .split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)

    expect(copied[0], 'source must come first, or the build wins').toBe('source')
    expect(copied.slice(1)).toEqual(actual)
  }, 30_000)
})

describe('and the resolution really lands on source', () => {
  // The config could be present and not work — a vitest upgrade moving the setting, a merge that
  // drops it. So this plants a marker in a built artifact and asserts a cross-package import
  // cannot see it. It is the only assertion here that would survive the config being a no-op.
  const RELAY_DIST = join(PKGS, 'relay', 'dist', 'index.js')
  const MARKER = '__LOADED_FROM_DIST__'

  it('a cross-package import does not see a symbol that exists only in dist', () => {
    if (!existsSync(RELAY_DIST)) {
      throw new Error('packages/relay/dist/index.js is missing — run `pnpm build` first; this test needs a build to plant a marker in')
    }
    const before = readFileSync(RELAY_DIST, 'utf8')
    appendFileSync(RELAY_DIST, `\nexport const ${MARKER} = true;\n`)
    try {
      const probe = join(PKGS, 'ios-agent', 'src', '__tests__', 'zz-source-resolution.probe.test.ts')
      writeFileSync(probe, [
        `import { it, expect } from 'vitest'`,
        `import * as relay from '@tapflowio/relay'`,
        `it('resolves to source', () => { expect('${MARKER}' in relay).toBe(false) })`,
        '',
      ].join('\n'))
      try {
        execFileSync('npx', ['vitest', 'run', '--root', join(PKGS, 'ios-agent'),
          'src/__tests__/zz-source-resolution.probe.test.ts'],
          { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' })
      } finally {
        execFileSync('rm', ['-f', probe])
      }
    } finally {
      writeFileSync(RELAY_DIST, before)
    }
  }, 120_000)
})
