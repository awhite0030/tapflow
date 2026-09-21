import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useClientRecording } from '@/hooks/useClientRecording'

/**
 * **The recorder draws with the newest composer, every tick.**
 *
 * `setComposeFrame` replaced an argument to `startClientRecording`, and the difference is the
 * whole point: taken at start, the recorder held whichever closure existed then, so a rotation
 * mid-recording never reached the frames. The viewers used to paper over that by mirroring the
 * turn into refs they wrote *after* handing the closure over — a Rules of React violation, and
 * the reason neither viewer would compile.
 *
 * Nothing tested this hook. The viewers mock it out, so the contract had a tested caller and no
 * tested callee.
 */

const rafQueue: FrameRequestCallback[] = []

/** Run one animation frame — whatever is queued at this moment, and nothing it queues after. */
function tick() {
  const due = rafQueue.splice(0, rafQueue.length)
  act(() => { for (const cb of due) cb(performance.now()) })
}

beforeEach(() => {
  rafQueue.length = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafQueue.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('MediaRecorder', class {
    static isTypeSupported() { return true }
    ondataavailable: unknown = null
    onstop: (() => void) | null = null
    start() {}
    stop() { this.onstop?.() }
  })
  HTMLCanvasElement.prototype.getContext =
    vi.fn(() => ({ fillStyle: '', fillRect: vi.fn() })) as unknown as HTMLCanvasElement['getContext']
  HTMLCanvasElement.prototype.captureStream =
    vi.fn(() => ({})) as unknown as HTMLCanvasElement['captureStream']
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function mount() {
  const hook = renderHook(() => useClientRecording({ sessionId: 's1' }))
  const rc = document.createElement('canvas')
  rc.width = 100; rc.height = 200
  // The hook's ref is the canvas the viewer renders; standing one up is what the viewer does.
  ;(hook.result.current.recordCanvasRef as { current: HTMLCanvasElement | null }).current = rc
  return hook
}

describe('useClientRecording — the frame loop', () => {
  it('calls the composer registered after recording started, not the one registered before', () => {
    const first = vi.fn()
    const second = vi.fn()
    const hook = mount()

    act(() => { hook.result.current.setComposeFrame(first) })
    act(() => { hook.result.current.startClientRecording() })
    tick()
    expect(first).toHaveBeenCalledTimes(1)

    // A rotation mid-recording: the viewer rebuilds `composeFrame` and registers the new one.
    act(() => { hook.result.current.setComposeFrame(second) })
    tick()
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('keeps drawing frame after frame, rather than once', () => {
    const compose = vi.fn()
    const hook = mount()
    act(() => { hook.result.current.setComposeFrame(compose) })
    act(() => { hook.result.current.startClientRecording() })

    tick(); tick(); tick()
    expect(compose).toHaveBeenCalledTimes(3)
  })

  it('draws nothing once recording has stopped', async () => {
    const compose = vi.fn()
    const hook = mount()
    act(() => { hook.result.current.setComposeFrame(compose) })
    act(() => { hook.result.current.startClientRecording() })
    tick()
    expect(compose).toHaveBeenCalledTimes(1)

    // The upload is not what this test is about; it fails on its own and leaves the state idle.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no relay in this test') }))
    await act(async () => { await hook.result.current.stopClientRecording() })

    tick()
    expect(compose).toHaveBeenCalledTimes(1)
  })
})
