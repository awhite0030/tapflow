import { describe, it, expect, vi, afterEach } from 'vitest'
import { defaultRunner } from '../adb'
import * as child_process from 'child_process'
import { promisify } from 'util'

vi.mock('child_process', () => {
  return {
    execFile: vi.fn((file, args, options, callback) => {
      if (typeof options === 'function') {
        callback = options
        options = {}
      }
      callback(null, { stdout: 'mocked' }, { stderr: '' })
    }),
  }
})

describe('adb', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('passes maxBuffer to execFileAsync in exec', async () => {
    await defaultRunner.exec('devices')
    expect(child_process.execFile).toHaveBeenCalledWith(
      expect.any(String),
      ['devices'],
      expect.objectContaining({ maxBuffer: 64 * 1024 * 1024 }),
      expect.any(Function)
    )
  })

  it('passes maxBuffer to execFileAsync in execBinary', async () => {
    await defaultRunner.execBinary('screencap', '-p')
    expect(child_process.execFile).toHaveBeenCalledWith(
      expect.any(String),
      ['screencap', '-p'],
      expect.objectContaining({ encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }),
      expect.any(Function)
    )
  })
})
