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
  /** Press a chord on the device (usage, modifiers) — the existing input:key path. */
  sendChord: (code: 'KeyC' | 'KeyV', modifiers: number) => void
  onError?: (message: string) => void
}

// Safari drops user activation for execCommand somewhere between 500ms and 1s (measured:
// 500ms works, 1000ms does not — while userActivation.isActive still reads true, so it
// cannot be trusted). Give the round trip a budget well inside that, and stop rather than
// fire a call we know will silently fail.
const ROUND_TRIP_BUDGET_MS = 400
// Give the device a moment to actually put the selection on its clipboard before reading.
const COPY_SETTLE_MS = 60

const META = 0x08
const CTRL = 0x01

/** Write to the user's OS clipboard. Prefers the async API on secure contexts and falls
 *  back to execCommand, which is deprecated but the only path that works on plain-HTTP LAN. */
async function writeToUserClipboard(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* fall through — permission denied or not focused */ }
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

/**
 * Bridges the viewer's Cmd/Ctrl+C and Cmd/Ctrl+V to the device clipboard.
 *
 * Copy cannot be served from the `copy` event: that handler needs its data synchronously
 * and the agent round trip is async, so the chord is intercepted in keydown, the device is
 * asked for its clipboard, and the value is written when it arrives — inside the activation
 * budget above. Paste is easier: the `paste` event hands over the text with no permission
 * or secure-context requirement, so it works on plain HTTP.
 */
export function useClipboardBridge({ sessionId, send, active, handlerRef, sendChord, onError }: Options) {
  const pending = useRef(new Map<string, (msg: ClipboardBridgeMessage) => void>())
  const seq = useRef(0)

  useEffect(() => {
    handlerRef.current = (msg) => {
      if (!msg.requestId) return
      const resolve = pending.current.get(msg.requestId)
      if (!resolve) return          // already timed out — its budget was spent
      pending.current.delete(msg.requestId)
      resolve(msg)
    }
    return () => { handlerRef.current = undefined }
  }, [handlerRef])

  // Resolves with the reply, or null if the budget ran out. A late reply is dropped by the
  // handler above rather than acted on, so a slow agent can never write a stale value.
  const request = useCallback((msg: object): Promise<ClipboardBridgeMessage | null> => {
    const requestId = `clip-${++seq.current}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.current.delete(requestId)
        resolve(null)
      }, ROUND_TRIP_BUDGET_MS)
      pending.current.set(requestId, (reply) => { clearTimeout(timer); resolve(reply) })
      send({ ...msg, sessionId, requestId })
    })
  }, [send, sessionId])

  useEffect(() => {
    if (!active) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'KeyC' || !(e.metaKey || e.ctrlKey) || e.altKey) return
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      e.preventDefault()

      // Press copy on the device first so a live selection lands on its clipboard, then read.
      sendChord('KeyC', e.metaKey ? META : CTRL)
      window.setTimeout(async () => {
        const reply = await request({ type: 'clipboard:read' })
        if (!reply) { onError?.('Device did not answer in time — press Cmd+C again'); return }
        if (reply.type === 'clipboard:error') { onError?.(reply.message ?? 'Clipboard read failed'); return }
        const { text } = (reply.payload ?? {}) as { text?: string }
        if (!text) { onError?.('Nothing was copied on the device'); return }
        if (!(await writeToUserClipboard(text))) {
          onError?.('Copied on the device — press Cmd+C again to put it on your clipboard')
        }
      }, COPY_SETTLE_MS)
    }

    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      const text = e.clipboardData?.getData('text') ?? ''
      e.preventDefault()
      if (!text) return
      request({ type: 'clipboard:write', payload: { text } }).then((reply) => {
        if (reply?.type === 'clipboard:write-done') {
          sendChord('KeyV', META)   // device-side paste; the agent maps meta to its own chord
          return
        }
        // Bridge unavailable (old agent, unsupported backend, timeout): fall back to the
        // plain chord so the device's own clipboard still pastes — never worse than before.
        sendChord('KeyV', META)
        if (reply?.type === 'clipboard:error') onError?.(reply.message ?? 'Clipboard write failed')
      })
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('paste', onPaste)
    }
  }, [active, request, sendChord, onError])
}
