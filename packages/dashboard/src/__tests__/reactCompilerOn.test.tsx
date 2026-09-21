import { describe, it, expect } from 'vitest'
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
    // The guard above is only meaningful if the pattern cannot match unprocessed source. This is
    // what `CompilerProbe` looks like before the compiler touches it.
    const uncompiled = `function CompilerProbe({ items }) {
      const upper = items.map((i) => i.toUpperCase())
      return upper
    }`
    expect(uncompiled).not.toMatch(/const \$ = .{0,40}\(\d+\)/)
  })
})
