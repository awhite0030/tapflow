import { mergeConfig, defineConfig } from 'vitest/config'
import { reactWithCompiler } from './reactPlugin'
import path from 'path'
import { sourceFirst } from '../../vitest.shared'

// `sourceFirst`: this package's tests import a sibling, and must see its source rather than the
// last thing built of it. See vitest.shared.ts.
export default mergeConfig(sourceFirst, defineConfig({
  // The compiler runs here too: a suite that exercises uncompiled source is not testing what
  // ships, and the output differs — memoised callbacks, hoisted values, different identities.
  plugins: [reactWithCompiler()],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    testTimeout: 10000,
  },
}))
