import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RelayMessage } from '@/lib/types'
import type { BrowserToRelay } from '@tapflowio/protocol'

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
const RELAY_URL = import.meta.env.VITE_RELAY_URL ?? `${wsProtocol}//${location.host}`
const RECONNECT_DELAY = 2000

export function useRelay(
  onMessage: (msg: RelayMessage) => void,
  onBinaryFrame?: (data: ArrayBuffer) => void,
) {
  const ws = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  // Latest-callback refs. Written in a layout effect, not during render (lost when a concurrent
  // render is discarded) and not in a passive effect: `useEffect` runs after paint, leaving a gap
  // in which a socket message can still reach the previous callbacks — misrouting a frame right
  // after `sessionId` or `deviceId` changes. A layout effect runs synchronously on commit, so no
  // task can interleave.
  const onMessageRef = useRef(onMessage)
  const onBinaryFrameRef = useRef(onBinaryFrame)
  useLayoutEffect(() => {
    onMessageRef.current = onMessage
    onBinaryFrameRef.current = onBinaryFrame
  }, [onMessage, onBinaryFrame])

  useEffect(() => {
    let cancelled = false

    const connect = () => {
      if (cancelled) return

      const socket = new WebSocket(RELAY_URL)
      socket.binaryType = 'arraybuffer'
      ws.current = socket

      socket.onopen = () => setConnected(true)

      socket.onclose = () => {
        setConnected(false)
        if (!cancelled) setTimeout(connect, RECONNECT_DELAY)
      }

      socket.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          onBinaryFrameRef.current?.(e.data)
          return
        }
        try {
          onMessageRef.current(JSON.parse(e.data))
        } catch { /* ignore malformed */ }
      }
    }

    connect()

    return () => {
      cancelled = true
      ws.current?.close()
    }
  }, [])

  const send = useCallback((msg: BrowserToRelay) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg))
    }
  }, [])

  return { send, connected }
}
