import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { useClipboardBridge, isBridgedChord, AGENT_WORST_MS, type ClipboardBridgeMessage, type ClipboardMessageHandler } from '@/hooks/useClipboardBridge'

type Sent = { type: string; requestId?: string; payload?: unknown }

// The reply fixtures name a real wire message minus the two ids the helper fills in. Distributive,
// so each union member keeps its own payload — a plain `Omit` would collapse them into one shape and
// stop checking which payload goes with which type.
type WithoutIds<T> = T extends unknown ? Omit<T, 'sessionId' | 'requestId'> : never

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

  const reply = (msg: WithoutIds<ClipboardBridgeMessage>, ofType: string) => {
    const req = [...sent].reverse().find((s) => s.type === ofType)
    // Annotated rather than cast. This call used to end in `as never`, which accepts anything — so
    // the fixtures were free to disagree with the wire and the suite would not have said so.
    const full: ClipboardBridgeMessage = { ...msg, sessionId: 's1', requestId: req?.requestId ?? 'no-request' }
    act(() => { handlerRef.current?.(full) })
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

// Captures what was handed to navigator.clipboard.write so a test can await the value the
// promise-backed ClipboardItem eventually resolves to.
let written: Array<Promise<string>>
let writeCalls: number

const secureContext = (on: boolean) =>
  Object.defineProperty(window, 'isSecureContext', { value: on, writable: true, configurable: true })

// File-level, not inside the first describe. It used to live there, and the budget describe below
// — a sibling — silently relied on `defineProperty` and `vi.fn` surviving `restoreAllMocks` and
// leaking forward. Running that block alone (`vitest -t`, `.only`) then took the plain-HTTP branch
// and every timing assertion passed vacuously.
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

describe('useClipboardBridge', () => {
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


  // A reply correlated to the right requestId but carrying the wrong message means an agent answered
  // under someone else's id. Before the wire union reached this file the read path could not tell:
  // its declared shape was `{ payload?: unknown }`, so a `write-done` read as "no text" and took the
  // empty-clipboard path — cancelling the claim with nothing said. Silence is the one outcome this
  // whole class of bug is being cleared out of, so it is reported.
  it('reports a write-done that answers a read instead of cancelling silently', async () => {
    const { reply, errors, chords } = setup()
    press('KeyC')
    await waitFor(() => expect(writeCalls).toBe(1))
    const claim = written[0].catch(() => 'cancelled')
    reply({ type: 'clipboard:write-done' }, 'clipboard:read')

    await waitFor(() => expect(errors).toEqual(['Clipboard read failed']))
    await expect(claim).resolves.toBe('cancelled')
    // No fallback chord: nothing here says whether a sentinel is parked, and pressing on that
    // uncertainty is what pastes a stale value into the app under test.
    expect(chords).toEqual([])
  })

  it('reports clipboard:data answering a write, and presses nothing', async () => {
    const { reply, errors, chords } = setup()
    pastes('from my mac')
    reply({ type: 'clipboard:data', payload: { text: 'wrong reply' } }, 'clipboard:write')

    await waitFor(() => expect(errors).toEqual(['Clipboard write failed']))
    expect(chords).toEqual([])
  })

  it('surfaces an agent-side error instead of writing', async () => {
    const { reply, errors } = setup()
    press('KeyC')
    const claim = written[0].catch(() => 'cancelled')
    reply({ type: 'clipboard:error', message: 'Clipboard needs the emulator gRPC backend' }, 'clipboard:read')

    await waitFor(() => expect(errors[0]).toMatch(/gRPC/i))
    await expect(claim).resolves.toBe('cancelled')
  })

  // A backend with no clipboard channel never wrote a sentinel, so the chord is safe there —
  // and it is the only way the copy happens at all.
  it('falls back to the plain chord when the backend has no clipboard channel', async () => {
    const { chords, reply } = setup()
    press('KeyC')
    reply({ type: 'clipboard:error', message: 'not supported', payload: { unsupported: true, sentinelParked: false } }, 'clipboard:read')
    await waitFor(() => expect(chords).toEqual([['KeyC', 0x08]]))
  })

  it('falls back with the cut chord for Cmd+X', async () => {
    const { chords, reply } = setup()
    press('KeyX')
    reply({ type: 'clipboard:error', message: 'not supported', payload: { unsupported: true, sentinelParked: false } }, 'clipboard:read')
    await waitFor(() => expect(chords).toEqual([['KeyX', 0x08]]))
  })

  // The agent replies before it restores, so with a sentinel still parked a chord here would
  // copy and the restore would overwrite that with the pre-read value — handing the user a stale
  // clipboard, which is what the sentinel prevents.
  it('does not press the chord when a sentinel is still parked', async () => {
    const { chords, errors, reply } = setup()
    press('KeyC')
    reply({ type: 'clipboard:error', message: 'did not copy anything', payload: { sentinelParked: true } }, 'clipboard:read')
    await waitFor(() => expect(errors).toEqual(['did not copy anything']))
    expect(chords).toEqual([])
  })

  // Failing before the sentinel goes down is not the same thing. iOS never reports `unsupported`
  // at all, so gating on that alone made the fallback dead code there — the user lost the
  // on-device copy they used to get whenever reading the original failed.
  it('falls back when the agent got nowhere near parking a sentinel', async () => {
    const { chords, reply } = setup()
    press('KeyC')
    reply({
      type: 'clipboard:error', message: 'Cannot press copy — no input channel to the device',
      payload: { sentinelParked: false },
    }, 'clipboard:read')
    await waitFor(() => expect(chords).toEqual([['KeyC', 0x08]]))
  })

  // An agent from before the field cannot tell us, and a silent stale paste is worse than a copy
  // that did not happen.
  it('assumes a sentinel is parked when the agent does not say', async () => {
    const { chords, errors, reply } = setup()
    press('KeyC')
    reply({ type: 'clipboard:error', message: 'read failed' }, 'clipboard:read')
    await waitFor(() => expect(errors).toEqual(['read failed']))
    expect(chords).toEqual([])
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
    const { sent, chords, reply, errors } = setup()
    pastes('pasted from my mac')

    const write = sent.find((s) => s.type === 'clipboard:write')
    expect((write?.payload as { text: string; pasteAfter: boolean }).text).toBe('pasted from my mac')
    expect((write?.payload as { pasteAfter: boolean }).pasteAfter).toBe(true)

    reply({ type: 'clipboard:write-done' }, 'clipboard:write')
    await new Promise((r) => setTimeout(r, 20))
    expect(chords).toEqual([])     // the agent pressed it; pressing again would double-paste
    // A success says nothing. Without this the whole success branch could be deleted and every test
    // still passed: the paste lands and the tester is told it failed.
    expect(errors).toEqual([])
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
    const { sent, chords, reply, errors } = setup()
    pastes('from my mac')
    const write = sent.find((s) => s.type === 'clipboard:write')
    expect((write?.payload as { text: string }).text).toBe('from my mac')

    reply({ type: 'clipboard:write-done' }, 'clipboard:write')
    await new Promise((r) => setTimeout(r, 20))
    expect(chords).toEqual([])   // the agent pressed paste itself
    expect(errors).toEqual([])
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
      const m = src.match(new RegExp(`^export const ${name} = ([0-9_]+)`, 'm'))
      if (!m) throw new Error(`${name} not found in agent-core/src/types.ts`)
      return Number(m[1].replace(/_/g, ''))
    }
    // Evaluate agent-core's own expression rather than restating it here. Restating it meant a
    // formula change there — dropping a device call, say — left this passing, which is exactly
    // the drift this test exists to catch.
    // Take the WHOLE statement, continuation lines included. The declaration already wraps, so
    // adding a term on a following line is the natural way to extend it — and reading only the
    // first line left such a term invisible here while agent-core's real value moved.
    const lines = src.split('\n')
    const at = lines.findIndex((l) => l.startsWith('export const CLIPBOARD_AGENT_WORST_MS ='))
    if (at < 0) throw new Error('CLIPBOARD_AGENT_WORST_MS not found in agent-core/src/types.ts')
    const parts = [lines[at].slice(lines[at].indexOf('=') + 1)]
    for (let i = at + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) parts.push(lines[i])
    const expr = parts.join(' ').trim()
    const resolved = expr.replace(/\s+/g, ' ').replace(/[A-Z_]{4,}/g, (name) => String(num(name)))
    if (!/^[0-9+*\s]+$/.test(resolved)) throw new Error(`unexpected expression: ${expr}`)
    return Number(new Function(`return ${resolved}`)())
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
      // Advance to just under the claim limit — the budget must have fired by now. Asserted
      // directly, not through `waitFor`: under `shouldAdvanceTime` its polling keeps pushing the
      // fake clock forward, which handed the budget over a second of slack it should not get.
      await act(async () => { await vi.advanceTimersByTimeAsync(CLAIM_LIMIT_MS - 1) })
      expect(errors.length).toBe(1)
    } finally { vi.useRealTimers() }
  })
})
