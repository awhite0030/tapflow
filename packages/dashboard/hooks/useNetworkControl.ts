import type { BrowserToRelay, NetworkError, NetworkState } from '@tapflowio/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { newRequestId } from '@/lib/requestId'

/** The two frames the agent answers a network request with, plus the report it sends unasked. */
export type NetworkMessage = NetworkState | NetworkError

export type NetworkMessageHandler = (msg: NetworkMessage) => void

/**
 * Where the device is, which is **four things and not two**.
 *
 * `unknown` means no report has arrived and the wait is over — not "the report said something
 * unhelpful". `waiting` is the wait itself, kept apart because collapsing the two would say "could
 * not read" about a device that is merely slow, a claim made before anything was asked.
 *
 * Spelling any of this as a boolean is the mistake the agent made on the other side of this wire: a
 * `lastNetworkOffline` initialised to `false` reported "on the network" for a device that had never
 * been observed, which is the one direction that hides the problem this feature exists to show.
 *
 * **`available: false` is not one of these.** An earlier draft folded it into `unknown`, reading it
 * as "could not read" — but the protocol says the opposite: `NetworkNotSteerable` is *"whatever the
 * device's network is doing, tapflow can no longer change it"*, and it carries `offline` precisely so
 * the viewer can still draw the position. Folding it here threw that away and made the control a
 * one-way ratchet: a device taken offline whose write could not be confirmed rendered as `unknown`,
 * and from `unknown` every click asked for offline again, so nothing could bring it back.
 */
export type NetworkPosition = 'waiting' | 'unknown' | 'online' | 'offline'

interface Options {
  sessionId: string
  send: (msg: BrowserToRelay) => void
  /** Does the connected agent implement network control (from `session:joined`)? */
  supported: boolean
  /** True once this session has a device on screen. Before that there is no state to wait for. */
  deviceReady: boolean
  /** `DeviceViewer` routes `network:*` here; the hook registers itself on mount. */
  handlerRef: MutableRefObject<NetworkMessageHandler | undefined>
  /** Told when a request could not be dispatched. Nothing renders a `network:error` otherwise, and a
   *  click that changes neither the toggle nor anything else is indistinguishable from a dead button. */
  onError?: (message: string) => void
}

/**
 * How long to wait for a report before calling the state unreadable.
 *
 * Derived rather than picked. The relay asks the agent on every re-join, but through a *coalescing*
 * requester whose window is `NETWORK_STATE_REQUEST_THROTTLE_MS` (500ms in `RelayServer.ts`) — so a
 * report can legitimately be one full window late before the agent has even been asked. The agent
 * then makes one adb round trip: milliseconds on a healthy device, and seconds on a Mac that is busy
 * running the emulator it is asking about.
 *
 * 3s is that window plus room for the slow case. Being generous costs nothing — a report that arrives
 * after the deadline is still applied, and `unknown` is a position the control works from rather than
 * a dead end.
 */
export const NETWORK_REPORT_DEADLINE_MS = 3_000

/**
 * How long to wait for the answer to a request before giving the control back.
 *
 * Longer than the report deadline because a `network:set` is a *write* — the agent writes airplane
 * mode and then reads it back to confirm, so two adb round trips rather than one — and because
 * giving up early on a request that is merely slow would report a failure that did not happen.
 */
export const NETWORK_REQUEST_DEADLINE_MS = 8_000

/**
 * The viewer's half of the network control (#607).
 *
 * **Never renders a position it was not told.** The toggle moves when a `network:state` arrives and
 * at no other time — not optimistically on click, and not on a `network:error`, which says the
 * request never reached a device and therefore says nothing about where that device is.
 */
