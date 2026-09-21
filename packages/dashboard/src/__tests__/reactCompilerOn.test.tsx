import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CompilerProbe } from './fixtures/compilerProbe'

/**
 * **A build config that quietly stops applying the compiler fails nothing.**
 *
 * Everything the compiler does is an optimisation, so removing it leaves every other test in this
 * package green — the suite would go on passing against source the product no longer ships. That
 * is the same shape as a test reading a stale `dist` (root AGENTS.md, `vitest.shared.ts`), and the
 * reason `reactPlugin.ts` is shared by `vite.config.ts` and `vitest.config.ts` rather than written
 * out twice.
 *
 * What it asserts is the compiler's own output. A compiled component opens with a read from its
 * memo cache — `const $ = _c(n);` in the emitted source — and an uncompiled one has no such line,
 * because the parameter is still destructured in the signature. `CompilerProbe` exists only to
 * give the compiler something worth caching.
 */
describe('the React Compiler is applied to this package', () => {
  it('compiles a component down to a memo-cache read', () => {
    // Fails if `reactPlugin.ts` stops passing `babel-plugin-react-compiler`, or if
    // `vitest.config.ts` goes back to constructing its own `react()` without it.
    expect(CompilerProbe.toString()).toMatch(/const \$ = .{0,40}\(\d+\)/)
  })

  it('and the uncompiled shape is what that pattern rules out', () => {
    // The guard above is only meaningful if the pattern cannot match unprocessed source — so read
    // **the fixture's own source**, not a copy of it typed into the test. A hand-written literal
    // stops describing the fixture the moment anyone edits the fixture, and no build state can make
    // it fail; this one fails if the probe is ever written in a shape the pattern would match
    // before the compiler runs.
    // `import.meta.dirname` rather than a `new URL(..., import.meta.url)`: under jsdom that url
    // is not a file: one, and `readFileSync` rejects it.
    const source = readFileSync(join(import.meta.dirname, 'fixtures', 'compilerProbe.tsx'), 'utf8')
    expect(source).not.toMatch(/const \$ = .{0,40}\(\d+\)/)
  })
})
