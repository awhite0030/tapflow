import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'

export interface ClipboardBridgeMessage {
  type: string
  requestId?: string
  payload?: unknown
  message?: string
}

export type ClipboardMessageHandler = (msg: ClipboardBridgeMessage) => void

interface Options {
  sessionId: string
  send: (msg: object) => void
  /** Only hijack the chords while the viewer owns the keyboard. */
  active: boolean
  /** Does the connected agent implement the clipboard protocol (from session:joined)? */
  supported: boolean
  /** DeviceViewer routes `clipboard:*` here; the bridge registers itself on mount. */
  handlerRef: MutableRefObject<ClipboardMessageHandler | undefined>
  /** Press a chord on the device via the plain input:key path — the fallback when the bridge fails. */
  sendChord: (code: 'KeyC' | 'KeyV' | 'KeyX', modifiers: number) => void
  onError?: (message: string) => void
}

// How long to wait for the agent before calling it a fault.
//
// This must exceed the agent's own worst case, or the browser gives up first and replaces the
// agent's specific message ("did not copy anything — is something selected?") with a generic
// one — which is what happened when both numbers were 3000ms by coincidence. Mirrors
// agent-core's CLIPBOARD_AGENT_WORST_MS (1000 + 2000 + 4×300 = 4200); the dashboard has no
// dependency on that package, so the derivation is spelled out here and pinned by a test.
//
// Upper bound: a claimed clipboard write was measured holding for 6s in Chrome and Safari, so
// staying comfortably under that keeps the one-press copy intact.
const AGENT_WORST_MS = 1_000 + 2_000 + 4 * 300
const ROUND_TRIP_BUDGET_MS = AGENT_WORST_MS + 800   // 5s — above the agent, below the 6s claim limit

// The device chord is always the Cmd/meta one regardless of what the viewer pressed: iOS
// only understands Cmd+C, and Android treats meta and ctrl alike. A Windows viewer pressing
// Ctrl+C must still send Cmd+C to the device.
const META = 0x08

/** True when the browser can write the clipboard from a value that arrives later. */
export function canWriteClipboardLate(): boolean {
  return window.isSecureContext && typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write
}

/**
 * Claim the clipboard NOW, fill it when the device answers.
 *
 * `navigator.clipboard.write()` is called synchronously inside the keydown handler, holding a
 * ClipboardItem whose payload is still a pending promise. Both engines honour that: measured on
 * a secure context, the promise may settle 6s later and the write still lands. Compare
 * `writeText` after the fact — Safari rejects it past ~1.5s (NotAllowedError) — and execCommand,
 * which needs the value synchronously and so cannot express this at all.
 *
 * This is what makes a one-press copy possible: the device round trip (~780ms, and it must
 * *prove* the copy landed) no longer has to fit inside a user-activation budget.
 */
/** Cancelling our own claim (nothing to copy, device errored) is not a browser failure. */
class ClaimCancelled extends Error {}

function claimClipboard(pending: Promise<string>): Promise<void> {
  const blob = pending.then((text) => new Blob([text], { type: 'text/plain' }))
  return navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })])
}

