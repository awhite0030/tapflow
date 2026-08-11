import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { DeviceBoot, BrowserToRelay } from '@tapflowio/protocol'
import type { BrowserInbound } from '@/lib/types'

// L5b′. The viewer mints a correlator for every `device:boot` it sends, and then treats the three
// lifecycle replies **differently from each other** — which is the whole content of this file.
//
// `device:ready` is correlated, but with a fallback and only past the first line: an absent correlator
// is accepted, because the relay replays a cached ready to a re-joining viewer and that replay is what
// clears "Starting device…" (#440). `device:boot-error` is not correlated at all, because Android sends
// it for a stream that died mid-session with no boot behind it, and this viewer is the only surface
// that reports it. Getting either of those the other way round reinstates a defect that has already
// shipped: a tab stuck on "Starting device…", or a picture that has simply stopped updating (#426).
const send = vi.fn<(msg: BrowserToRelay) => void>()
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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

const boots = () =>
  send.mock.calls.map(([m]) => m).filter((m): m is DeviceBoot => m.type === 'device:boot')

const installs = () => send.mock.calls.filter(([m]) => m.type === 'app:install')

/** The correlator on the most recent boot. Read back rather than invented — a made-up id would only
 *  prove the gate rejects made-up ids, which is a different claim. */
const lastBootId = (): string => {
  const id = boots().at(-1)?.requestId
  expect(id, 'the viewer sent a device:boot with no correlator').toBeTruthy()
  return id!
}

const join = () => act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })

