import type { WebSocket } from 'ws'

/** The shape every tapflow socket message shares. Deliberately loose: this package is imported by
 *  relay, ios-agent and android-agent, and each has its own richer view of the wire. */
export type SocketMessage = Record<string, unknown> & { type: string }

/**
 * Order-proof socket helpers for tapflow tests.
 *
 * **Why these exist rather than a `ws.once('message')` in each file.** The obvious shape —
 * "attach a listener, wait for the message" — only works if you attach before the message is sent.
 * Get the order wrong and nothing tells you: the listener sits on a reply that already went past,
 * and the test dies on a timeout pointing at the assertion instead of the cause. That mistake
 * happened three times in one branch (#452), twice with a correct example a few lines above.
 *
 * So these record instead of listening. From the moment a socket is opened, every message it
 * receives is either handed to a waiter or kept, and `waitForType` looks in the recording first.
 * Asking after the fact works exactly like asking before it:
 *
 * ```ts
 * const ws = new WebSocket(url)
 * await waitForOpen(ws)
 * ws.send(JSON.stringify({ type: 'device:boot', ... }))
 * await waitForType(ws, 'device:ready')   // fine whether it has landed yet or not
 * ```
 *
 * Matched messages are removed from the recording, so two waits for the same type see two
 * different messages.
 *
 * **This is a queue, not a broadcast.** The old per-call listeners each saw every message, so two
 * concurrent waits for one type both resolved from a single message. Here a message goes to
 * exactly one waiter. Two consequences worth knowing:
 *
 * - A pending {@link waitForMessage} (which matches any type) takes the next message even if a
 *   {@link waitForType} for that exact type is also waiting. Register the specific one first, or
 *   do not mix them on a socket where it matters.
 * - A {@link waitForTypeOrNull} that times out leaves nothing behind, but a message arriving after
 *   that goes into the recording and will answer a later wait on the same socket. That is usually
 *   what you want; it is surprising if you expected the timeout to have consumed it.
 */

type Waiter = { type: string | null; resolve: (msg: SocketMessage) => void }
type Recording = { queued: SocketMessage[]; waiters: Waiter[] }

const recordings = new WeakMap<WebSocket, Recording>()

/** Idempotent: a socket recorded twice would deliver every message twice. */
function record(ws: WebSocket): Recording {
  const existing = recordings.get(ws)
  if (existing) return existing

  const rec: Recording = { queued: [], waiters: [] }
  recordings.set(ws, rec)

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    // Stream frames share this socket in some tests and are not JSON.
    if (isBinary) return
    let msg: SocketMessage
    try {
      msg = JSON.parse(data.toString()) as SocketMessage
    } catch {
      return
    }
    const i = rec.waiters.findIndex((w) => w.type === null || w.type === msg.type)
    if (i >= 0) {
      rec.waiters.splice(i, 1)[0]!.resolve(msg)
      return
    }
    rec.queued.push(msg)
  })

  return rec
}

/**
 * Waits for the socket to open, and starts recording everything it receives from that point.
 *
 * Every socket in these suites goes through here, which is what makes `waitForType` order-proof.
 * A socket that skips it still works — the helpers below start recording on first use — but only
 * from that call onwards, so anything that arrived earlier is genuinely gone.
 */
export const waitForOpen = (ws: WebSocket): Promise<void> => {
  record(ws)
  return new Promise((resolve) => ws.once('open', resolve))
}

/** The next message of `type`, taken from the recording if it has already arrived. */
export function waitForType(ws: WebSocket, type: string): Promise<SocketMessage> {
  const rec = record(ws)
  const i = rec.queued.findIndex((m) => m.type === type)
  if (i >= 0) return Promise.resolve(rec.queued.splice(i, 1)[0]!)
  return new Promise((resolve) => rec.waiters.push({ type, resolve }))
}

/** The next message of any type. Same recording, same ordering guarantee. */
export function waitForMessage(ws: WebSocket): Promise<SocketMessage> {
  const rec = record(ws)
  if (rec.queued.length > 0) return Promise.resolve(rec.queued.shift()!)
  return new Promise((resolve) => rec.waiters.push({ type: null, resolve }))
}

/**
 * Resolves with the message, or `null` after `ms`.
 *
 * For asserting a message does **not** arrive. Prefer {@link barrier} where one fits: a round-trip
 * proves the relay has finished with everything sent before it, which is an answer rather than a
 * guess, and it costs milliseconds instead of the timeout.
 */
export function waitForTypeOrNull(ws: WebSocket, type: string, ms = 1000): Promise<SocketMessage | null> {
  const rec = record(ws)
  const i = rec.queued.findIndex((m) => m.type === type)
  if (i >= 0) return Promise.resolve(rec.queued.splice(i, 1)[0]!)
  return new Promise((resolve) => {
    const waiter: Waiter = { type, resolve: (m) => { clearTimeout(timer); resolve(m) } }
    rec.waiters.push(waiter)
    const timer = setTimeout(() => {
      const j = rec.waiters.indexOf(waiter)
      if (j >= 0) rec.waiters.splice(j, 1)
      resolve(null)
    }, ms)
  })
}

/**
 * A round-trip on one socket.
 *
 * WebSocket preserves order within a connection, so once the reply lands the relay has processed
 * everything sent before it. Two sockets have no ordering between them — an agent's
 * `device:ready` and a browser's `session:start` can be handled in either order — so a test that
 * depends on one preceding the other needs this on the *sending* socket. A sleep only makes it
 * likely.
 *
 * `agents:list` is used because it is answered on the same socket regardless of role.
 */
export async function barrier(ws: WebSocket): Promise<void> {
  const done = waitForType(ws, 'agents:listed')
  ws.send(JSON.stringify({ type: 'agents:list' }))
  await done
}