// crypto.randomUUID is secure-context only and LAN deployments are plain HTTP, so build the
// id from getRandomValues, which is not. It has to be unguessable: a reply is addressed by
// requestId, and its payload lands on the user's own OS clipboard.
function requestId(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/**
 * Chords the bridge takes over, so the viewers' own keydown handlers can skip exactly these
 * and nothing else — forwarding one twice would double-paste, dropping one would lose it.
 * Copy/cut are handled in keydown; paste rides the `paste` event, which fires regardless of
 * Shift, so KeyV is claimed either way while Cmd+Shift+C is left to the normal key path.
 */
export function isBridgedChord(
  e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return false
  if (e.code === 'KeyV') return true
  return !e.shiftKey && (e.code === 'KeyC' || e.code === 'KeyX')
}

// Payload ceiling, measured in UTF-8 bytes to match the agents (a counted-by-code-unit cap
// would let ~4MB of emoji through a limit that exists to protect the shared video socket).
const MAX_CLIPBOARD_BYTES = 1024 * 1024
const byteLength = (s: string): number => new TextEncoder().encode(s).length

/** True when the agent said this backend has no clipboard channel at all. It can therefore
 *  never have a sentinel parked on the device, which makes pressing the plain chord safe —
 *  the one error where falling back is provably harmless rather than a gamble. */
const isUnsupportedBackend = (msg: ClipboardBridgeMessage): boolean =>
  !!(msg.payload as { unsupported?: boolean } | undefined)?.unsupported

/** Is the user selecting text in the dashboard itself rather than driving the device? */
function hasDocumentSelection(): boolean {
  const sel = window.getSelection()
  return !!sel && !sel.isCollapsed && sel.toString().length > 0
}

function inTextField(): boolean {
  const el = document.activeElement
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)
}

/**
 * Bridges the viewer's copy/cut/paste chords to the device clipboard.
 *
 * Copy cannot be served from the browser's `copy` event — that handler needs its data
 * synchronously while the agent round trip is async. Instead the chord is taken in keydown and
 * the clipboard is *claimed* there (see claimClipboard), then filled once the device answers.
 * That needs a secure context; on plain HTTP the copy stays on the device and we say so.
 *
 * The agent presses the device-side chord, not this hook: only the agent knows when the key
 * actually lands (a visible software keyboard makes it await hideSoftwareKeyboard first), and
 * reading too early returns the previous clipboard — a stale value nobody would notice.
 */
