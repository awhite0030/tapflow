import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SimulatorToolbar } from '@/components/device/shared/SimulatorToolbar'

// Postures arrive already ordered most closed → most open — the protocol's contract, and what lets
// this control render without knowing any platform's vocabulary. The ids are opaque on purpose:
// these are the emulator console's, and another platform's will look nothing like them.
// Two postures is what an Android foldable actually offers through tapflow: the guest's
// `HALF_OPENED` and `OPENED` present the same screen, so only one of them is worth a control.
const PAIR = [
  { id: '1', label: 'Folded' },
  { id: '2', label: 'Unfolded' },
]

type Posture = { postures: typeof PAIR; currentId: string | null; pending?: boolean; onSelect: (id: string) => void }

function toolbar(posture?: Posture) {
  return render(
    <SimulatorToolbar
      joined
      onScreenshot={() => {}}
      onRecordToggle={() => {}}
      recordState="idle"
      onRotate={() => {}}
      onDeepLink={() => {}}
      posture={posture ? { ...posture, pending: posture.pending ?? false } : undefined}
    />,
  )
}

const postureButton = () => screen.queryByRole('button', { name: /^(Posture|Unfold|Fold)/ })

describe('SimulatorToolbar posture control', () => {
  it('is absent when the device has no postures', () => {
    toolbar()
    expect(postureButton()).toBeNull()
  })

  it('is absent when there is only one posture to choose between', () => {
    // The list length is the gate, not a platform check: an agent answers for every device it hosts.
    toolbar({ postures: [PAIR[0]!], currentId: '1', onSelect: () => {} })
    expect(postureButton()).toBeNull()
  })

  it('is absent when a device offers three, rather than cycling through them', () => {
    // **This is the rule the control is built on, and the only test that can hold it.** A radio
    // menu used to stand behind this case and was unreachable: `android-agent`'s `KNOWN` table has
    // two entries and `parsePostures` filters it, so the wire carries 0, 1 or 2 and iOS sends
    // none. Deleting it is what this test exists alongside.
    //
    // Widening the gate back to `> 1` compiles, renders a button, and makes it *cycle*
    // `(at + 1) % length` — which is the behaviour the menu was introduced to avoid, because two
    // of a foldable's guest postures present the same screen and stepping between them reads as a
    // press that was dropped. So a third entry has to make the control disappear, where somebody
    // notices it and decides what replaces the toggle.
    const onSelect = vi.fn()
    toolbar({ postures: [...PAIR, { id: '4', label: 'Flipped' }], currentId: '1', onSelect })
    expect(postureButton()).toBeNull()
  })

  it('toggles directly — there is only ever one alternative', async () => {
    const onSelect = vi.fn()
    toolbar({ postures: PAIR, currentId: '1', onSelect })
    // Unfold, because that is what pressing it does from here — see the icon suite below,
    // which asserts the name and the glyph name the same direction.
    expect(postureButton()).toHaveAccessibleName('Unfold: Folded to Unfolded')
    await userEvent.click(postureButton()!)
    expect(onSelect).toHaveBeenCalledWith('2')
  })

  it('toggles back from the other side', async () => {
    const onSelect = vi.fn()
    toolbar({ postures: PAIR, currentId: '2', onSelect })
    await userEvent.click(postureButton()!)
    expect(onSelect).toHaveBeenCalledWith('1')
  })

  it('names the destination even when the current posture is unknown', () => {
    // `currentId` is null when the device reports a posture tapflow cannot reach. The name then
    // says where a press goes without claiming to know where it starts.
    toolbar({ postures: PAIR, currentId: null, onSelect: () => {} })
    expect(postureButton()).toHaveAccessibleName('Fold: Folded')
  })

  it('never empties the live region, so a fold is announced as finishing', () => {
    // **Success-is-silent, which is the shape this toolbar's network control is written to avoid.**
    // The region said `Changing posture` and then fell to `''` whenever the device reported a
    // posture tapflow cannot name — an emptied live region announces nothing, so a screen-reader
    // user heard the fold start and never heard it end, while the spinner turning back into an
    // icon told everyone else. A live region does not announce what it was mounted with, so a
    // non-empty resting value costs nothing.
    const { container } = toolbar({ postures: PAIR, currentId: null, onSelect: () => {} })
    const status = container.querySelector('[role="status"]')
    expect(status).not.toBeNull()
    expect(status!.textContent?.trim()).not.toBe('')
    // **And it names a state, not a completion.** This span is also the button's
    // `aria-describedby` target, so whatever sits here is read on focus: a first draft said
    // `Posture changed`, which told anyone who merely tabbed to the button that a fold had
    // happened, and went on saying it all session.
    expect(status!.textContent).not.toMatch(/chang(ed|e complete)/i)
  })

  it('says a change is happening, and refuses the press while it is', async () => {
    const onSelect = vi.fn()
    toolbar({ postures: PAIR, currentId: '1', pending: true, onSelect })
    const button = screen.getByRole('button', { name: /— changing$/ })
    // **`aria-disabled`, and focusable.** The name changes at the moment of the press, so a
    // `disabled` button drops out of the tab order exactly when it has something to announce —
    // and its `aria-describedby` becomes unreachable with it. The refusal is in behaviour.
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    button.focus()
    expect(button).toHaveFocus()
    await userEvent.click(button)
    // A press that slipped through would fold a device already mid-fold.
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('takes the press again once the device has answered', async () => {
    // The pair for the case above: without it, "does not act while pending" also describes a
    // button that never acts.
    const onSelect = vi.fn()
    toolbar({ postures: PAIR, currentId: '1', pending: false, onSelect })
    await userEvent.click(postureButton()!)
    expect(onSelect).toHaveBeenCalledWith('2')
  })
})

describe('SimulatorToolbar posture icon', () => {
  // lucide names the svg's class after the icon, which is the only handle the DOM gives for it.
  const icon = (c: HTMLElement) => c.querySelector('.lucide-fold-horizontal') ? 'fold'
    : c.querySelector('.lucide-unfold-horizontal') ? 'unfold'
    : c.querySelector('.animate-spin') ? 'spinner' : null

  it('offers to unfold a folded device, and to fold an unfolded one', () => {
    // The icon is the action, which is this toolbar's convention — rotate, screenshot and the
    // recording's stop square all show what the press does rather than the state it is in.
    expect(icon(toolbar({ postures: PAIR, currentId: '1', onSelect: () => {} }).container)).toBe('unfold')
    expect(icon(toolbar({ postures: PAIR, currentId: '2', onSelect: () => {} }).container)).toBe('fold')
  })

  it('names the same direction the icon shows', () => {
    // Asserted together, because they were allowed to disagree: the name opened with `Fold:`
    // whichever way the press went, so a screen reader reading it on a folded device announced
    // the opposite of the icon beside it. One test, so they cannot drift apart again.
    const folded = toolbar({ postures: PAIR, currentId: '1', onSelect: () => {} })
    expect(icon(folded.container)).toBe('unfold')
    expect(folded.getByRole('button', { name: /^Unfold: Folded to Unfolded$/ })).toBeTruthy()

    const open = toolbar({ postures: PAIR, currentId: '2', onSelect: () => {} })
    expect(icon(open.container)).toBe('fold')
    expect(open.getByRole('button', { name: /^Fold: Unfolded to Folded$/ })).toBeTruthy()
  })

  it('does not offer to unfold a device whose posture is unknown', () => {
    // `currentId` is null when the device reports a posture tapflow cannot reach. The destination
    // is then `postures[0]` — the most closed — so Unfold would name the wrong move.
    expect(icon(toolbar({ postures: PAIR, currentId: null, onSelect: () => {} }).container)).toBe('fold')
  })

  it('shows neither while a change is in flight', () => {
    expect(icon(toolbar({ postures: PAIR, currentId: '1', pending: true, onSelect: () => {} }).container))
      .toBe('spinner')
  })
})
