import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { killWithSigkillFallback } from '../childProcessKill.js'

function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }
  proc.kill = vi.fn()
  return proc
}

describe('killWithSigkillFallback', () => {
  afterEach(() => vi.useRealTimers())

  it('is a no-op for a null process', () => {
    expect(() => killWithSigkillFallback(null)).not.toThrow()
  })

  it('sends SIGTERM immediately', () => {
    const proc = makeFakeProc()
    killWithSigkillFallback(proc as never)

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('does not send SIGKILL when the process exits within the timeout', async () => {
    vi.useFakeTimers()
    const proc = makeFakeProc()
    killWithSigkillFallback(proc as never, 1000)

    proc.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(1000)

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL')
  })

  it('sends SIGKILL if the process does not exit within the timeout', async () => {
    vi.useFakeTimers()
    const proc = makeFakeProc()
    killWithSigkillFallback(proc as never, 1000)

    await vi.advanceTimersByTimeAsync(1000)

    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('honors a custom timeout', async () => {
    vi.useFakeTimers()
    const proc = makeFakeProc()
    killWithSigkillFallback(proc as never, 3000)

    await vi.advanceTimersByTimeAsync(1000)
    expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL')

    await vi.advanceTimersByTimeAsync(2000)
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