describe('DeviceViewer correlates the lifecycle replies, selectively', () => {
  beforeEach(() => { send.mockClear(); deliver = null })

  it('mints a correlator on the boot it sends after joining', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()

    expect(boots()).toHaveLength(1)
    expect(typeof boots()[0]!.requestId).toBe('string')
    expect(boots()[0]!.requestId).not.toBe('')
  })

  it('mints a distinct correlator on the re-boot after an agent restart', () => {
    // The two boots are different requests and a rebind can leave the first still in flight, so
    // sharing one id would make the second's reply satisfy the first's record.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()
    act(() => { deliver!({ type: 'session:rebound', sessionId: 's1', capabilities: [] }) })

    const ids = boots().map((b) => b.requestId)
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('clears "Starting device…" on a replayed ready that carries no session and no correlator', () => {
    // The relay's replay frame is `{ type, payload }` — no `sessionId`, no `requestId`. This is the
    // defect the replay exists to prevent (#440), so gating the spinner on the correlator would put it
    // straight back, and nothing else in the product would report it.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()
    expect(screen.getByText('Starting device…')).toBeTruthy()

    act(() => { deliver!({ type: 'device:ready', payload: { deviceId: 'dev-1' } }) })

    expect(screen.queryByText('Starting device…')).toBeNull()
  })

  it('reports an uncorrelated boot-error, because that is the only kind Android sends unsolicited', () => {
    // `AndroidAgent.restartVideoStream` sends this for a stream that died mid-session. There is no
    // `device:boot` behind it, so it can never carry an id — and this branch is the only surface that
    // reports it. Gate it on `bootIdsRef` and a dead stream becomes a picture that has stopped
    // updating with nothing said, which is what #426 was opened about.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()

    act(() => { deliver!({ type: 'device:boot-error', sessionId: 's1', message: 'scrcpy failed to restart' }) })

    expect(screen.getByText(/Boot failed: scrcpy failed to restart/)).toBeTruthy()
  })

  it('reports a boot-error whose correlator matches nothing this viewer sent', () => {
    // The same prohibition stated so that it fails under a *correlating* gate rather than only under a
    // presence check: a gate keyed on `bootIdsRef` would drop this and the case above alike.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()

    act(() => {
      deliver!({ type: 'device:boot-error', sessionId: 's1', requestId: 'not-ours', message: 'agent offline' })
    })

    expect(screen.getByText(/Boot failed: agent offline/)).toBeTruthy()
  })

  it('acts on a ready that answers its own boot', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    join()

    act(() => {
      deliver!({ type: 'device:ready', sessionId: 's1', requestId: lastBootId(), payload: { deviceId: 'dev-1' } })
    })

    expect(installs()).toHaveLength(1)
  })

  it('installs after the agent\'s real boot sequence — booting, then the correlated ready', () => {
    // **The production ordering, which no other test here exercises.** Both agents send `device:booting`
    // before the `device:ready` that answers the same boot (`IOSAgent.ts:560` → `:639`,
    // `AndroidAgent.ts:863` → `:916`), so the boot id has to survive that message. Adding
    // `bootIdsRef.current.clear()` to that branch — which the comment above it invites, since it is where
    // every other per-cycle record is dropped — rejects every real ready. And the failure is silent:
    // `setDeviceReady(true)` runs ahead of the gate, so the spinner clears and the device looks healthy
    // while the app is never installed and the Launch control never appears.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    join()
    const id = lastBootId()

    act(() => { deliver!({ type: 'device:booting', sessionId: 's1' }) })
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', requestId: id, payload: { deviceId: 'dev-1' } }) })

    expect(installs()).toHaveLength(1)
  })

  it('releases the rebind on the re-boot\'s own reply', () => {
    // The sibling test compares the two minted ids by reading `send`, so it cannot see whether the second
    // was ever *recorded*. Drop `bootIdsRef.current.add(rebootId)` and every assertion there still passes
    // while #426's recovery stops working: the new agent's ready is rejected as a straggler,
    // `rebindRef.pending` never falls, and the viewer keeps the picture but loses its controls.
    //
    // Staged as a rebind landing mid-install, so `appInstalled` is false and the reply falls through to a
    // reinstall — an observable second `app:install` rather than a flag with no surface here.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    join()
    act(() => {
      deliver!({ type: 'device:ready', sessionId: 's1', requestId: lastBootId(), payload: { deviceId: 'dev-1' } })
    })
    expect(installs()).toHaveLength(1)

    act(() => { deliver!({ type: 'session:rebound', sessionId: 's1', capabilities: [] }) })
    act(() => {
      deliver!({ type: 'device:ready', sessionId: 's1', requestId: lastBootId(), payload: { deviceId: 'dev-1' } })
    })

    expect(installs()).toHaveLength(2)
  })

  it('stops accepting an earlier cycle\'s ready once a new join has started one', () => {
    // `session:joined` arrives again on every socket reconnect, and it clears the set for the same reason
    // it resets `rebindRef`: a boot from the cycle that just ended will never be answered now. Without
    // the clear, that cycle's straggling ready passes the gate after the new join and fires a second
    // `app:install` on top of one already in flight.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    join()
    const stale = lastBootId()

    join() // a reconnect: same mount, new cycle, new boot
    expect(lastBootId()).not.toBe(stale)

    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', requestId: stale, payload: { deviceId: 'dev-1' } }) })

    expect(installs()).toHaveLength(0)
  })

  it('ignores a ready carrying a correlator from some other boot', () => {
    // A straggler from an earlier boot cycle: without this it releases the current rebind and installs
    // on top of an install already in flight. Only a *mismatched* id is rejected — absent is still
    // accepted (the test below), so the relay's replayed ready is **not** covered by this and the
    // duplicate-install-on-re-join case the `device:booting` comment describes is unchanged.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    join()

    act(() => {
      deliver!({ type: 'device:ready', sessionId: 's1', requestId: 'stale-cycle', payload: { deviceId: 'dev-1' } })
    })

    expect(installs()).toHaveLength(0)
    // The spinner still clears: that line sits ahead of the correlator on purpose, so a stale ready is
    // ignored without leaving the tester staring at a device that is in fact up.
    expect(screen.queryByText('Starting device…')).toBeNull()
  })

  it('accepts a ready with no correlator at all, so an agent predating the echo still works', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    join()

    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' } }) })

    expect(installs()).toHaveLength(1)
  })

  it('answers only once when the same boot is answered twice', () => {
    // The correlator is consumed by the reply that matches it — `delete`, not `has` — so a duplicate
    // carrying the same id is rejected by the second lookup. Distinct from the replay case: that one is
    // id-less and still gets through, which the two tests above this one hold in place.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    join()
    const id = lastBootId()

    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', requestId: id, payload: { deviceId: 'dev-1' } }) })
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', requestId: id, payload: { deviceId: 'dev-1' } }) })

    expect(installs()).toHaveLength(1)
  })
})
