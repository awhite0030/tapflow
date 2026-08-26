import type { BrowserToRelay, DeviceShutdownDone, DeviceShutdownError } from '@tapflowio/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { newRequestId } from '@/lib/requestId'

/** The two frames that can answer a `device:shutdown`. */
export type RebootMessage = DeviceShutdownDone | DeviceShutdownError

export type RebootMessageHandler = (msg: RebootMessage) => void

interface Options {
  sessionId: string
  deviceId: string
  send: (msg: BrowserToRelay) => void
  /** `DeviceViewer` routes the two shutdown replies here; the hook registers itself on mount. */
  handlerRef: MutableRefObject<RebootMessageHandler | undefined>
  /**
   * The shutdown landed — boot the device.
   *
   * The boot is **not** sent from here. `DeviceViewer` owns the correlator bookkeeping every boot
   * shares (`bootIdsRef`, `latestBootIdRef`), and a second sender that kept its own would be the
   * third copy of that idiom with nothing holding the copies together.
   */
  onShutdownComplete: () => void
  /** Told when the sequence stopped and the device is still up, since nothing else renders that. */
  onError: (message: string) => void
}

/**
 * How long to wait for the shutdown to be answered before giving up on it.
 *
 * **Silence is a reachable answer here, not a hang to be defended against.** Both agents open
 * `handleDeviceShutdown` with `if (!state) return` — no `device:shutdown-done`, no error, nothing —
 * and `IOSAgent`'s own catch logs a failed `simctl shutdown` and sends nothing either. That is
 * deliberate on the protocol's side: `DeviceShutdownError` is declared `RelayToBrowser`, and its doc
 * says both agents "ack a shutdown they cannot perform by simply not sending `device:shutdown-done`".
 * So this deadline is the *only* thing between a failed shutdown and a control that spins forever.
 *
 * 20s because the agent awaits the real shutdown before answering — `simctl shutdown` on a busy Mac,
 * or `adb emu kill` on an emulator mid-write. Generous on purpose: the cost of being early is telling
 * a tester their reboot failed while it is working, and then booting a device that is on its way down.
 */
export const REBOOT_SHUTDOWN_DEADLINE_MS = 20_000

/**
 * Reboot the device the viewer is showing (#628).
 *
 * **The dashboard sequences this rather than the agent**, because `device:boot` on a running device
 * does nothing: the non-erase path issues `simctl boot`, which swallows `Unable to boot device in
 * current state: Booted` on purpose. Only `full-erase` shuts the device down first, and a reboot is
 * not a request to erase (#439). So a reboot is a `device:shutdown` followed by a `device:boot`, both
 * of which this app already sends elsewhere and the relay already answers.
 *
 * What this hook owns is the half that did not exist: the wait between the two. The boot half needs
 * nothing new — `device:booting` unmounts the viewer and `device:ready` brings it back, which is the
 * same thing a first boot does and is why a reboot needs no progress display of its own.
 */
export function useDeviceReboot({ sessionId, deviceId, send, handlerRef, onShutdownComplete, onError }: Options) {
  const [pending, setPending] = useState(false)
  const requestId = useRef<string | null>(null)

  // Read through refs so the handler registered below does not have to be rebuilt — and so the
  // deadline, which fires long after the render that armed it, calls the current one.
  const onCompleteRef = useRef(onShutdownComplete)
  const onErrorRef = useRef(onError)
  useEffect(() => { onCompleteRef.current = onShutdownComplete }, [onShutdownComplete])
  useEffect(() => { onErrorRef.current = onError }, [onError])

  // A new session is a different device. Nothing in flight for the old one can be answered here.
  useEffect(() => {
    setPending(false)
    requestId.current = null
  }, [sessionId])

  useEffect(() => {
    handlerRef.current = (msg) => {
      // **Correlated, and this is the one thing that must not be relaxed.** `useAgentSession` sends
      // three *uncorrelated* `device:shutdown`s on the way out of a view, and this file's header
      // (`lib/inboundDisposition.ts`) says any browser socket can receive any message — a reply to
      // somebody's teardown reaching here uncompared would boot a device that was just shut down on
      // purpose, from a screen the tester has left.
      //
      // One comparison covers the id-less case too, and that is worth saying because the explicit
      // `msg.requestId === undefined ||` that stood here read as load-bearing and was not: this ref
      // holds `string | null`, so an absent correlator is `undefined !== null` and already rejected.
      // Mutation testing is what said so — deleting that clause changed no test.
      if (msg.requestId !== requestId.current) return
      requestId.current = null
      setPending(false)
      if (msg.type === 'device:shutdown-error') {
        // The device is still up: the relay refused to dispatch, so nothing reached it. Said rather
        // than rendered, because the control it came from goes back to looking exactly as it did.
        onErrorRef.current(`The device was not restarted. ${msg.message}`)
        return
      }
      onCompleteRef.current()
    }
    return () => { handlerRef.current = undefined }
  }, [handlerRef])

  // Armed on the id rather than on `pending`, so a second reboot's wait cannot be cleared by the
  // first one's timer — the same shape `useNetworkControl` arrived at for its request deadline.
  const [waitingOn, setWaitingOn] = useState<string | null>(null)
  useEffect(() => { setWaitingOn(pending ? requestId.current : null) }, [pending])
  useEffect(() => {
    if (waitingOn === null) return
    const timer = setTimeout(() => {
      if (requestId.current !== waitingOn) return
      requestId.current = null
      setPending(false)
      onErrorRef.current('The device did not answer the restart. It may still be running — check it before trying again.')
    }, REBOOT_SHUTDOWN_DEADLINE_MS)
    return () => clearTimeout(timer)
  }, [waitingOn])

  const reboot = useCallback(() => {
    if (pending) return
    const id = newRequestId()
    requestId.current = id
    setPending(true)
    send({ type: 'device:shutdown', sessionId, requestId: id, payload: { deviceId } })
  }, [pending, send, sessionId, deviceId])

  return { pending, reboot }
}
