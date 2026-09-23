import { mergeConfig, defineConfig } from 'vitest/config'
import { sourceFirst } from '../../vitest.shared'

// `sourceFirst`: the MCP client and tools import sibling workspace packages, so tests must not use stale dist output.
export default mergeConfig(sourceFirst, defineConfig({}))
