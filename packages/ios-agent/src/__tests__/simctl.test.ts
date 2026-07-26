import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { execFileMock, spawnMock } = vi.hoisted(() => ({ execFileMock: vi.fn(), spawnMock: vi.fn() }))
vi.mock('child_process', () => ({ execFile: execFileMock, spawn: spawnMock }))

import { defaultRunner } from '../simctl'

const VERSION_MISMATCH_ERR = Object.assign(new Error('simctl failed'), {
  stderr: 'CoreSimulator.framework was changed while the process was running. Service version (1051.50) does not match expected service version (1051.54).',
})

describe('defaultRunner — CoreSimulatorService 자동 복구', () => {
  let restoreTimeout: () => void

  beforeEach(() => {
    execFileMock.mockReset()
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: TimerHandler) => {
      queueMicrotask(fn as () => void)
      return 0 as unknown as ReturnType<typeof setTimeout>
    })
    restoreTimeout = () => spy.mockRestore()
  })

  afterEach(() => restoreTimeout())

  it('버전 불일치 에러 발생 시 killall 후 재시도하여 성공한다', async () => {
    let simctlCallCount = 0
    execFileMock.mockImplementation((cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (e: Error | null, r?: { stdout: string }) => void
      if (cmd === 'killall') {
        cb(null, { stdout: '' })
      } else {
        simctlCallCount++
        if (simctlCallCount === 1) {
          cb(VERSION_MISMATCH_ERR)
        } else {
          cb(null, { stdout: 'ok' })
        }
      }
      return { on: vi.fn() }
    })

    const result = await defaultRunner.exec('list', 'devices')
    expect(result).toBe('ok')
    expect(execFileMock.mock.calls.some((c: unknown[]) => (c as [string])[0] === 'killall')).toBe(true)
  })

  it('버전 불일치가 아닌 에러는 즉시 throw한다', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (e: Error | null) => void
      cb(new Error('some other error'))
      return { on: vi.fn() }
    })
    await expect(defaultRunner.exec('list')).rejects.toThrow('some other error')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('재시도에도 실패하면 에러를 throw한다', async () => {
    execFileMock.mockImplementation((cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (e: Error | null, r?: { stdout: string }) => void
      if (cmd === 'killall') {
        cb(null, { stdout: '' })
      } else {
        cb(VERSION_MISMATCH_ERR)
      }
      return { on: vi.fn() }
    })

    await expect(defaultRunner.exec('list')).rejects.toThrow()
    const simctlCalls = execFileMock.mock.calls.filter(
      (c: unknown[]) => (c as [string])[0] !== 'killall'
    )
    expect(simctlCalls).toHaveLength(2)
  })
})

// `execWithOpts` is the shape pbcopy/pbpaste need (stdin, timeout, size ceiling). It spawns
// rather than execFile, so it reimplements the plumbing — which means the recovery every other
// simctl call gets had to be wired in deliberately. Before this existed the clipboard was the
// one path that could not heal from a service version mismatch.
describe('defaultRunner.execWithOpts', () => {
  /** Minimal ChildProcess stand-in: emits the given stdout/stderr, then closes with `code`. */
  function fakeProc(opts: { stdout?: string; stderr?: string; code?: number } = {}) {
    const emit = (cb: (b: Buffer) => void, text?: string) => { if (text) queueMicrotask(() => cb(Buffer.from(text))) }
    return {
      stdout: { on: (ev: string, cb: (b: Buffer) => void) => { if (ev === 'data') emit(cb, opts.stdout) } },
      stderr: { on: (ev: string, cb: (b: Buffer) => void) => { if (ev === 'data') emit(cb, opts.stderr) } },
      stdin: { on: vi.fn(), write: vi.fn(), end: vi.fn() },
      on: (ev: string, cb: (code: number) => void) => {
        // close must land after the data callbacks above, or stderr is lost
        if (ev === 'close') queueMicrotask(() => queueMicrotask(() => cb(opts.code ?? 0)))
      },
      kill: vi.fn(),
    }
  }

  let restoreTimeout: () => void

  beforeEach(() => {
    execFileMock.mockReset()
    spawnMock.mockReset()
    // restartCoreSimulatorService sleeps 3s; run timers eagerly so the recovery tests do not
    // spend that in real time. The timeout test below sets its own delay and needs this too —
    // it fires immediately, which is fine since the fake proc never closes either way.
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: TimerHandler) => {
      queueMicrotask(fn as () => void)
      return 0 as unknown as ReturnType<typeof setTimeout>
    })
    restoreTimeout = () => spy.mockRestore()
  })

  afterEach(() => restoreTimeout())

  it('recovers from a version mismatch and retries, like exec does', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (e: Error | null, r?: { stdout: string }) => void
      cb(null, { stdout: '' })   // killall
      return { on: vi.fn() }
    })
    let call = 0
    spawnMock.mockImplementation(() => (++call === 1
      ? fakeProc({ stderr: VERSION_MISMATCH_ERR.stderr, code: 1 })
      : fakeProc({ stdout: 'recovered' })))

    await expect(defaultRunner.execWithOpts({}, 'pbpaste', 'UDID')).resolves.toBe('recovered')
    expect(execFileMock.mock.calls.some((c: unknown[]) => (c as [string])[0] === 'killall')).toBe(true)
  })

  it('surfaces the documented guidance when recovery fails too', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (e: Error | null, r?: { stdout: string }) => void
      cb(null, { stdout: '' })
      return { on: vi.fn() }
    })
    spawnMock.mockImplementation(() => fakeProc({ stderr: VERSION_MISMATCH_ERR.stderr, code: 1 }))

    await expect(defaultRunner.execWithOpts({}, 'pbpaste', 'UDID')).rejects.toThrow(/killall -9/)
  })

  it('writes `input` to stdin — the reason this shape exists', async () => {
    const proc = fakeProc()
    spawnMock.mockReturnValue(proc)
    await defaultRunner.execWithOpts({ input: 'clipboard text' }, 'pbcopy', 'UDID')
    expect(proc.stdin.write).toHaveBeenCalledWith('clipboard text')
    expect(proc.stdin.end).toHaveBeenCalled()
  })

  it('rejects past maxBuffer instead of buffering without bound', async () => {
    spawnMock.mockReturnValue(fakeProc({ stdout: 'x'.repeat(50) }))
    await expect(defaultRunner.execWithOpts({ maxBuffer: 10 }, 'pbpaste', 'UDID'))
      .rejects.toThrow(/maxBuffer/)
  })

  it('kills and rejects on timeout rather than hanging the caller', async () => {
    const proc = { ...fakeProc(), on: vi.fn(), kill: vi.fn() }   // never closes
    spawnMock.mockReturnValue(proc)
    await expect(defaultRunner.execWithOpts({ timeoutMs: 20 }, 'pbpaste', 'UDID'))
      .rejects.toThrow(/timed out/)
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('reports the command stderr on a non-zero exit', async () => {
    spawnMock.mockReturnValue(fakeProc({ stderr: 'Device must be booted to access its pasteboard.', code: 1 }))
    await expect(defaultRunner.execWithOpts({}, 'pbpaste', 'UDID'))
      .rejects.toThrow(/must be booted/)
  })
})
