import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sources } from './sourceFiles.mjs'

const root = join(import.meta.dirname, '../..')
const agentCore = readFileSync(join(root, 'packages/agent-core/src/types.ts'), 'utf8')

function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s*\/\/.*$/gm, '')
}

function stringLiterals(text) {
  return [...text.matchAll(/'([^']+)'/g)].map((match) => match[1])
}

function agentCapabilities(text) {
  const match = withoutComments(text).match(/export type AgentCapability\s*=\s*([\s\S]*?)(?=\n\s*\n)/)
  expect(match, 'AgentCapability union did not parse').not.toBeNull()
  return new Set(stringLiterals(match[1]))
}

function dashboardCapabilityConsumers() {
  const consumers = []
  const capabilityCheck = /\b(?:agentCapabilities|(?:\w+\??\.)?capabilities)\??\.includes\(\s*'([^']+)'\s*\)/g

  for (const file of sources('packages/dashboard')) {
    const source = withoutComments(readFileSync(join(root, file), 'utf8'))
    for (const match of source.matchAll(capabilityCheck)) {
      consumers.push({ file, capability: match[1] })
    }
  }

  return consumers
}

describe('dashboard capability consumers', () => {
  it('only checks capabilities AgentCapability declares', () => {
    const declared = agentCapabilities(agentCore)
    const consumers = dashboardCapabilityConsumers()

    // An empty list proves no consumer was scanned, not that consumers agree. The cardinality also
    // catches a narrower matcher that loses one of the current selector/viewer forms.
    expect(consumers).toHaveLength(3)

    const unknown = consumers.filter(({ capability }) => !declared.has(capability))
    expect(unknown).toEqual([])
  })
})
