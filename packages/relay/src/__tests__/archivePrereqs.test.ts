import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockSpawnSync } = vi.hoisted(() => ({ mockSpawnSync: vi.fn() }))
vi.mock('child_process', () => ({ spawnSync: mockSpawnSync }))

import { assertArchiveTools } from './helpers/archivePrereqs'

type SpawnResult = {
  error?: Error & { code?: string }
  status?: number | null
  signal?: string | null
  stdout?: string
  stderr?: string
}

function okResult(): SpawnResult {
  return { status: 0, stdout: 'ok', stderr: '' }
}

function spawnErrorResult(code: string): SpawnResult {
  const error = Object.assign(new Error(`spawn unzip ${code}`), { code })
  return { error, status: null, signal: null, stdout: '', stderr: '' }
}

beforeEach(() => {
  mockSpawnSync.mockReset()
})

// assertArchiveTools only shells to version checks, so CI cannot reach its
// failure branches: the workflow step already proved both tools resolve and
// run. These mocked cases are the only exercise of those branches.
describe('assertArchiveTools', () => {
  it('passes when both tools report version success', () => {
    mockSpawnSync.mockReturnValue(okResult())
    expect(() => assertArchiveTools(['unzip', 'tar'])).not.toThrow()
    expect(mockSpawnSync).toHaveBeenCalledTimes(2)
  })

  it('reports ENOENT as missing on PATH', () => {
    mockSpawnSync.mockReturnValue(spawnErrorResult('ENOENT'))
    expect(() => assertArchiveTools(['unzip'])).toThrow(/missing executables \(not found on PATH\)/)
    expect(() => assertArchiveTools(['unzip'])).toThrow(/unzip/)
  })

  it('reports non-ENOENT spawn errors as broken, not missing', () => {
    mockSpawnSync.mockReturnValue(spawnErrorResult('EACCES'))
    expect(() => assertArchiveTools(['unzip'])).toThrow(
      /executables that fail to start or fail their version check/,
    )
    expect(() => assertArchiveTools(['unzip'])).not.toThrow(/not found on PATH/)
  })

  it('reports a nonzero version exit as broken with the exit status', () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      signal: null,
      stdout: '',
      stderr: 'unzip cannot run',
    })
    expect(() => assertArchiveTools(['tar'])).toThrow(/exited with status 1/)
    expect(() => assertArchiveTools(['tar'])).toThrow(
      /executables that fail to start or fail their version check/,
    )
  })
})