export function useNetworkControl({ sessionId, send, supported, deviceReady, handlerRef, onError }: Options) {
  const [position, setPosition] = useState<NetworkPosition>('waiting')
  // Whether tapflow can still change it — a separate axis from where it is, because the protocol
  // makes them separate. Only the button's sentence depends on this; the position it draws does not.
  const [steerable, setSteerable] = useState(true)
  const [pending, setPending] = useState(false)
  const requestId = useRef<string | null>(null)
  // Read through a ref so a caller passing an inline closure does not re-register the handler on
  // every render — the same shape `useClipboardBridge` uses for its own `onError`.
  const onErrorRef = useRef(onError)
  useEffect(() => { onErrorRef.current = onError }, [onError])

  // A new session knows nothing about its device, and the previous session's answer is about somebody
  // else's. `DeviceViewer` drops frames addressed elsewhere, but it stays mounted across the switch,
  // so without this the old position would sit on screen until a new report replaced it.
  useEffect(() => {
    setPosition('waiting')
    setSteerable(true)
    setPending(false)
    requestId.current = null
  }, [sessionId])

  useEffect(() => {
    if (!supported) return
    handlerRef.current = (msg) => {
      if (msg.type === 'network:error') {
        // Only clears the wait. `network:error` means the request could not be dispatched — no booted
        // device, or a payload the agent could not read — so the device is wherever it already was.
        if (msg.requestId === requestId.current) {
          requestId.current = null
          setPending(false)
          // Announced rather than swallowed. `toast.error` renders with `role="alert"`, so this is
          // also the only thing that tells a screen-reader user the click went nowhere.
          onErrorRef.current?.(msg.message)
        }
        return
      }
      // Branched rather than assumed, and the two are not the same. Treating "not an error" as a state
      // would make a third `network:*` message — the protocol has two today — silently reposition the
      // control, and `scripts/__tests__/inboundDisposition.test.mjs` will not accept a file that claims
      // to handle a message without comparing against it.
      if (msg.type !== 'network:state') return
      // **The position comes from `offline` whatever `available` says.** A device tapflow can no
      // longer steer still has a network state, and the protocol carries the field on both members
      // for exactly that. What `available` changes is what the button can promise, not where it points.
      //
      // The `reason` is **not read at all**. Every read failure currently arrives as
      // `unsupported-device` (#618), so naming it would tell a tester "this device will never do it"
      // about one that is merely rebooting. Saying less is the only way to say nothing false until
      // that set is split; the value is on the wire for when it is.
      setPosition(msg.payload.offline ? 'offline' : 'online')
      setSteerable(msg.payload.available)
      if (msg.requestId !== undefined && msg.requestId === requestId.current) {
        requestId.current = null
        setPending(false)
      }
    }
    return () => { handlerRef.current = undefined }
  }, [handlerRef, supported])

  // Nothing else produces a `network:state`, so a request the agent never answers would leave this
  // waiting on a report that is not coming. Three silences reach here identically — an agent that
  // does not implement the message, a relay that believes the session is ready while the agent holds
  // no device, and a socket that was not open when the request fired — and `unknown` is the honest
  // rendering of all three. What it must not do is say that *before* the wait is over.
  //
  // Armed when the device becomes ready, which is also when the relay does its asking.
  useEffect(() => {
    if (!supported || !deviceReady || position !== 'waiting') return
    // Functional, and the guard is **not** redundant with the one above. Disarming depends on this
    // effect's cleanup, which runs in React's passive-effect flush — not in the WS handler that just
    // called `setPosition`. A report landing in the milliseconds before that flush would otherwise be
    // applied and then overwritten, which is exactly where the slow-but-legitimate report lands.
    const timer = setTimeout(() => setPosition((p) => (p === 'waiting' ? 'unknown' : p)), NETWORK_REPORT_DEADLINE_MS)
    return () => clearTimeout(timer)
  }, [supported, deviceReady, position])

  /**
   * Ask for the opposite of what is on screen — and from `waiting` or `unknown`, ask to go offline.
   *
   * That default is what keeps the control usable rather than merely visible. A device whose state
   * cannot be read still has one, and the only way to find out is to change it and read the answer.
   * Offline is also the direction a tester came here for.
   */
  const toggle = useCallback(() => {
    if (!supported || pending) return
    const id = newRequestId()
    requestId.current = id
    setPending(true)
    send({ type: 'network:set', sessionId, requestId: id, payload: { offline: position !== 'offline' } })
  }, [position, pending, send, sessionId, supported])

  // **A request can go unanswered, and without this the control never recovers.** `send` drops the
  // frame outright when the socket is not open — no queue, no throw — and an agent that receives it
  // and then dies is answered by nobody, since the relay only produces `network:error` for what *it*
  // could not dispatch. `pending` would then stay true for the life of the session: a spinner that
  // never stops, a button whose every click is swallowed by the guard above, and a live region stuck
  // on "Changing the network state." `useClipboardBridge` arms the same kind of budget per request.
  //
  // Keyed on `requestId.current` through a state mirror so the timer belongs to *this* request; a
  // reply that arrives first clears the id and takes the timer with it.
  const [inFlight, setInFlight] = useState<string | null>(null)
  useEffect(() => { setInFlight(pending ? requestId.current : null) }, [pending])
  useEffect(() => {
    if (inFlight === null) return
    const timer = setTimeout(() => {
      if (requestId.current !== inFlight) return
      requestId.current = null
      setPending(false)
      onErrorRef.current?.('The device did not answer. Its network state is unchanged as far as tapflow can tell.')
    }, NETWORK_REQUEST_DEADLINE_MS)
    return () => clearTimeout(timer)
  }, [inFlight])

  return { position, steerable, pending, toggle }
}
