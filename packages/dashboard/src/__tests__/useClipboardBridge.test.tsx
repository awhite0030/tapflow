import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useClipboardBridge, isBridgedChord, type ClipboardMessageHandler } from '@/hooks/useClipboardBridge'

type Sent = { type: string; requestId?: string; payload?: unknown }

function setup(opts: { active?: boolean } = {}) {
  const sent: Sent[] = []
  const chords: Array<[string, number]> = []
  const errors: string[] = []
  const handlerRef = { current: undefined as ClipboardMessageHandler | undefined }

  renderHook(() => useClipboardBridge({
    sessionId: 's1',
    send: (m) => sent.push(m as Sent),
    active: opts.active ?? true,
    handlerRef,
    sendChord: (code, mods) => chords.push([code, mods]),
    onError: (m) => errors.push(m),
  }))

  const reply = (msg: Omit<Sent, 'requestId'> & { message?: string }, ofType: string) => {
    const req = [...sent].reverse().find((s) => s.type === ofType)
    act(() => { handlerRef.current?.({ ...msg, requestId: req?.requestId } as never) })
  }

  return { sent, chords, errors, reply }
}

const press = (code: string, init: Partial<KeyboardEventInit> = {}) => act(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { code, metaKey: true, bubbles: true, ...init }))
})

const pastes = (text: string) => act(() => {
  const e = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
  e.clipboardData = { getData: () => text }
  document.dispatchEvent(e)
})

describe('useClipboardBridge', () => {
  let execCommand: ReturnType<typeof vi.fn>

  beforeEach(() => {
    execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', { value: execCommand, writable: true, configurable: true })
  })

  afterEach(() => { vi.restoreAllMocks() })

  // The agent presses the device chord, not the hook — only it knows when the key landed.
  it('Cmd+C asks the agent to press copy and read, without pressing the chord itself', async () => {
    const { sent, chords } = setup()
    press('KeyC')

    await waitFor(() => expect(sent.length).toBe(1))
    expect(sent[0].type).toBe('clipboard:read')
    expect((sent[0].payload as { press: string }).press).toBe('copy')
    expect(chords).toEqual([])
  })

  it('Cmd+X asks for a cut', async () => {
    const { sent } = setup()
    press('KeyX')
    await waitFor(() => expect(sent.length).toBe(1))
    expect((sent[0].payload as { press: string }).press).toBe('cut')
  })

  it('writes the returned text to the user clipboard', async () => {
    const { reply, errors } = setup()
    press('KeyC')
    await waitFor(() => expect(execCommand).not.toHaveBeenCalled())
    reply({ type: 'clipboard:data', payload: { text: '한글 テスト 🎉' } }, 'clipboard:read')

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'))
    expect(errors).toEqual([])
  })

  // Safari loses user activation past ~500ms, so a late reply must not be written — it would
  // silently no-op while the user believes the copy worked.
  it('gives up when the agent misses the round-trip budget', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { reply, errors } = setup()
    press('KeyC')
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })

    await waitFor(() => expect(errors.length).toBe(1))
    expect(errors[0]).toMatch(/again/i)

    reply({ type: 'clipboard:data', payload: { text: 'too late' } }, 'clipboard:read')
    expect(execCommand).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('surfaces an agent-side error instead of writing', async () => {
    const { reply, errors } = setup()
    press('KeyC')
    reply({ type: 'clipboard:error', message: 'Clipboard needs the emulator gRPC backend' }, 'clipboard:read')

    await waitFor(() => expect(errors[0]).toMatch(/gRPC/i))
    expect(execCommand).not.toHaveBeenCalled()
  })

  // A backend with no clipboard channel answers every press identically; one toast is
  // information, one per keypress is noise.
  it('reports a repeated identical error only once', async () => {
    const { reply, errors } = setup()
    press('KeyC')
    reply({ type: 'clipboard:error', message: 'not supported' }, 'clipboard:read')
    await waitFor(() => expect(errors.length).toBe(1))
    press('KeyC')
    reply({ type: 'clipboard:error', message: 'not supported' }, 'clipboard:read')
    await new Promise((r) => setTimeout(r, 20))
    expect(errors.length).toBe(1)
  })

  it('paste sends the text and lets the agent press paste', async () => {
    const { sent, chords, reply } = setup()
    pastes('pasted from my mac')

    const write = sent.find((s) => s.type === 'clipboard:write')
    expect((write?.payload as { text: string; pasteAfter: boolean }).text).toBe('pasted from my mac')
    expect((write?.payload as { pasteAfter: boolean }).pasteAfter).toBe(true)

    reply({ type: 'clipboard:write-done' }, 'clipboard:write')
    await new Promise((r) => setTimeout(r, 20))
    expect(chords).toEqual([])     // the agent pressed it; pressing again would double-paste
  })

  // Regression: with an image/file on the OS clipboard there is no text to send, but the
  // device must still paste its own clipboard — that worked before the bridge existed.
  it('falls back to the plain chord when the OS clipboard holds no text', async () => {
    const { sent, chords } = setup()
    pastes('')
    expect(sent).toEqual([])
    expect(chords).toEqual([['KeyV', 0x08]])
  })

  it('falls back to the plain chord when the bridge write fails', async () => {
    const { chords, reply } = setup()
    pastes('x')
    reply({ type: 'clipboard:error', message: 'agent offline' }, 'clipboard:write')
    await waitFor(() => expect(chords).toEqual([['KeyV', 0x08]]))
  })

  // A Windows viewer sends Ctrl+C, but iOS only understands Cmd — the device chord is
  // always meta regardless of what was pressed.
  it('uses the meta chord for the fallback even when Ctrl was pressed', async () => {
    const { chords } = setup()
    act(() => {
      const e = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
      e.clipboardData = { getData: () => '' }
      document.dispatchEvent(e)
    })
    expect(chords).toEqual([['KeyV', 0x08]])
  })

  it('ignores an auto-repeating held chord', async () => {
    const { sent } = setup()
    press('KeyC', { repeat: true })
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toEqual([])
  })

  it('leaves Cmd+Shift+C alone', async () => {
    const { sent } = setup()
    press('KeyC', { shiftKey: true })
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toEqual([])
  })

  // Copying a selected build id / URL from the dashboard chrome must keep working.
  it('does not hijack a copy of a selection made in the dashboard', async () => {
    const sel = { isCollapsed: false, toString: () => 'selected text' }
    vi.spyOn(window, 'getSelection').mockReturnValue(sel as unknown as Selection)
    const { sent } = setup()
    press('KeyC')
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toEqual([])
  })

  it('does nothing while the viewer does not own the keyboard', async () => {
    const { sent, chords } = setup({ active: false })
    press('KeyC')
    pastes('ignored')
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toEqual([])
    expect(chords).toEqual([])
  })

  // requestId addresses a reply that ends up on the user's OS clipboard, so it must not be
  // guessable by anything else holding the session id.
  it('mints an unguessable requestId per request', async () => {
    const { sent } = setup()
    press('KeyC')
    press('KeyC')
    await waitFor(() => expect(sent.length).toBe(2))
    const ids = sent.map((s) => s.requestId!)
    expect(new Set(ids).size).toBe(2)
    ids.forEach((id) => expect(id).toMatch(/^[0-9a-f]{32}$/))
  })
})

