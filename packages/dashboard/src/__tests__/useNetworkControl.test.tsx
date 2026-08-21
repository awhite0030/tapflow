import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { NetworkStatePayload } from '@tapflowio/protocol'
import {
  useNetworkControl, NETWORK_REPORT_DEADLINE_MS,
  type NetworkMessage, type NetworkMessageHandler,
} from '@/hooks/useNetworkControl'

type Sent = { type: string; requestId?: string; sessionId?: string; payload?: { offline: boolean } }

function setup(opts: { supported?: boolean; deviceReady?: boolean; sessionId?: string } = {}) {
  const sent: Sent[] = []
  const errors: string[] = []
  const handlerRef = { current: undefined as NetworkMessageHandler | undefined }

  const view = renderHook(
    (props: { sessionId: string; deviceReady: boolean }) => useNetworkControl({
      sessionId: props.sessionId,
      send: (m) => sent.push(m as Sent),
      supported: opts.supported ?? true,
      deviceReady: props.deviceReady,
      handlerRef,
      onError: (m) => errors.push(m),
    }),
    { initialProps: { sessionId: opts.sessionId ?? 's1', deviceReady: opts.deviceReady ?? true } },
  )

  /** A report the agent sends unasked — no correlator, which is what makes it a report. */
  const report = (payload: NetworkStatePayload, sessionId = 's1') =>
    act(() => { handlerRef.current?.({ type: 'network:state', sessionId, payload } as NetworkMessage) })

  /** The answer to the most recent request this hook sent. */
  const answer = (payload: NetworkStatePayload) => {
    const req = [...sent].reverse().find((s) => s.type === 'network:set')
    act(() => {
      handlerRef.current?.({
        type: 'network:state', sessionId: 's1', requestId: req?.requestId, payload,
      } as NetworkMessage)
    })
  }

  const fail = (message = 'No booted device') => {
    const req = [...sent].reverse().find((s) => s.type === 'network:set')
    act(() => {
      handlerRef.current?.({
        type: 'network:error', sessionId: 's1', requestId: req?.requestId ?? 'none', message,
      } as NetworkMessage)
    })
  }

  return { sent, errors, handlerRef, view, report, answer, fail }
}

const steerable = (offline: boolean): NetworkStatePayload => ({ offline, available: true })
const unsteerable = (offline: boolean): NetworkStatePayload =>
  ({ offline, available: false, reason: 'unsupported-device' })

