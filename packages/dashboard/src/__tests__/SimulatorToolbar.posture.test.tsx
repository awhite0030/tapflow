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

// A device that offers more — flipped, tent — gets the menu instead.
const FOLD = [
  { id: '1', label: 'Folded' },
  { id: '2', label: 'Unfolded' },
  { id: '4', label: 'Flipped' },
]

type Posture = { postures: typeof FOLD; currentId: string | null; pending?: boolean; onSelect: (id: string) => void }

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
    toolbar({ postures: [FOLD[0]!], currentId: '1', onSelect: () => {} })
    expect(postureButton()).toBeNull()
  })

  it('toggles directly when there are two — no menu for a single alternative', async () => {
    const onSelect = vi.fn()
    toolbar({ postures: PAIR, currentId: '1', onSelect })
    // Unfold, because that is what pressing it does from here — see the icon suite below,
    // which asserts the name and the glyph name the same direction.
    expect(postureButton()).toHaveAccessibleName('Unfold: Folded to Unfolded')
    await userEvent.click(postureButton()!)
    expect(onSelect).toHaveBeenCalledWith('2')
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
  })

  it('toggles back from the other side', async () => {
    const onSelect = vi.fn()
    toolbar({ postures: PAIR, currentId: '2', onSelect })
    await userEvent.click(postureButton()!)
    expect(onSelect).toHaveBeenCalledWith('1')
  })

  it('names the posture the device is in', () => {
    toolbar({ postures: FOLD, currentId: '2', onSelect: () => {} })
    expect(postureButton()).toHaveAccessibleName('Posture: Unfolded')
  })

  it('offers every posture, in the order the agent sent', async () => {
    toolbar({ postures: FOLD, currentId: '1', onSelect: () => {} })
    await userEvent.click(postureButton()!)
    // A menu rather than a cycle: `Half open` and `Unfolded` present the same screen on a real
    // foldable, so stepping between them changed nothing and read as a press that was dropped.
    expect(screen.getAllByRole('menuitemradio').map((el) => el.textContent))
      .toEqual(['Folded', 'Unfolded', 'Flipped'])
  })

  it('marks the current posture in the menu', async () => {
    toolbar({ postures: FOLD, currentId: '4', onSelect: () => {} })
    await userEvent.click(postureButton()!)
    expect(screen.getByRole('menuitemradio', { name: 'Flipped' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: 'Folded' })).toHaveAttribute('aria-checked', 'false')
  })

  it('reaches any posture in one press, including a non-adjacent one', async () => {
    const onSelect = vi.fn()
    toolbar({ postures: FOLD, currentId: '1', onSelect })
    await userEvent.click(postureButton()!)
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Flipped' }))
    expect(onSelect).toHaveBeenCalledWith('4')
  })

  it('says a change is happening and refuses to open while it is', async () => {
    const onSelect = vi.fn()
    toolbar({ postures: FOLD, currentId: '1', pending: true, onSelect })
    const button = screen.getByRole('button', { name: /— changing$/ })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(button)
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
  })

  it('opens again once the device has answered', async () => {
    // The pair: without it, "does not open while pending" also describes a button that never opens.
    toolbar({ postures: FOLD, currentId: '1', pending: false, onSelect: () => {} })
    await userEvent.click(postureButton()!)
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3)
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

  it('shows the same two on a device with a menu', () => {
    // At the most closed posture the only move is to open; anywhere else, folding is available.
    expect(icon(toolbar({ postures: FOLD, currentId: '1', onSelect: () => {} }).container)).toBe('unfold')
    expect(icon(toolbar({ postures: FOLD, currentId: '4', onSelect: () => {} }).container)).toBe('fold')
  })

  it('does not offer to unfold a device whose posture is unknown', () => {
    // `currentId` is null when the device reports a posture tapflow cannot reach. The pair's
    // destination is then `postures[0]` — the most closed — so Unfold would name the wrong move.
    expect(icon(toolbar({ postures: PAIR, currentId: null, onSelect: () => {} }).container)).toBe('fold')
    expect(icon(toolbar({ postures: FOLD, currentId: null, onSelect: () => {} }).container)).toBe('fold')
  })

  it('shows neither while a change is in flight', () => {
    expect(icon(toolbar({ postures: PAIR, currentId: '1', pending: true, onSelect: () => {} }).container))
      .toBe('spinner')
  })
})