// The viewers skip exactly these chords in their own keydown handler. If the two conditions
// drift apart a chord is either sent twice (double paste) or lost entirely, so both sides
// import this one predicate — these cases pin its shape.
describe('isBridgedChord', () => {
  const ev = (o: Partial<KeyboardEvent>) =>
    ({ code: 'KeyC', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o }) as KeyboardEvent

  it('claims copy, cut and paste with meta or ctrl', () => {
    for (const code of ['KeyC', 'KeyX', 'KeyV']) {
      expect(isBridgedChord(ev({ code, metaKey: true }))).toBe(true)
      expect(isBridgedChord(ev({ code, ctrlKey: true }))).toBe(true)
    }
  })

  it('claims paste regardless of shift — the paste event fires either way', () => {
    expect(isBridgedChord(ev({ code: 'KeyV', metaKey: true, shiftKey: true }))).toBe(true)
  })

  // Cmd+Shift+C is not a clipboard chord; it must stay on the normal key path.
  it('leaves shifted copy/cut to the normal key path', () => {
    expect(isBridgedChord(ev({ code: 'KeyC', metaKey: true, shiftKey: true }))).toBe(false)
    expect(isBridgedChord(ev({ code: 'KeyX', metaKey: true, shiftKey: true }))).toBe(false)
  })

  it('ignores unmodified keys, alt chords and other letters', () => {
    expect(isBridgedChord(ev({ code: 'KeyC' }))).toBe(false)
    expect(isBridgedChord(ev({ code: 'KeyC', metaKey: true, altKey: true }))).toBe(false)
    expect(isBridgedChord(ev({ code: 'KeyA', metaKey: true }))).toBe(false)
  })
})
