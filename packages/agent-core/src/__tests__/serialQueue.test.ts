import { describe, it, expect } from 'vitest'
import { createKeyedSerialQueue } from '../utils/serialQueue'

const defer = () => {
  let resolve!: (v?: unknown) => void
  let reject!: (e: Error) => void
  const promise = new Promise((res, rej) => { resolve = res as () => void; reject = rej })
  return { promise, resolve, reject }
}

describe('createKeyedSerialQueue', () => {
  // The obvious `.then(run, run)` spelling would pass the previous task's outcome in as `run`'s
  // first argument. Nothing does that today; this stops it becoming true silently.
  it('calls each task with no arguments, even after the previous one rejected', async () => {
    const queue = createKeyedSerialQueue()
    const args: unknown[][] = []
    const record = (...a: unknown[]): Promise<void> => { args.push(a); return Promise.resolve() }

    await queue('dev', () => Promise.reject(new Error('boom'))).catch(() => {})
    await queue('dev', record)
    await queue('dev', record)
    expect(args).toEqual([[], []])
  })

  it('runs one task at a time per key, in order', async () => {
    const queue = createKeyedSerialQueue()
    const log: string[] = []
    const gate = defer()

    const first = queue('dev', async () => { log.push('start:A'); await gate.promise; log.push('end:A') })
    const second = queue('dev', async () => { log.push('start:B'); log.push('end:B') })

    // B must not have begun while A is still in flight — that overlap is the bug this prevents.
    await Promise.resolve()
    expect(log).toEqual(['start:A'])

    gate.resolve()
    await Promise.all([first, second])
    expect(log).toEqual(['start:A', 'end:A', 'start:B', 'end:B'])
  })

  it('does not block a different key', async () => {
    const queue = createKeyedSerialQueue()
    const gate = defer()
    const blocked = queue('dev-1', () => gate.promise as Promise<void>)

    await expect(queue('dev-2', async () => 'through')).resolves.toBe('through')
    gate.resolve()
    await blocked
  })

  // One failure must not strand every later caller on that device.
  it('keeps serving the key after a task rejects', async () => {
    const queue = createKeyedSerialQueue()
    await expect(queue('dev', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(queue('dev', async () => 'still works')).resolves.toBe('still works')
  })

  it('propagates the task result and its rejection to the caller', async () => {
    const queue = createKeyedSerialQueue()
    await expect(queue('dev', async () => 42)).resolves.toBe(42)
    await expect(queue('dev', async () => { throw new Error('nope') })).rejects.toThrow('nope')
  })
})