describe('useNetworkControl', () => {
  afterEach(() => { vi.useRealTimers() })

  it('registers itself only when the agent says it can do this', () => {
    // The control the capability gate needs. Without it the assertions below pass on a hook that
    // registers unconditionally, and `DeviceViewer` would then route a frame into a viewer whose
    // agent never produces one.
    //
    // Mutation: dropping the `if (!supported) return` guard leaves a handler here.
    const { handlerRef } = setup({ supported: false })
    expect(handlerRef.current).toBe(undefined)
  })

  it('registers when it can', () => {
    const { handlerRef } = setup()
    expect(handlerRef.current).toBeTypeOf('function')
  })

  it('starts out waiting, which is not a position', () => {
    const { view } = setup()
    expect(view.result.current.position).toBe('waiting')
  })

  it('takes the position the report gives it', () => {
    const { view, report } = setup()
    report(steerable(true))
    expect(view.result.current.position).toBe('offline')
    report(steerable(false))
    expect(view.result.current.position).toBe('online')
  })

  it('renders a state it cannot steer as unknown rather than as a position', () => {
    // `available: false` is not "online". A device taken offline and then lost is still offline, and
    // drawing it in the online position is the failure the whole feature exists to prevent — the same
    // one the agent shipped on the other side of this wire and a review caught.
    const { view, report } = setup()
    report(unsteerable(true))
    expect(view.result.current.position).toBe('unknown')
  })

  it('renders the same way whatever reason it is given', () => {
    // **The control for #618.** Every read failure currently arrives as `unsupported-device`, so a
    // rendering that varied by reason would be varying by a value that carries no information yet —
    // and would tell a tester "this device will never do it" about one that is rebooting.
    //
    // Mutation: branching on `reason` anywhere in the hook fails here.
    const { view, report } = setup()
    report(unsteerable(false))
    const first = view.result.current.position
    report({ offline: false, available: false, reason: 'not-armed' })
    expect(view.result.current.position).toBe(first)
    report({ offline: false, available: false, reason: 'hooks-not-installed' })
    expect(view.result.current.position).toBe(first)
  })

  it('does not move the toggle when the click is sent', () => {
    // **No optimistic render.** The position is what the device last said, and a click is a request,
    // not an answer — a device that refuses or fails to change would otherwise be drawn where the
    // tester asked it to be rather than where it is.
    //
    // Mutation: a `setPosition` in `toggle` fails here.
    const { view, sent } = setup()
    act(() => { view.result.current.toggle() })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'network:set', sessionId: 's1', payload: { offline: true } })
    expect(view.result.current.position).toBe('waiting')
    expect(view.result.current.pending).toBe(true)
  })

  it('moves only once the answer arrives, and stops waiting', () => {
    const { view, answer } = setup()
    act(() => { view.result.current.toggle() })
    answer(steerable(true))

    expect(view.result.current.position).toBe('offline')
    expect(view.result.current.pending).toBe(false)
  })

  it('asks for the opposite of where the device is', () => {
    const { view, sent, report } = setup()
    report(steerable(true))
    act(() => { view.result.current.toggle() })
    expect(sent.at(-1)).toMatchObject({ payload: { offline: false } })
  })

  it('asks to go offline when it does not know where the device is', () => {
    // What keeps the control usable rather than merely visible: a click is the only thing that
    // produces a fresh `network:state`, so an unreadable state has exactly one way out.
    const { view, sent, report } = setup()
    report(unsteerable(false))
    act(() => { view.result.current.toggle() })
    expect(sent.at(-1)).toMatchObject({ payload: { offline: true } })
  })

  it('clears the wait on an error without claiming the device moved', () => {
    // `network:error` says the request never reached a device — so it says nothing about where that
    // device is, and the position must survive it untouched.
    const { view, report, fail } = setup()
    report(steerable(true))
    act(() => { view.result.current.toggle() })
    fail()

    expect(view.result.current.pending).toBe(false)
    expect(view.result.current.position).toBe('offline')
  })

  it('says so when the request could not be dispatched', () => {
    // Nothing renders a `network:error` otherwise: the position is unchanged, the spinner stops, and a
    // click that changes nothing is indistinguishable from a dead button. `toast.error` renders with
    // `role="alert"`, so this is also the only thing a screen reader hears.
    //
    // Mutation: dropping the `onError` call leaves this empty.
    const { view, errors, fail } = setup()
    act(() => { view.result.current.toggle() })
    fail('No booted device — boot one before changing its network.')
    expect(errors).toEqual(['No booted device — boot one before changing its network.'])
  })

  it('says nothing about an error meant for somebody else', () => {
    // The correlator gate applies to the toast too, or a stale failure from a request this control
    // already replaced would surface as a fresh one.
    const { view, errors, handlerRef } = setup()
    act(() => { view.result.current.toggle() })
    act(() => {
      handlerRef.current?.({
        type: 'network:error', sessionId: 's1', requestId: 'someone-else', message: 'not mine',
      } as NetworkMessage)
    })
    expect(errors).toEqual([])
    expect(view.result.current.pending).toBe(true)
  })

  it('ignores an answer correlated to a request it did not make', () => {
    const { view, handlerRef } = setup()
    act(() => { view.result.current.toggle() })
    act(() => {
      handlerRef.current?.({
        type: 'network:state', sessionId: 's1', requestId: 'someone-else', payload: steerable(true),
      } as NetworkMessage)
    })
    // The state still applies — it is the device's, whoever asked — but the wait is not this one's
    // to clear, or a slow reply would arrive to a control that had already re-armed.
    expect(view.result.current.position).toBe('offline')
    expect(view.result.current.pending).toBe(true)
  })

  it('settles on unknown when no report arrives before the deadline', () => {
    vi.useFakeTimers()
    const { view } = setup()
    expect(view.result.current.position).toBe('waiting')

    act(() => { vi.advanceTimersByTime(NETWORK_REPORT_DEADLINE_MS + 1) })
    expect(view.result.current.position).toBe('unknown')
  })

  it('does not settle when a report arrives in time', () => {
    // **The control for the deadline.** Without it the assertion above passes on a hook that settles
    // on `unknown` unconditionally, which would overwrite a device that had just answered.
    //
    // Mutation: removing the `clearTimeout` teardown, or the `position !== 'waiting'` guard, fails here.
    vi.useFakeTimers()
    const { view, report } = setup()
    act(() => { vi.advanceTimersByTime(NETWORK_REPORT_DEADLINE_MS - 50) })
    report(steerable(false))
    act(() => { vi.advanceTimersByTime(NETWORK_REPORT_DEADLINE_MS) })

    expect(view.result.current.position).toBe('online')
  })

  it('does not arm the deadline before the device is ready', () => {
    // A session with no device has nothing to report, so calling its silence unreadable would be a
    // verdict on a question nobody asked.
    vi.useFakeTimers()
    const { view } = setup({ deviceReady: false })
    act(() => { vi.advanceTimersByTime(NETWORK_REPORT_DEADLINE_MS * 3) })
    expect(view.result.current.position).toBe('waiting')

    view.rerender({ sessionId: 's1', deviceReady: true })
    act(() => { vi.advanceTimersByTime(NETWORK_REPORT_DEADLINE_MS + 1) })
    expect(view.result.current.position).toBe('unknown')
  })

  it('forgets the previous device when the session changes', () => {
    // `DeviceViewer` stays mounted across a session switch and drops frames addressed elsewhere, so
    // nothing would replace this — the last device's position would sit on screen describing another.
    const { view, report } = setup()
    report(steerable(true))
    expect(view.result.current.position).toBe('offline')

    view.rerender({ sessionId: 's2', deviceReady: true })
    expect(view.result.current.position).toBe('waiting')
  })
})
