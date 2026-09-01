import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { execFile, spawn } from 'child_process'
import { createLogger } from '@tapflowio/agent-core'

vi.mock('child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }))
const mockLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
vi.mock('@tapflowio/agent-core', () => {
  return {
    createLogger: vi.fn(() => mockLogger),
    PlatformError: class PlatformError extends Error {},
    ValidationError: class ValidationError extends Error {}
  }
})

function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    kill: ReturnType<typeof vi.fn>
    unref: ReturnType<typeof vi.fn>
  }
  proc.stdout = new EventEmitter()
  proc.kill = vi.fn()
  proc.unref = vi.fn()
  return proc
}

// execFile callback arrives as the last argument regardless of options
function cbSuccess(_f: unknown, _a: unknown, cb: (e: null, out: string, err: string) => void) {
  cb(null, '', '')
  return {} as ReturnType<typeof execFile>
}

function cbFail(error: Error) {
  return (_f: unknown, _a: unknown, cb: (e: Error) => void) => {
    cb(error)
    return {} as ReturnType<typeof execFile>
  }
}

describe('ScrcpySession', () => {
  beforeEach(() => {
    process.env['ADB_PATH'] = '/usr/bin/adb'
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetAllMocks()
    delete process.env['ADB_PATH']
  })

  it('kills serverProc when an error is thrown after spawn', async () => {
    vi.useFakeTimers()

    const proc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(proc as never)
    vi.mocked(execFile)
      .mockImplementationOnce(cbSuccess as never)                              // push: success
      .mockImplementationOnce(cbFail(new Error('forward failed')) as never)   // forward: fail

    const { ScrcpySession } = await import('../scrcpy/ScrcpySession.js')
    const session = new ScrcpySession()

    // Attach catch immediately to prevent PromiseRejectionHandledWarning
    let caughtError: Error | undefined
    const startPromise = session.start('emulator-5554').catch(e => { caughtError = e })
    await vi.advanceTimersByTimeAsync(1500)
    await startPromise

    expect(caughtError?.message).toBe('forward failed')
    expect(proc.kill).toHaveBeenCalled()
  })

  it('does not kill serverProc on the error path before spawn', async () => {
    vi.useFakeTimers()

    const proc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(proc as never)
    vi.mocked(execFile)
      .mockImplementationOnce(cbFail(new Error('push failed')) as never)  // push: fail (before spawn)

    const { ScrcpySession } = await import('../scrcpy/ScrcpySession.js')
    const session = new ScrcpySession()

    await expect(session.start('emulator-5554')).rejects.toThrow('push failed')
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('does not crash the process when serverProc emits an error', async () => {
    vi.useFakeTimers()

    const proc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(proc as never)
    vi.mocked(execFile)
      .mockImplementationOnce(cbSuccess as never)                            // push: success
      .mockImplementationOnce(cbFail(new Error('forward failed')) as never) // forward: fail

    const { ScrcpySession } = await import('../scrcpy/ScrcpySession.js')
    const session = new ScrcpySession()

    const startPromise = session.start('emulator-5554').catch(() => {})

    // Flush the awaited push (execFileAsync) so start() reaches the spawn() call and
    // attaches its listeners before we emit — spawn() itself runs after that await.
    await vi.advanceTimersByTimeAsync(0)

    // An EventEmitter throws a synchronous, uncaught error on 'error' with no listener
    // attached — e.g. spawn() failing (ENOENT/EACCES) or EPERM from kill() — which would
    // crash the whole agent (all devices it manages), not just this session.
    expect(() => proc.emit('error', new Error('EPIPE'))).not.toThrow()

    await vi.advanceTimersByTimeAsync(1500)
    await startPromise
  })

  it('logs a warning when serverProc emits exit before stop is called', async () => {
    vi.useFakeTimers()

    const proc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(proc as never)
    vi.mocked(execFile)
      .mockImplementationOnce(cbSuccess as never)
      .mockImplementationOnce(cbFail(new Error('forward failed')) as never)

    const { ScrcpySession } = await import('../scrcpy/ScrcpySession.js')
    const session = new ScrcpySession()
    const startPromise = session.start('emulator-5554').catch(() => {})

    await vi.advanceTimersByTimeAsync(0)

    proc.emit('exit', 1, 'SIGKILL')

    expect(mockLogger.warn).toHaveBeenCalledWith('server process exited (code: 1, signal: SIGKILL)')

    await vi.advanceTimersByTimeAsync(1500)
    await startPromise
  })

  it('does not log a warning when serverProc emits exit after stop is called', async () => {
    vi.useFakeTimers()

    const proc = makeFakeProc()
    vi.mocked(spawn).mockReturnValue(proc as never)
    vi.mocked(execFile)
      .mockImplementationOnce(cbSuccess as never)
      .mockImplementationOnce(cbFail(new Error('forward failed')) as never)

    const { ScrcpySession } = await import('../scrcpy/ScrcpySession.js')
    const session = new ScrcpySession()
    const startPromise = session.start('emulator-5554').catch(() => {})

    await vi.advanceTimersByTimeAsync(0)

    session.stop('emulator-5554')
    proc.emit('exit', 0, null)

    expect(mockLogger.warn).not.toHaveBeenCalledWith('server process exited (code: 0, signal: null)')

    await vi.advanceTimersByTimeAsync(1500)
  })
})
