/**
 * Serialise async work per key, so two operations on the same target cannot interleave.
 *
 * The clipboard bridge needs this: a read parks a marker on the device while it waits, so two
 * concurrent reads would each observe the other's marker instead of the real clipboard. Keyed
 * by device rather than session, because several sessions (and MCP) can address one device.
 *
 * A rejected task does not poison the queue — the stored tail never rejects.
 */
export function createKeyedSerialQueue(): <T>(key: string, run: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(key: string, run: () => Promise<T>): Promise<T> => {
    // `.then(run, run)` so the next task starts whether the previous settled or threw.
    const next = (tails.get(key) ?? Promise.resolve()).then(run, run)
    tails.set(key, next.then(() => {}, () => {}))
    return next
  }
}
