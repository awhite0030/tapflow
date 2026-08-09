import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { BrowserInbound, SessionInfo } from '@/lib/types'

// Regression: a refused shutdown left the row inert for the rest of the page's life.
//
// `handleShutdown` sends `session:start` on this socket before `device:shutdown`, because the relay
// routes agent replies to whichever socket holds the session. If that join is refused — the device is
// open in another browser session, the commonest reason to be shutting it down from here — the relay
// answers `error` on this socket and returns. `device:shutdown-done` is the only message that clears
// `shutting`, and it never comes.
//
// The badge then reads "Shutting down..." forever, and `isShutting` hides both Connect and Shutdown, so
// the tester cannot retry or leave. It is the same defect `DeviceViewer` had for `Session busy`, in a
// second component — and the disposition table's first version *hid* it by claiming `error` was handled
// here, which the check certified because three unrelated `'error'` strings live in this file.
const send = vi.fn()
let deliver: ((msg: BrowserInbound) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send, connected: true }
  },
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

const { SessionList } = await import('@/components/SessionList')

const SESSIONS: SessionInfo[] = [{
  agentName: 'mac-1',
  devices: [{
    id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'booted',
    sessionId: 's1', busy: false,
  }],
}]

const TWO_DEVICES: SessionInfo[] = [{
  agentName: 'mac-1',
  devices: [
    { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'booted', sessionId: 's1', busy: false },
    { id: 'dev-2', name: 'iPhone 14', platform: 'ios', status: 'booted', sessionId: 's2', busy: false },
  ],
}]

describe('SessionList when a shutdown is refused', () => {
  beforeEach(() => { send.mockClear(); deliver = null })

  it('clears the shutting badge and says why, instead of leaving the row inert', async () => {
    const { toast } = await import('sonner')
    render(<SessionList onSelect={vi.fn()} />)
    act(() => { deliver!({ type: 'agents:listed', sessions: SESSIONS }) })

    act(() => { screen.getByRole('button', { name: /shutdown/i }).click() })
    expect(screen.getByText(/shutting down/i)).toBeInTheDocument()

    act(() => {
      deliver!({ type: 'error', message: 'Session busy', reason: 'session-busy' })
    })

    // The badge is gone, so the row's buttons are back and the tester can act.
    expect(screen.queryByText(/shutting down/i)).not.toBeInTheDocument()
    expect(vi.mocked(toast.error)).toHaveBeenCalledOnce()
    // And it says which of the three reasons it was, rather than a generic failure.
    expect(vi.mocked(toast.error).mock.calls[0][0]).toMatch(/another browser session/i)
  })

  // The toast above says the device was not shut down. That has to be *true*.
  //
  // The relay forwards a session-scoped browser command on the strength of the session existing — it does
  // not check that the sender owns it. So sending `device:shutdown` in the same breath as `session:start`
  // meant a refused join was followed by a shutdown that went through anyway: another tester's device went
  // down while this list reported that nothing had happened.
  it('does not send the shutdown when the join was refused', () => {
    render(<SessionList onSelect={vi.fn()} />)
    act(() => { deliver!({ type: 'agents:listed', sessions: SESSIONS }) })

    act(() => { screen.getByRole('button', { name: /shutdown/i }).click() })
    expect(send.mock.calls.map(([m]) => m.type)).toEqual(['agents:list', 'session:start'])

    act(() => { deliver!({ type: 'error', message: 'Session busy', reason: 'session-busy' }) })

    expect(send.mock.calls.some(([m]) => m.type === 'device:shutdown')).toBe(false)
  })

  it('sends the shutdown once the join is accepted', () => {
    render(<SessionList onSelect={vi.fn()} />)
    act(() => { deliver!({ type: 'agents:listed', sessions: SESSIONS }) })
    act(() => { screen.getByRole('button', { name: /shutdown/i }).click() })

    act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })

    expect(send.mock.calls.some(([m]) => m.type === 'device:shutdown' && m.sessionId === 's1')).toBe(true)
  })

  it('refuses a second shutdown while one is still unanswered', () => {
    // `error` carries no sessionId, so two in flight would leave the handler unable to say which row a
    // refusal belongs to. The previous version cleared every row instead, which was a guess.
    render(<SessionList onSelect={vi.fn()} />)
    act(() => { deliver!({ type: 'agents:listed', sessions: TWO_DEVICES }) })

    const buttons = screen.getAllByRole('button', { name: /shutdown/i })
    act(() => { buttons[0].click() })
    act(() => { buttons[1].click() })

    expect(send.mock.calls.filter(([m]) => m.type === 'session:start')).toHaveLength(1)
  })
})
