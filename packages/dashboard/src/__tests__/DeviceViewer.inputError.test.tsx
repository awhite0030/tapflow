import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import type { InputErrorReason } from '@tapflowio/protocol'
import type { RelayMessage } from '@/lib/types'
import { INPUT_ERROR_NOTICE } from '@/lib/inputErrorNotice'

// #485. The relay forwards `input:done` / `input:error` to the browser and the dashboard used to drop
// both. After #482/#484/#488 the agents tell the truth about a dropped input, and the truth was being
// thrown away before it reached a human.
//
// There is no session-level state behind this on purpose — a latch was designed, reviewed and
// discarded (see the plan). Two of the tests below are regression guards for that decision rather
// than for the feature.
let deliver: ((msg: RelayMessage) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: RelayMessage) => void) => {
    deliver = onMessage
    return { send: vi.fn(), connected: true }
  },
}))
vi.mock('@/hooks/usePerfMode', () => ({ usePerfMode: () => ({ perfMode: false, visible: false }) }))
vi.mock('@/hooks/useAudioPlayback', () => ({ useAudioPlayback: () => ({ pushFrame: vi.fn() }) }))
vi.mock('@/lib/decoders/pickDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decoders/pickDecoder')>()),
  canDecodeH264: () => false,
}))
const toastError = vi.fn()
const toastDismiss = vi.fn()
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: toastError, info: vi.fn(), dismiss: toastDismiss },
}))

const { DeviceViewer } = await import('@/components/DeviceViewer')

function mounted() {
  render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
  act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })
}

/** An `input:error` as the agents send it. `reason` is typed loosely so a test can post a value this
 *  build does not know about — the case the unknown-reason rule exists for. */
function inputError(reason?: string, message = 'input channel not ready') {
  act(() => {
    deliver!({ type: 'input:error', sessionId: 's1', message, reason } as unknown as RelayMessage)
  })
}

const opts = () => toastError.mock.calls.map(([, o]) => o as { id: string; description: string; duration: number })

describe('DeviceViewer — input:error (#485)', () => {
  beforeEach(() => { toastError.mockClear(); toastDismiss.mockClear(); deliver = null })

  it('tells the tester when input is not reaching the device', () => {
    mounted()
    inputError('channel-unavailable')
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError.mock.calls[0]![0]).toBe(INPUT_ERROR_NOTICE['channel-unavailable']!.title)
    expect(opts()[0]!.id).toBe('input:channel-unavailable')
  })

  // A dead channel produces one error per tap, at whatever rate the tester taps. Nothing dedupes
  // them here — every call carries the same `id`, and sonner refreshes that toast rather than
  // stacking a new one, which is also what keeps it on screen while the taps continue.
  it('reuses one toast id across a burst so repeats refresh rather than stack', () => {
    mounted()
    for (let i = 0; i < 5; i++) inputError('channel-unavailable')
    expect(toastError).toHaveBeenCalledTimes(5)
    expect(new Set(opts().map((o) => o.id)).size).toBe(1)
  })

  // The protocol prescribes a different action for this than for `channel-unavailable` — boot the
  // device, rather than reconnect — so one shared line would be wrong for one of them.
  it('gives not-booted its own copy', () => {
    mounted()
    inputError('not-booted')
    inputError('channel-unavailable')
    const [notBooted, unavailable] = toastError.mock.calls.map(([t]) => t as string)
    expect(notBooted).not.toBe(unavailable)
    expect(notBooted).toBe(INPUT_ERROR_NOTICE['not-booted']!.title)
  })

  it('carries the wire message as diagnostic detail, not as the headline', () => {
    mounted()
    inputError('unsupported', 'unknown key code: KeyFoo')
    expect(toastError.mock.calls[0]![0]).toBe(INPUT_ERROR_NOTICE.unsupported!.title)
    expect(opts()[0]!.description).toContain('unknown key code: KeyFoo')
  })

  // Android's default emulator backend answers a dead emulator with this, not with
  // `channel-unavailable`: the gRPC call is refused while the socket still reports itself writable.
  it('surfaces dispatch-failed', () => {
    mounted()
    inputError('dispatch-failed', 'the device rejected the input')
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  it('surfaces malformed — a dashboard bug is never silent', () => {
    mounted()
    inputError('malformed', 'this input does not fit what the device is doing')
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  it.each(['channel-starting', 'no-gesture'])('shows nothing for %s — it fixes itself', (reason) => {
    mounted()
    inputError(reason)
    expect(toastError).not.toHaveBeenCalled()
  })

  // Absence means unknown, never fine: an agent older than #490 omits the field, and the relay's own
  // `agent offline` reply still does.
  it('treats an absent reason as channel-unavailable', () => {
    mounted()
    inputError(undefined, 'agent offline')
    expect(toastError.mock.calls[0]![0]).toBe(INPUT_ERROR_NOTICE['channel-unavailable']!.title)
    expect(opts()[0]!.id).toBe('input:channel-unavailable')
  })

  // A newer agent against this build. Silence would be the dangerous direction — the reason exists
  // because something went wrong, and a build that cannot name it still must not imply "fine".
  it('treats a reason it does not know as channel-unavailable, under one id', () => {
    mounted()
    inputError('some-future-reason')
    inputError('another-future-reason')
    expect(toastError.mock.calls[0]![0]).toBe(INPUT_ERROR_NOTICE['channel-unavailable']!.title)
    expect(new Set(opts().map((o) => o.id)).size).toBe(1)
  })

  it('does not read a prototype key as a notice', () => {
    mounted()
    inputError('toString')
    expect(toastError.mock.calls[0]![0]).toBe(INPUT_ERROR_NOTICE['channel-unavailable']!.title)
  })

  it('ignores an input:error for another session', () => {
    mounted()
    act(() => {
      deliver!({ type: 'input:error', sessionId: 'other', message: 'x', reason: 'channel-unavailable' })
    })
    expect(toastError).not.toHaveBeenCalled()
  })

  // --- regression guards for the discarded latch design ---

  // `input:done` was only ever needed to release a latch. Handling it would mean the latch is back,
  // and the review found three independent sequences in which that latch lies.
  it('does nothing on input:done', () => {
    mounted()
    inputError('channel-unavailable')
    act(() => { deliver!({ type: 'input:done', sessionId: 's1' }) })
    expect(toastDismiss).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  // The sequence both review channels found independently: on Android a button always takes the adb
  // path while touch takes the pointer channel, so a tester checking "is input dead at all?" with
  // Home gets a success — which under the latch design erased the warning about the dead touch
  // channel. Here the success changes nothing and the next failure speaks for itself.
  it('lets a success between two failures change nothing', () => {
    mounted()
    inputError('channel-unavailable')
    act(() => { deliver!({ type: 'input:done', sessionId: 's1' }) })
    inputError('channel-unavailable')
    expect(toastError).toHaveBeenCalledTimes(2)
    expect(toastDismiss).not.toHaveBeenCalled()
  })
})

describe('INPUT_ERROR_NOTICE', () => {
  // The Record is what forces a decision per reason; this only pins that no entry was left as an
  // empty string, which the type cannot express. A new reason fails at `tsc`, not here.
  it('gives every non-silent reason both a title and an action', () => {
    for (const [reason, notice] of Object.entries(INPUT_ERROR_NOTICE) as Array<[InputErrorReason, typeof INPUT_ERROR_NOTICE[InputErrorReason]]>) {
      if (notice === null) continue
      expect(notice.title.length, reason).toBeGreaterThan(0)
      expect(notice.action.length, reason).toBeGreaterThan(0)
    }
  })
})
