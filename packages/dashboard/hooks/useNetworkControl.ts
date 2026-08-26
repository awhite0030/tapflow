import type { BrowserToRelay, NetworkError, NetworkState, NetworkUnavailableReason } from '@tapflowio/protocol'
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
  /** Told when something needs saying out loud rather than only rendering: a request that could not
   *  be dispatched, or enforcement that stopped underneath a device that was offline. Nothing renders
   *  a `network:error` otherwise, and a click that changes neither the toggle nor anything else is
   *  indistinguishable from a dead button. */
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
  // **The whole reason now, where this used to keep only `awaiting-app`.** That narrowing was not
  // caution about consumers, it was caution about the *set*: every Android read failure arrived as
  // `unsupported-device` (#618), so naming one told a tester "this will never work" about a device
  // that was rebooting. The set has been split — a failure that could be transient is
  // `state-unconfirmed`, and `unsupported-device` now means the device was read and had not moved —
  // so each member says something a consumer can act on differently, which is what the type is for.
  const [reason, setReason] = useState<NetworkUnavailableReason | undefined>(undefined)
  // What was last said, so an unsolicited report does not announce the same loss twice — a re-join
  // asks for the state again, and the answer still carries the reason.
  const lastReason = useRef<NetworkUnavailableReason | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const requestId = useRef<string | null>(null)
  // Read through a ref so a caller passing an inline closure does not re-register the handler on
  // every render — the same shape `useClipboardBridge` uses for its own `onError`.
  const onErrorRef = useRef(onError)
  useEffect(() => { onErrorRef.current = onError }, [onError])

  /** Read by the handler, which is registered once — the flag itself would be captured stale. */
  const readyRef = useRef(deviceReady)
  useEffect(() => { readyRef.current = deviceReady }, [deviceReady])

  // A new session knows nothing about its device, and the previous session's answer is about somebody
  // else's. `DeviceViewer` drops frames addressed elsewhere, but it stays mounted across the switch,
  // so without this the old position would sit on screen until a new report replaced it.
  useEffect(() => {
    setPosition('waiting')
    setSteerable(true)
    setReason(undefined)
    lastReason.current = undefined
    setPending(false)
    requestId.current = null
  }, [sessionId])

  /**
   * **A device that is not ready knows nothing about its own network, so neither does this.**
   *
   * The reset above keys on `sessionId`, which does not change across a reboot — but `deviceReady`
   * does: `DeviceViewer` drops it on `device:booting` and on agent-away, and raises it again on
   * `device:ready`. The position used to survive all of that, and the report deadline never re-armed
   * because it is gated on `position === 'waiting'`.
   *
   * So an Android emulator restarting showed the position from before it for the 30–60s the boot
   * takes — and worse than merely stale, because the agent's boot path clears airplane mode and
   * reports online. An amber "offline" sat over a device being reset to the opposite, and nothing
   * ever corrected it: the same silence that yields `unknown` before the first boot left the stale
   * answer in place after the second, permanently.
   *
   * Clearing on the way *down* rather than on the way up: the moment the device stops being ready is
   * the moment this stops knowing, and waiting until it returns would leave the false answer on
   * screen for the whole boot.
   */
  useEffect(() => {
    if (deviceReady) return
    setPosition('waiting')
    setReason(undefined)
    lastReason.current = undefined
    // An in-flight request cannot be answered by a device that is rebooting, and leaving `pending`
    // set would disable the control for as long as the boot takes.
    //
    // **And it is said out loud, because this is the one ending that was silent.** Every other
    // terminal path for a click announces itself — a dispatch failure through `network:error`, an
    // unanswered request through the deadline below — while this one cleared the wait and, once the
    // late answer started being dropped, took away even the repositioning that used to stand in for
    // an outcome. A screen-reader user heard the busy state and then nothing at all.
    if (requestId.current) {
      onErrorRef.current?.('The device restarted before it answered. Its network state is unchanged as far as tapflow can tell.')
    }
    setPending(false)
    requestId.current = null
  }, [deviceReady])

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
      // **A device that is not ready has nothing true to say about its network, including in an
      // answer that was already on its way.**
      //
      // The reset above clears the position and the in-flight request when readiness drops, but the
      // answer to that request can still arrive — and a `network:state` was applied whatever it was
      // correlated to. It would put the pre-reboot position back, and because the report deadline is
      // gated on `position === 'waiting'` it would also stop the wait from ever resolving to
      // `unknown`: exactly the stale answer this hook was changed to end, restored by the change
      // itself. The relay's own `network:request-state` on `session:joined` reaches here the same way,
      // racing the boot it arrives with.
      if (!readyRef.current) return
      // **The position comes from `offline` whatever `available` says.** A device tapflow can no
      // longer steer still has a network state, and the protocol carries the field on both members
      // for exactly that. What `available` changes is what the button can promise, not where it points.
      //
      // **The reason is passed through whole**, where this used to keep `awaiting-app` and drop the
      // rest. What made dropping them right was a set that conflated — see `reason` above — and what
      // makes passing them on right is that it no longer does. The rendering decisions stay in the
      // component, which is where the sentences are.
      const next = msg.payload.available ? undefined : msg.payload.reason
      setPosition(msg.payload.offline ? 'offline' : 'online')
      setSteerable(msg.payload.available)
      setReason(next)
      // **The one reason that has to interrupt rather than re-colour.** It says a device that was
      // offline stopped being enforced, so requests a tester believed were blocked had been
      // succeeding — a finished test, invalidated. Everything else here changes what the control
      // looks like; this changes what the tester has to do about work already done.
      //
      // Only on the way in. A re-join asks for the state again and the answer still carries it, and
      // announcing the same loss on every re-join would train people to dismiss it.
      if (next === 'enforcement-lost' && lastReason.current !== 'enforcement-lost') {
        onErrorRef.current?.('The device went back on the network before you took it off. Anything checked while it was offline needs checking again.')
      }
      lastReason.current = next
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

  return { position, steerable, reason, pending, toggle }
}
