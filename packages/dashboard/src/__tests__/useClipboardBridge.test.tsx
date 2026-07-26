import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { useClipboardBridge, isBridgedChord, AGENT_WORST_MS, type ClipboardMessageHandler } from '@/hooks/useClipboardBridge'

type Sent = { type: string; requestId?: string; payload?: unknown }

function setup(opts: { active?: boolean; supported?: boolean } = {}) {
  const sent: Sent[] = []
  const chords: Array<[string, number]> = []
  const errors: string[] = []
  const handlerRef = { current: undefined as ClipboardMessageHandler | undefined }

  renderHook(() => useClipboardBridge({
    sessionId: 's1',
    send: (m) => sent.push(m as Sent),
    active: opts.active ?? true,
    supported: opts.supported ?? true,
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
  // Captures what was handed to navigator.clipboard.write so a test can await the value the
  // promise-backed ClipboardItem eventually resolves to.
  let written: Array<Promise<string>>
  let writeCalls: number

  const secureContext = (on: boolean) =>
    Object.defineProperty(window, 'isSecureContext', { value: on, writable: true, configurable: true })

  beforeEach(() => {
    written = []
    writeCalls = 0
    secureContext(true)
    // jsdom ships neither of these.
    ;(globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem =
      class { constructor(public items: Record<string, Promise<Blob>>) {} }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: vi.fn(async (items: Array<{ items: Record<string, Promise<Blob>> }>) => {
          writeCalls++
          const blob = items[0].items['text/plain']
          const text = blob.then((b) => b.text())
          void text.catch(() => {})   // tests opt in to the rejection; don't leak it
          written.push(text)
          await blob
        }),
      },
    })
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

  // The claim goes out inside the keydown, before the device has answered — that is what keeps
  // the write inside the user activation while the value arrives ~780ms later.
  it('claims the clipboard up front and fills it when the device answers', async () => {
    const { reply, errors } = setup()
    press('KeyC')
    await waitFor(() => expect(writeCalls).toBe(1))

    reply({ type: 'clipboard:data', payload: { text: '한글 テスト 🎉' } }, 'clipboard:read')
    await expect(written[0]).resolves.toBe('한글 テスト 🎉')
    expect(errors).toEqual([])
  })

  // Plain-HTTP LAN: no promise-backed write exists and execCommand cannot bridge a ~780ms
  // round trip. Say so rather than fail silently — and still copy on the device.
  it('reports the HTTPS requirement instead of failing silently on plain HTTP', async () => {
    secureContext(false)
    const { sent, chords, errors } = setup()
    press('KeyC')
    await waitFor(() => expect(errors.length).toBe(1))
    expect(errors[0]).toMatch(/HTTPS/i)
    expect(chords).toEqual([['KeyC', 0x08]])
    expect(sent).toEqual([])
  })

  it('does not overwrite the clipboard when the device clipboard is empty', async () => {
    const { reply, errors } = setup()
    press('KeyC')
    await waitFor(() => expect(writeCalls).toBe(1))
    const claim = written[0].catch(() => 'cancelled')
    reply({ type: 'clipboard:data', payload: { text: '' } }, 'clipboard:read')
    await expect(claim).resolves.toBe('cancelled')
    expect(errors).toEqual([])
  })


  it('surfaces an agent-side error instead of writing', async () => {
    const { reply, errors } = setup()
    press('KeyC')
    const claim = written[0].catch(() => 'cancelled')
    reply({ type: 'clipboard:error', message: 'Clipboard needs the emulator gRPC backend' }, 'clipboard:read')

    await waitFor(() => expect(errors[0]).toMatch(/gRPC/i))
    await expect(claim).resolves.toBe('cancelled')
  })

  // The bridge must never make copy worse than it was. On an explicit failure the chord still
  // goes to the device so the copy at least lands on the device's own clipboard.
  it('falls back to the plain chord when the bridge cannot copy', async () => {
    const { chords, reply } = setup()
    press('KeyC')
    reply({ type: 'clipboard:error', message: 'not supported' }, 'clipboard:read')
    await waitFor(() => expect(chords).toEqual([['KeyC', 0x08]]))
  })

  it('falls back with the cut chord for Cmd+X', async () => {
    const { chords, reply } = setup()
    press('KeyX')
    reply({ type: 'clipboard:error', message: 'not supported' }, 'clipboard:read')
    await waitFor(() => expect(chords).toEqual([['KeyX', 0x08]]))
  })

  // A timeout is NOT a failure — the agent is still mid-copy and already pressed the chord
  // itself. Pressing again here would copy twice.
  // An agent that does not advertise the capability is left entirely alone: the bridge sends
  // nothing and the viewers keep forwarding the chords, which is what happened before it
  // existed. Inferring this from a timeout instead once produced a double paste on a merely
  // slow agent, and could blind-paste a read's sentinel into the app.
  it('stays inert against an agent without the capability', async () => {
    const { sent, chords, errors } = setup({ supported: false })
    press('KeyC')
    press('KeyX')
    pastes('anything')
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toEqual([])
    expect(chords).toEqual([])   // the viewer forwards them, not the bridge
    expect(errors).toEqual([])
  })

  // A timeout from a capable agent is a fault, not a version signal — it already pressed the
  // chord, so pressing again would copy twice.
  it('does not press the chord when a capable agent is slow', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { chords, errors } = setup()
      press('KeyC')
      await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })   // past the budget
      await waitFor(() => expect(errors.length).toBe(1))
      expect(chords).toEqual([])
    } finally { vi.useRealTimers() }
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

  // A blind chord goes through input:key, bypassing the agent's per-device clipboard queue —
  // a concurrent read may have its sentinel parked on the device, which the chord would paste
  // into the app under test. Report instead.
  it('does not fire a blind chord when the bridge write fails', async () => {
    const { chords, errors, reply } = setup()
    pastes('x')
    reply({ type: 'clipboard:error', message: 'agent offline' }, 'clipboard:write')
    await waitFor(() => expect(errors).toEqual(['agent offline']))
    expect(chords).toEqual([])
  })

  // ...except on a backend with no clipboard channel at all (Android on scrcpy). It can never
  // park a sentinel, so the chord is provably safe — and without it Cmd+V would silently do
  // nothing on those devices, which is worse than the behaviour predating this feature.
  it('does press paste when the backend has no clipboard channel', async () => {
    const { chords, reply } = setup()
    pastes('x')
    reply({
      type: 'clipboard:error', message: 'this device pastes on-device only',
      payload: { unsupported: true },
    }, 'clipboard:write')
    await waitFor(() => expect(chords).toEqual([['KeyV', 0x08]]))
  })

  // On a timeout the agent is still writing and will press paste itself once it lands —
  // pressing here too would paste the text twice.
  // Same reasoning on the write side: a slow-but-capable agent presses paste itself.
  it('does not press paste when a capable agent is slow', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { chords } = setup()
      pastes('slow one')
      await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })   // past the budget
      expect(chords).toEqual([])
    } finally { vi.useRealTimers() }
  })

  // M5: copy needs a secure context, paste never did. A LAN deployment must keep pasting.
  it('paste still works on plain HTTP', async () => {
    secureContext(false)
    const { sent, chords, reply } = setup()
    pastes('from my mac')
    const write = sent.find((s) => s.type === 'clipboard:write')
    expect((write?.payload as { text: string }).text).toBe('from my mac')

    reply({ type: 'clipboard:write-done' }, 'clipboard:write')
    await new Promise((r) => setTimeout(r, 20))
    expect(chords).toEqual([])   // the agent pressed paste itself
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

// The browser budget and the agent's worst case were once the same number by accident, and the
// browser then gave up at the exact moment the agent was about to answer with a specific error.
// agent-core owns the agent side and the dashboard cannot import it, so this reads that source
// directly rather than trusting two hand-written copies to stay in step.
describe('round-trip budget vs the agent worst case', () => {
  const CLAIM_LIMIT_MS = 6_000   // measured in Chrome and Safari

  const agentWorstFromSource = (): number => {
    const src = readFileSync(
      join(__dirname, '..', '..', '..', 'agent-core', 'src', 'types.ts'), 'utf-8')
    const num = (name: string): number => {
      const m = src.match(new RegExp(`${name} = ([0-9_]+)`))
      if (!m) throw new Error(`${name} not found in agent-core/src/types.ts`)
      return Number(m[1].replace(/_/g, ''))
    }
    // Mirrors CLIPBOARD_AGENT_WORST_MS: the restore window is excluded (it runs after the
    // reply) and five device calls are counted (each windowed loop can overrun by one).
    return num('CLIPBOARD_WRITE_DEADLINE_MS') + num('CLIPBOARD_COPY_DEADLINE_MS')
      + 5 * num('CLIPBOARD_DEVICE_CALL_MS')
  }

  it('the hook derives the same worst case agent-core does', () => {
    // Changing a deadline in agent-core without updating the hook must fail here.
    // The hook's own constant, not a third copy — changing either side must fail here.
    expect(AGENT_WORST_MS).toBe(agentWorstFromSource())
  })

  it('waits past the agent worst case', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { errors } = setup()
      press('KeyC')
      await act(async () => { await vi.advanceTimersByTimeAsync(AGENT_WORST_MS) })
      expect(errors).toEqual([])   // still waiting — the agent may yet answer specifically
    } finally { vi.useRealTimers() }
  })

  it('gives up before a claimed clipboard write would lapse', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { errors } = setup()
      press('KeyC')
      // advance to just under the claim limit — the budget must have fired by now
      await act(async () => { await vi.advanceTimersByTimeAsync(CLAIM_LIMIT_MS - 1) })
      await waitFor(() => expect(errors.length).toBe(1))
    } finally { vi.useRealTimers() }
  })
})
