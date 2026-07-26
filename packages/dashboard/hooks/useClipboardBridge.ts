import { useCallback, useEffect, useRef } from 'react'
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
  /** DeviceViewer routes `clipboard:*` here; the bridge registers itself on mount. */
  handlerRef: MutableRefObject<ClipboardMessageHandler | undefined>
  /** Press a chord on the device via the plain input:key path — the fallback when the bridge fails. */
  sendChord: (code: 'KeyC' | 'KeyV' | 'KeyX', modifiers: number) => void
  onError?: (message: string) => void
}

// Safari drops user activation for execCommand somewhere between 500ms and 1s (measured:
// 500ms works, 1000ms does not — while userActivation.isActive still reads true, so it
// cannot be trusted). Budget the round trip well inside that, and give up rather than fire
// a call we know will silently fail.
const ROUND_TRIP_BUDGET_MS = 400

// The device chord is always the Cmd/meta one regardless of what the viewer pressed: iOS
// only understands Cmd+C, and Android treats meta and ctrl alike. A Windows viewer pressing
// Ctrl+C must still send Cmd+C to the device.
const META = 0x08

/** Write to the user's OS clipboard. Prefers the async API on secure contexts and falls
 *  back to execCommand, which is deprecated but the only path that works on plain-HTTP LAN. */
async function writeToUserClipboard(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* fall through — permission denied or document not focused */ }
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  document.body.removeChild(ta)
  return ok
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

// How long a value captured after a missed budget stays usable on the next press. Long enough
// for "press again", short enough that it cannot be mistaken for a later, different selection.
const STASH_TTL_MS = 10_000

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
 * synchronously while the agent round trip is async — so the chord is intercepted in keydown
 * and the value is written when it comes back, inside the activation budget above.
 *
 * The agent presses the device-side chord, not this hook: only the agent knows when the key
 * actually lands (a visible software keyboard makes it await hideSoftwareKeyboard first), and
 * reading too early returns the previous clipboard — a stale value nobody would notice.
 */
export function useClipboardBridge({ sessionId, send, active, handlerRef, sendChord, onError }: Options) {
  const pending = useRef(new Map<string, (msg: ClipboardBridgeMessage) => void>())
  const lastError = useRef<string | null>(null)
  // Value that arrived after its request's budget expired, kept for the user's next press.
  const stashed = useRef<{ text: string; at: number } | null>(null)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  // Backends without a clipboard channel (Android real devices) answer every single press
  // with the same error; a toast per keypress is noise, so only the first one shows.
  const report = useCallback((message: string) => {
    if (lastError.current === message) return
    lastError.current = message
    onErrorRef.current?.(message)
  }, [])

  const stash = useCallback((text: string) => { stashed.current = { text, at: Date.now() } }, [])
  const takeStash = useCallback((): string | null => {
    const s = stashed.current
    stashed.current = null
    return s && Date.now() - s.at < STASH_TTL_MS ? s.text : null
  }, [])

  useEffect(() => {
    handlerRef.current = (msg) => {
      if (!msg.requestId) return
      const resolve = pending.current.get(msg.requestId)
      if (!resolve) {
        // Its budget already expired, so it cannot be written now (the user activation is
        // gone). Keep it for the next press instead of dropping the work on the floor.
        if (msg.type === 'clipboard:data') {
          const { text } = (msg.payload ?? {}) as { text?: string }
          if (text) stash(text)
        }
        return
      }
      pending.current.delete(msg.requestId)
      resolve(msg)
    }
    return () => { handlerRef.current = undefined }
  }, [handlerRef, stash])

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
    if (!active) return

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

      // A value the device sent after a previous press missed the budget. The user was told to
      // press again, and this is that press — write it while the activation is fresh. Bounded by
      // age so an old capture can never masquerade as the current selection.
      const stashed = takeStash()
      if (stashed !== null) {
        lastError.current = null
        if (!(await writeToUserClipboard(stashed))) report('Your browser blocked the clipboard write')
        return
      }

      const reply = await request('clipboard:read', { press: isCut ? 'cut' : 'copy' })
      if (!reply) {
        // No answer inside the budget. The agent is still working and its late reply will be
        // stashed. Do NOT press the chord here — the agent already pressed it.
        report('Still copying — press again in a moment')
        return
      }
      if (reply.type === 'clipboard:error') {
        report(reply.message ?? 'Clipboard read failed')
        // Bridge unavailable (old agent, backend without a clipboard channel): press the chord
        // so the copy at least lands on the DEVICE's own clipboard, as it did before the bridge.
        sendChord(isCut ? 'KeyX' : 'KeyC', META)
        return
      }
      const { text } = (reply.payload ?? {}) as { text?: string }
      lastError.current = null
      if (!text) return   // an empty device clipboard is a fact, not a failure
      if (!(await writeToUserClipboard(text))) {
        stash(text)
        report('Copied on the device — press again to put it on your clipboard')
      }
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
        // On an explicit error nothing was pasted, so press the chord to at least paste the
        // device's own clipboard. On a TIMEOUT the agent is still mid-write and presses paste
        // itself once it lands — pressing here too would paste twice.
        if (!reply) return
        sendChord('KeyV', META)
        if (reply?.type === 'clipboard:error') report(reply.message ?? 'Clipboard write failed')
      })
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('paste', onPaste)
    }
  }, [active, request, sendChord, report, stash, takeStash])
}
