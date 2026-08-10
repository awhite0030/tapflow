import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { BrowserInbound } from '@/lib/types'

// #445: the relay now carries `sessionId` on app failures. A field nobody reads is not a fix — the
// viewer has to act differently on an error that is not its own. Before this, an `app:install-error`
// from any session was applied to whichever viewer was mounted.
const send = vi.fn()
let deliver: ((msg: BrowserInbound) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send, connected: true }
  },
}))
vi.mock('@/hooks/usePerfMode', () => ({ usePerfMode: () => ({ perfMode: false, visible: false }) }))
vi.mock('@/hooks/useAudioPlayback', () => ({ useAudioPlayback: () => ({ pushFrame: vi.fn() }) }))
vi.mock('@/lib/decoders/pickDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decoders/pickDecoder')>()),
  canDecodeH264: () => false,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

describe('DeviceViewer ignores messages addressed to another session (#445)', () => {
  beforeEach(() => {
    send.mockClear()
    deliver = null
  })

  it('does not show an install failure belonging to a different session', () => {
    render(<DeviceViewer sessionId="mine" deviceId="dev-1" />)
    act(() => { deliver!({ type: 'session:joined', sessionId: 'mine', capabilities: [] }) })
    // The card shows "Starting device…" until this arrives, and that would mask the install error
    // regardless of the filter — the two tests have to sit past it to mean anything.
    act(() => { deliver!({ type: 'device:ready', sessionId: 'mine', payload: { deviceId: 'dev-1' } }) })

    act(() => {
      deliver!({ type: 'app:install-error', sessionId: 'someone-else', message: 'Build not found' })
    })

    expect(screen.queryByText(/Install failed/)).not.toBeInTheDocument()
  })

  it('does show one that is its own', () => {
    render(<DeviceViewer sessionId="mine" deviceId="dev-1" />)
    act(() => { deliver!({ type: 'session:joined', sessionId: 'mine', capabilities: [] }) })
    act(() => { deliver!({ type: 'device:ready', sessionId: 'mine', payload: { deviceId: 'dev-1' } }) })

    act(() => {
      deliver!({ type: 'app:install-error', sessionId: 'mine', message: 'Build not found' })
    })

    expect(screen.getByText(/Install failed: Build not found/)).toBeInTheDocument()
  })

  it('ignores a device:ready whose session id is empty', () => {
    // The discriminating case for dropping `&& msg.sessionId` from the gate. An empty sessionId is
    // falsy, so the truthiness check let it *pass* and the message was applied to whichever viewer was
    // mounted — the unattributed-message defect #426 exists to prevent, reachable through the hole that
    // existed to let the relay's unstamped replay in. `''` type-checks against the now-required field
    // and nothing validates inbound messages (#444), so this is a shape that can arrive.
    //
    // A foreign-but-non-empty id is *not* the test for this: `'someone-else'` is truthy, so the old
    // gate rejected it too and such a test would pass either way.
    render(<DeviceViewer sessionId="mine" deviceId="dev-1" />)
    act(() => { deliver!({ type: 'session:joined', sessionId: 'mine', capabilities: [] }) })

    act(() => { deliver!({ type: 'device:ready', sessionId: '', payload: { deviceId: 'dev-1' } }) })

    // Still waiting on its own device — the unattributed ready did not stand in for it.
    expect(screen.getByText(/Starting device/)).toBeInTheDocument()
  })

  it('still accepts messages that carry no session at all', () => {
    // `agents:listed` and friends are not session-scoped; filtering on a missing field would
    // silence them.
    render(<DeviceViewer sessionId="mine" deviceId="dev-1" />)

    act(() => { deliver!({ type: 'session:joined', sessionId: 'mine', capabilities: [] }) })

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'device:boot' }))
  })

  it('accepts a matching session id — the shape the relay actually sends', () => {
    // The relay echoes the id the browser sent (`sessionId: msg.sessionId!`), so the no-field case
    // above is not what arrives in production. This is.
    render(<DeviceViewer sessionId="mine" deviceId="dev-1" />)

    act(() => { deliver!({ type: 'session:joined', sessionId: 'mine', capabilities: [] }) })

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'device:boot' }))
  })

  // A dropped session:terminated is the one loss this filter could cause that nobody would see:
  // the tab sits on "Waiting for first frame…" forever, which is #426 all over again.
  it('still reports a termination for its own session', () => {
    const onSessionEnded = vi.fn()
    render(<DeviceViewer sessionId="mine" deviceId="dev-1" onSessionEnded={onSessionEnded} />)

    act(() => {
      deliver!({ type: 'session:terminated', sessionId: 'mine', reason: 'agent-disconnected' })
    })

    expect(onSessionEnded).toHaveBeenCalledWith('agent-disconnected')
  })

  it('does not report a termination belonging to someone else', () => {
    const onSessionEnded = vi.fn()
    render(<DeviceViewer sessionId="mine" deviceId="dev-1" onSessionEnded={onSessionEnded} />)

    act(() => {
      deliver!({ type: 'session:terminated', sessionId: 'other', reason: 'agent-disconnected' })
    })

    expect(onSessionEnded).not.toHaveBeenCalled()
  })
})
