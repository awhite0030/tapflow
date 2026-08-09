'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useRelay } from '@/hooks/useRelay'
import type { BrowserInbound, SessionInfo } from '@/lib/types'
import type { BrowserToRelay } from '@tapflowio/protocol'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface Props {
  onSelect: (sessionId: string, deviceId: string) => void
}

type BootingState = Record<string, 'booting' | 'error'>
type ShuttingState = Record<string, boolean>

export function SessionList({ onSelect }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [booting, setBooting] = useState<BootingState>({})
  const [shutting, setShutting] = useState<ShuttingState>({})
  // The shutdown whose `session:start` has not been answered yet. A ref, not state: the relay's reply
  // lands in a handler that must read the current value, and a re-render is neither needed nor wanted.
  const pendingRef = useRef<{ deviceId: string; sessionId: string } | null>(null)
  // `send` is what `useRelay` returns, so the handler passed *into* it cannot name it directly. Same
  // indirection `DeviceViewer` uses (`sendRef`), for the same reason.
  const sendRef = useRef<(msg: BrowserToRelay) => void>(() => {})

  const { send, connected } = useRelay((msg: BrowserInbound) => {
    if (msg.type === 'agents:listed') {
      setSessions(msg.sessions)
    } else if (msg.type === 'device:ready') {
      const { deviceId } = msg.payload
      setBooting((prev) => {
        const next = { ...prev }
        delete next[deviceId]
        return next
      })
      setSessions((prev) =>
        prev.map((s) => ({
          ...s,
          devices: s.devices.map((d) => (d.id === deviceId ? { ...d, status: 'booted' } : d)),
        }))
      )
    } else if (msg.type === 'device:boot-error') {
      setBooting((prev) => {
        const next: BootingState = {}
        for (const k of Object.keys(prev)) next[k] = 'error'
        return next
      })
    } else if (msg.type === 'device:shutdown-done') {
      const { deviceId } = msg.payload
      setShutting((prev) => {
        const next = { ...prev }
        delete next[deviceId]
        return next
      })
      setSessions((prev) =>
        prev.map((s) => ({
          ...s,
          devices: s.devices.map((d) => (d.id === deviceId ? { ...d, status: 'shutdown' } : d)),
        }))
      )
    } else if (msg.type === 'session:joined') {
      // Only `handleShutdown` sends `session:start` from this list, so a join here means the shutdown it
      // was waiting on may proceed. Sending `device:shutdown` before this arrived was the bug: the relay
      // forwards a session-scoped command on the strength of the session existing, without checking that
      // the sender owns it, so a **refused** join was followed by a shutdown that went through anyway —
      // shutting down a device another tester had open, while this list said it had not.
      const pending = pendingRef.current
      if (pending) {
        pendingRef.current = null
        sendRef.current({ type: 'device:shutdown', sessionId: pending.sessionId, payload: { deviceId: pending.deviceId } })
      }
    } else if (msg.type === 'error') {
      // A refused join. `device:shutdown-done` is the only message that clears `shutting`, so without this
      // the badge stayed on "Shutting down..." for good and `isShutting` hid both buttons — the row went
      // inert. Same defect `DeviceViewer` had for `Session busy`, in a second place.
      //
      // `error` carries no sessionId — by design, since the relay sends it when it cannot correlate — so
      // the device comes from the request this list is waiting on. One is in flight at a time (see
      // `handleShutdown`), which is what makes that unambiguous rather than merely likely.
      const pending = pendingRef.current
      pendingRef.current = null
      if (pending) {
        setShutting((prev) => {
          const next = { ...prev }
          delete next[pending.deviceId]
          return next
        })
      }
      toast.error(
        msg.reason === 'session-busy'
          ? 'That device is open in another browser session — it was not shut down.'
          : 'Could not shut that device down.',
        { description: msg.message },
      )
    }
  })

  useLayoutEffect(() => { sendRef.current = send })

  useEffect(() => {
    if (connected) send({ type: 'agents:list' })
  }, [connected, send])

  const handleBoot = (_session: SessionInfo, deviceId: string, sessionId: string) => {
    onSelect(sessionId, deviceId)
  }

  // One shutdown at a time. `error` carries no sessionId, so a second request in flight would leave the
  // handler unable to say which row a refusal belongs to — and the previous version cleared *every* row
  // on any error, which was a guess dressed as a comment.
  const handleShutdown = (deviceId: string, sessionId: string) => {
    if (pendingRef.current) return
    pendingRef.current = { deviceId, sessionId }
    setShutting((prev) => ({ ...prev, [deviceId]: true }))
    // `session:start` first, and `device:shutdown` only once the relay accepts the join — see the
    // `session:joined` branch above.
    send({ type: 'session:start', sessionId })
  }

  if (!connected) {
    return <p className="text-sm text-muted-foreground">Connecting to relay...</p>
  }

  if (sessions.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">No agents connected.</p>
        <p className="text-sm text-muted-foreground">
          Run:{' '}
          <code className="rounded bg-secondary px-1.5 py-0.5 text-xs">
            npm run dev:ios-agent
          </code>
        </p>
        <Button variant="outline" size="sm" onClick={() => send({ type: 'agents:list' })}>
          Refresh
        </Button>
      </div>
    )
  }

  return (
    <ul className="space-y-3">
      {sessions.flatMap((s) =>
        s.devices.map((d) => {
          const isBooting = booting[d.id] === 'booting'
          const isError = booting[d.id] === 'error'
          const isShutting = shutting[d.id] === true
          const isBusy = d.busy
          const isBooted = d.status === 'booted'

          return (
            <li key={`${d.sessionId}-${d.id}`}>
              <Card>
                <CardContent className="flex items-center gap-4 p-5">
                  <div className="flex-1">
                    <p className="font-semibold">
                      {s.agentName ? `${s.agentName} · ${d.name}` : d.name}
                    </p>
                    <p className="mt-0.5 text-xs capitalize text-muted-foreground">{d.platform}</p>
                  </div>

                  {isBusy && <Badge variant="destructive">In Use</Badge>}
                  {isError && <Badge variant="destructive">Error</Badge>}
                  {isBooting && <Badge variant="secondary">Booting...</Badge>}
                  {isShutting && <Badge variant="secondary">Shutting down...</Badge>}
                  {!isBusy && !isBooting && !isError && !isShutting && (
                    <Badge variant={isBooted ? 'default' : 'secondary'}>{d.status}</Badge>
                  )}

                  {isBooted && !isBusy && !isShutting && (
                    <Button size="sm" onClick={() => onSelect(d.sessionId, d.id)}>
                      Connect
                    </Button>
                  )}
                  {isBooted && !isBusy && !isShutting && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleShutdown(d.id, d.sessionId)}
                    >
                      Shutdown
                    </Button>
                  )}
                  {!isBooted && !isBooting && !isError && !isShutting && (
                    <Button size="sm" variant="outline" onClick={() => handleBoot(s, d.id, d.sessionId)}>
                      Boot
                    </Button>
                  )}
                  {isError && (
                    <Button size="sm" variant="outline" onClick={() => handleBoot(s, d.id, d.sessionId)}>
                      Retry
                    </Button>
                  )}
                </CardContent>
              </Card>
            </li>
          )
        })
      )}
    </ul>
  )
}
