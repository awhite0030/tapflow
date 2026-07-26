import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { useClipboardBridge, type ClipboardMessageHandler } from '@/hooks/useClipboardBridge'

type Sent = { type: string; requestId?: string; payload?: unknown }

function setup(opts: { active?: boolean } = {}) {
  const sent: Sent[] = []
  const chords: Array<[string, number]> = []
  const errors: string[] = []
  const handlerRef = createRef<ClipboardMessageHandler | undefined>() as {
    current: ClipboardMessageHandler | undefined
  }
  handlerRef.current = undefined

  const hook = renderHook(() => useClipboardBridge({
    sessionId: 's1',
    send: (m) => sent.push(m as Sent),
    active: opts.active ?? true,
    handlerRef,
    sendChord: (code, mods) => chords.push([code, mods]),
    onError: (m) => errors.push(m),
  }))

  // Deliver an agent reply for the most recent request of the given type.
  const reply = (msg: Omit<Sent, 'requestId'> & { message?: string }, ofType: string) => {
    const req = [...sent].reverse().find((s) => s.type === ofType)
    act(() => { handlerRef.current?.({ ...msg, requestId: req?.requestId } as never) })
  }

  return { sent, chords, errors, reply, hook }
}

const pressCopy = () => act(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', metaKey: true, bubbles: true }))
})

const pastes = (text: string) => act(() => {
  const e = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
  e.clipboardData = { getData: () => text }
  document.dispatchEvent(e)
})

describe('useClipboardBridge', () => {
  let execCommand: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', { value: execCommand, writable: true, configurable: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('Cmd+C presses copy on the device, then asks for its clipboard', async () => {
    const { sent, chords } = setup()
    pressCopy()

    // the chord goes first so a live selection actually lands on the device clipboard
    expect(chords).toEqual([['KeyC', 0x08]])
    await act(async () => { await vi.advanceTimersByTimeAsync(80) })
    expect(sent.map((s) => s.type)).toContain('clipboard:read')
  })

  it('writes the returned text to the user clipboard', async () => {
    const { reply, errors } = setup()
    pressCopy()
    await act(async () => { await vi.advanceTimersByTimeAsync(80) })
    reply({ type: 'clipboard:data', payload: { text: '한글 テスト 🎉' } }, 'clipboard:read')

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'))
    expect(errors).toEqual([])
  })

  // Safari loses user activation past ~500ms, so a late reply must not be written —
  // it would silently no-op and the user would think the copy worked.
  it('gives up when the agent misses the round-trip budget', async () => {
    const { reply, errors } = setup()
    pressCopy()
    await act(async () => { await vi.advanceTimersByTimeAsync(80) })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })

    await waitFor(() => expect(errors.length).toBe(1))
    expect(errors[0]).toMatch(/again/i)

    // a reply arriving after the budget is dropped, not written
    reply({ type: 'clipboard:data', payload: { text: 'too late' } }, 'clipboard:read')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('surfaces an agent-side clipboard error instead of writing', async () => {
    const { reply, errors } = setup()
    pressCopy()
    await act(async () => { await vi.advanceTimersByTimeAsync(80) })
    reply({ type: 'clipboard:error', message: 'Clipboard is not supported on this backend' }, 'clipboard:read')

    await waitFor(() => expect(errors[0]).toMatch(/not supported/i))
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('paste sends the text to the device, then presses paste', async () => {
    const { sent, chords, reply } = setup()
    pastes('pasted from my mac')

    const write = sent.find((s) => s.type === 'clipboard:write')
    expect((write?.payload as { text: string }).text).toBe('pasted from my mac')
    expect(chords).toEqual([])   // not until the write landed

    reply({ type: 'clipboard:write-done' }, 'clipboard:write')
    await waitFor(() => expect(chords).toEqual([['KeyV', 0x08]]))
  })

  // R7: the bridge must never make paste worse than it was before it existed.
  it('still presses paste when the bridge write fails', async () => {
    const { chords, reply } = setup()
    pastes('x')
    reply({ type: 'clipboard:error', message: 'agent offline' }, 'clipboard:write')

    await waitFor(() => expect(chords).toEqual([['KeyV', 0x08]]))
  })

  it('does nothing while the viewer does not own the keyboard', async () => {
    const { sent, chords } = setup({ active: false })
    pressCopy()
    pastes('ignored')
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })

    expect(sent).toEqual([])
    expect(chords).toEqual([])
  })
})
