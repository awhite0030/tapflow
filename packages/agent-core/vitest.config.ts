import { mergeConfig, defineConfig } from 'vitest/config'
import { sourceFirst } from '../../vitest.shared'

export default mergeConfig(sourceFirst, defineConfig({}))
