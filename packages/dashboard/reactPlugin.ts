import react from '@vitejs/plugin-react'

/**
 * The React plugin, with the compiler, for **both** the build and the test run.
 *
 * `vitest.config.ts` used to construct its own `react()` without the compiler, which would have
 * left the suite exercising source the product does not ship — the same shape as a test reading a
 * stale `dist` (see the root AGENTS.md on `vitest.shared.ts`). Defined once so the two cannot
 * disagree about whether the compiler ran.
 */
export function reactWithCompiler() {
  return react({ babel: { plugins: [['babel-plugin-react-compiler', {}]] } })
}
