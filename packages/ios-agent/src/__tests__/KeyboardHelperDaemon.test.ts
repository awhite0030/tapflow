import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('child_process', () => ({ spawn: vi.fn() }))
vi.mock('readline', () => ({ createInterface: vi.fn(() => ({ on: vi.fn() })) }))

function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { writable: boolean; write: ReturnType<typeof vi.fn> }
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }
  proc.stdin = Object.assign(new EventEmitter(), { writable: true, write: vi.fn() }) as never
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  return proc
}

async function setupDaemon() {
  const { spawn } = await import('child_process')
  const proc = makeFakeProc()
  vi.mocked(spawn).mockReturnValue(proc as never)
  const { KeyboardHelperDaemon } = await import('../KeyboardHelperDaemon.js')
  const daemon = new KeyboardHelperDaemon()
  const showPromise = daemon.show('dev-1') // drives ensureStarted() → spawn()
  return { daemon, proc, showPromise }
}

// Timer-precision cases (SIGKILL suppressed/fired) are covered by childProcessKill.test.ts —
// these check KeyboardHelperDaemon actually wires stop() to it, and that the queue/pending
// rejection logic runs independently of the fallback timer.
describe('KeyboardHelperDaemon.stop()', () => {
  afterEach(() => vi.useRealTimers())

  it('sends SIGTERM, then escalates to SIGKILL if the process never exits', async () => {
    vi.useFakeTimers()
    const { daemon, proc, showPromise } = await setupDaemon()
    showPromise.catch(() => {})

    daemon.stop()
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')

    await vi.advanceTimersByTimeAsync(1000)
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('is a no-op when called again after the process is already gone', async () => {
    vi.useFakeTimers() // leave the first stop()'s fallback timer pending, never fired, no leak into other tests
    const { daemon, proc, showPromise } = await setupDaemon()
    showPromise.catch(() => {})

    daemon.stop()
    daemon.stop()

    expect(proc.kill).toHaveBeenCalledTimes(1)
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('rejects pending and queued commands independently of the SIGKILL timer', async () => {
    vi.useFakeTimers() // leave the fallback timer pending, never fired, no leak into other tests
    const { daemon, showPromise } = await setupDaemon()
    const queuedPromise = daemon.hide('dev-1')

    daemon.stop()

    await expect(showPromise).rejects.toThrow('keyboard-helper daemon stopped')
    await expect(queuedPromise).rejects.toThrow('keyboard-helper daemon stopped')
  })
})