export function useClipboardBridge({ sessionId, send, active, supported, handlerRef, sendChord, onError }: Options) {
  const pending = useRef(new Map<string, (msg: ClipboardBridgeMessage) => void>())
  const lastError = useRef<string | null>(null)
  const onErrorRef = useRef(onError)
  useLayoutEffect(() => { onErrorRef.current = onError })

  // Backends without a clipboard channel (Android real devices) answer every single press
  // with the same error; a toast per keypress is noise, so only the first one shows.
  const report = useCallback((message: string) => {
    if (lastError.current === message) return
    lastError.current = message
    onErrorRef.current?.(message)
  }, [])

  useEffect(() => {
    handlerRef.current = (msg) => {
      if (!msg.requestId) return
      const resolve = pending.current.get(msg.requestId)
      if (!resolve) return    // already settled or abandoned
      pending.current.delete(msg.requestId)
      resolve(msg)
    }
    return () => { handlerRef.current = undefined }
  }, [handlerRef])

  // Resolves with the reply, or null if the budget ran out. A late reply is dropped by the
  // handler above rather than acted on, so a slow agent can never write a stale value.
  const request = useCallback((type: string, payload?: object): Promise<ClipboardBridgeMessage | null> => {
    const id = requestId()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.current.delete(id)
        resolve(null)
      }, ROUND_TRIP_BUDGET_MS)
      pending.current.set(id, (reply) => { clearTimeout(timer); resolve(reply) })
      send({ type, sessionId, requestId: id, payload })
    })
  }, [send, sessionId])

  useEffect(() => {
    // An agent that does not advertise the capability never replies to these messages, so the
    // bridge stays out of the way entirely and the viewers keep forwarding the chords
    // themselves — exactly the behaviour that predates this hook.
    if (!active || !supported) return

    const onKeyDown = async (e: KeyboardEvent) => {
      // KeyV is claimed by isBridgedChord for the viewers' benefit but handled in `paste`.
      if (e.code === 'KeyV' || !isBridgedChord(e)) return
      const isCut = e.code === 'KeyX'
      // Let the browser copy a selection made in the dashboard chrome, and let a focused
      // text field behave normally — neither is an attempt to copy from the device.
      if (inTextField() || hasDocumentSelection()) return
      e.preventDefault()
      // Held keys repeat on Windows/Linux; each repeat would spawn another device round trip.
      if (e.repeat) return

      // Proving a copy landed on the device takes ~780ms, which no plain-HTTP path can bridge:
      // execCommand needs the value synchronously. Say so instead of failing silently, and
      // still press the chord so the copy lands on the DEVICE's own clipboard.
      if (!canWriteClipboardLate()) {
        sendChord(isCut ? 'KeyX' : 'KeyC', META)
        report('Copied on the device. Serving the dashboard over HTTPS also brings it to your clipboard.')
        return
      }

      // Claim the clipboard inside this keydown and let the device fill it. Rejecting the
      // pending promise cancels the claim cleanly — the OS clipboard is left untouched.
      let settle!: (text: string) => void
      let fail!: (e: Error) => void
      const value = new Promise<string>((res, rej) => { settle = res; fail = rej })
      // The claim chain below consumes this, but the bare promise also needs a handler or a
      // cancellation surfaces as an unhandled rejection.
      void value.catch(() => {})
      const claimed = claimClipboard(value).catch((e: unknown) => {
        if (e instanceof ClaimCancelled) return   // we released it on purpose; already reported
        report(e instanceof Error && e.name === 'NotAllowedError'
          ? 'Your browser blocked the clipboard write'
          : 'Could not write to your clipboard')
      })

      const reply = await request('clipboard:read', { press: isCut ? 'cut' : 'copy' })
      if (!reply) {
        fail(new ClaimCancelled('timeout'))
        // Do NOT press the chord here. The agent advertised the capability, so it received the
        // request and pressed the chord itself; pressing again would copy twice — and while a
        // read is in flight the device clipboard may hold that read's sentinel, which a blind
        // paste would then put into the app under test.
        report('The device is taking too long — try again')
        return
      }
      if (reply.type === 'clipboard:error') {
        fail(new ClaimCancelled(reply.message ?? 'read failed'))
        report(reply.message ?? 'Clipboard read failed')
        // The copy still has to happen on the device. Safe here for the same reason as paste
        // below: an errored read never leaves a sentinel behind.
        sendChord(isCut ? 'KeyX' : 'KeyC', META)
        return
      }
      const { text } = (reply.payload ?? {}) as { text?: string }
      lastError.current = null
      // An empty device clipboard is a fact, not a failure — but do not overwrite the user's
      // clipboard with nothing.
      if (!text) { fail(new ClaimCancelled('empty')); return }
      settle(text)
      await claimed
    }

    const onPaste = (e: ClipboardEvent) => {
      if (inTextField()) return
      const text = e.clipboardData?.getData('text') ?? ''
      e.preventDefault()
      // No text to send (an image or file is on the clipboard, or it is empty): fall back to
      // the plain chord so the DEVICE's own clipboard still pastes, as it did before this hook.
      if (!text) { sendChord('KeyV', META); return }
      if (byteLength(text) > MAX_CLIPBOARD_BYTES) { report('That text is too large to send to the device'); return }
      request('clipboard:write', { text, pasteAfter: true }).then((reply) => {
        if (reply?.type === 'clipboard:write-done') { lastError.current = null; return }
        // Only an explicit error means nothing was written and nothing was pressed; then the
        // plain chord at least pastes the device's own clipboard. A timeout means the agent is
        // still mid-write and will press paste itself — doing it here too pastes twice.
        if (!reply) { report('The device is taking too long — try again'); return }
        report(reply.message ?? 'Clipboard write failed')
        // Normally we do NOT press here: the chord goes through input:key, bypassing the agent's
        // per-device queue, and a concurrent read may have its sentinel parked on the device —
        // which the chord would paste into the app. That risk cannot exist on a backend with no
        // clipboard channel, and without this the shortcut would do nothing at all there.
        if (isUnsupportedBackend(reply)) sendChord('KeyV', META)
      })
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('paste', onPaste)
    }
  }, [active, supported, request, sendChord, report])
}
