import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { RelayMessage } from '@/lib/types'

// #445: the relay now carries `sessionId` on app failures. A field nobody reads is not a fix — the
// viewer has to act differently on an error that is not its own. Before this, an `app:install-error`
// from any session was applied to whichever viewer was mounted.
const send = vi.fn()
let deliver: ((msg: RelayMessage) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: RelayMessage) => void) => {
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
    act(() => { deliver!({ type: 'session:joined' } as RelayMessage) })
    // The card shows "Starting device…" until this arrives, and that would mask the install error
    // regardless of the filter — the two tests have to sit past it to mean anything.
    act(() => { deliver!({ type: 'device:ready', payload: { deviceId: 'dev-1' } } as RelayMessage) })

    act(() => {
      deliver!({ type: 'app:install-error', sessionId: 'someone-else', message: 'Build not found' } as RelayMessage)
    })

    expect(screen.queryByText(/Install failed/)).not.toBeInTheDocument()
  })

  it('does show one that is its own', () => {
    render(<DeviceViewer sessionId="mine" deviceId="dev-1" />)
    act(() => { deliver!({ type: 'session:joined' } as RelayMessage) })
    act(() => { deliver!({ type: 'device:ready', payload: { deviceId: 'dev-1' } } as RelayMessage) })

    act(() => {
      deliver!({ type: 'app:install-error', sessionId: 'mine', message: 'Build not found' } as RelayMessage)
    })

    expect(screen.getByText(/Install failed: Build not found/)).toBeInTheDocument()
  })

  it('still accepts messages that carry no session at all', () => {
    // `agents:listed` and friends are not session-scoped; filtering on a missing field would
    // silence them. `session:joined` reaching the boot handler is the observable proof.
    render(<DeviceViewer sessionId="mine" deviceId="dev-1" />)

    act(() => { deliver!({ type: 'session:joined' } as RelayMessage) })

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'device:boot' }))
  })
})
