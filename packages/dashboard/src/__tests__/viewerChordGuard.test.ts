import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { isBridgedChord } from '@/hooks/useClipboardBridge'

// The viewers and the bridge split the copy/cut/paste chords between them: the viewer must skip
// exactly what the bridge handles. Forward one twice and the device pastes twice; drop one and
// the keystroke vanishes. There are no viewer component tests in this repo (they need a canvas,
// a decoder and a live socket), so this pins the contract at the source level instead of
// pretending the interaction is covered.
const viewer = (name: string): string =>
  readFileSync(join(__dirname, '..', '..', 'components', 'device', name), 'utf-8')

describe('viewer ↔ clipboard bridge chord split', () => {
  for (const name of ['IOSViewer.tsx', 'AndroidViewer.tsx']) {
    it(`${name} yields the bridged chords, and only while the bridge is active`, () => {
      const src = viewer(name)
      // Both halves matter: without `clipboardSupported` an agent that cannot do clipboard
      // would have its chords swallowed by an inert bridge (silent Cmd+V); without
      // `isBridgedChord` the viewer would forward chords the bridge is also handling.
      expect(src).toMatch(/if \(clipboardSupported && isBridgedChord\(e\)\) return/)
      // It has to sit inside the keydown handler and before that handler forwards the key,
      // or the double-send happens anyway. (Scope the search past `sendChord`'s own
      // `input:key` call, which appears earlier in the file.)
      const handler = src.indexOf('const onKeyDown')
      const guard = src.indexOf('clipboardSupported && isBridgedChord', handler)
      const forward = src.indexOf("send({ type: 'input:key'", handler)
      expect(handler).toBeGreaterThan(-1)
      expect(guard).toBeGreaterThan(handler)
      expect(guard).toBeLessThan(forward)
    })
  }

  // The predicate itself decides what the viewer gives up, so its shape is part of the contract.
  it('claims copy/cut/paste and nothing else', () => {
    const ev = (o: Partial<KeyboardEvent>) =>
      ({ code: 'KeyC', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o }) as KeyboardEvent
    expect(isBridgedChord(ev({ code: 'KeyC', metaKey: true }))).toBe(true)
    expect(isBridgedChord(ev({ code: 'KeyX', ctrlKey: true }))).toBe(true)
    expect(isBridgedChord(ev({ code: 'KeyV', metaKey: true, shiftKey: true }))).toBe(true)
    expect(isBridgedChord(ev({ code: 'KeyC', metaKey: true, shiftKey: true }))).toBe(false)
    expect(isBridgedChord(ev({ code: 'KeyA', metaKey: true }))).toBe(false)
    expect(isBridgedChord(ev({ code: 'KeyC' }))).toBe(false)
  })
})
