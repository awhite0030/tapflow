import { mergeConfig, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import { sourceFirst } from '../../vitest.shared'

// `sourceFirst`: this package's tests import a sibling, and must see its source rather than the
// last thing built of it. See vitest.shared.ts.
export default mergeConfig(sourceFirst, defineConfig({
  plugins: [react()],
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
