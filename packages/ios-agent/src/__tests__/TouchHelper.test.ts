import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('child_process', () => ({ spawn: vi.fn() }))

function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { writable: boolean; write: ReturnType<typeof vi.fn> }
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }
  proc.stdin = Object.assign(new EventEmitter(), { writable: true, write: vi.fn() }) as never
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  return proc
}

async function setupHelper() {
  const { spawn } = await import('child_process')
  const proc = makeFakeProc()
  vi.mocked(spawn).mockReturnValue(proc as never)
  const { TouchHelper } = await import('../TouchHelper.js')
  const helper = new TouchHelper('dev-1')
  helper.start()
  return { helper, proc }
}

describe('TouchHelper.stop()', () => {
  afterEach(() => vi.useRealTimers())

  it('sends SIGTERM on stop', async () => {
    const { helper, proc } = await setupHelper()
    helper.stop()

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('does not send SIGKILL when the process exits within the fallback window', async () => {
    vi.useFakeTimers()
    const { helper, proc } = await setupHelper()

    helper.stop()
    proc.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(1000)

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL')
  })

  it('sends SIGKILL if the process does not exit within the fallback window', async () => {
    vi.useFakeTimers()
    const { helper, proc } = await setupHelper()

    helper.stop()
    await vi.advanceTimersByTimeAsync(1000)

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('is a no-op when called again after the process is already gone', async () => {
    vi.useFakeTimers() // leave the first stop()'s fallback timer pending, never fired, no leak into other tests
    const { helper, proc } = await setupHelper()

    helper.stop()
    helper.stop()

    expect(proc.kill).toHaveBeenCalledTimes(1)
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
