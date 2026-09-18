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

const postureButton = () => screen.queryByRole('button', { name: /^(Posture|Fold)/ })

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
    expect(postureButton()).toHaveAccessibleName('Fold: Folded to Unfolded')
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

// The rule the viewer uses to decide whether the picture is showable: does the frame, once the
// agent's correction is applied, describe the same screen `session:chrome` does? Kept as a unit
// because the flash lives in the window where the answer is no, and that window is the only thing
// a duration was ever standing in for.
describe('frame/screen agreement', () => {
  const agrees = (
    video: { width: number; height: number },
    shown: { width: number; height: number },
    streamRotation: 0 | 90 | 180 | 270,
  ) => {
    const quarter = streamRotation === 90 || streamRotation === 270
    const frameW = quarter ? video.height : video.width
    const frameH = quarter ? video.width : video.height
    return Math.abs(frameW / frameH - shown.width / shown.height) < 0.05
  }

  it('agrees once the fold has settled — folded', () => {
    // Measured: the cover panel streams 2424x1080 while Android draws 1080x2424, corrected by 270.
    expect(agrees({ width: 2424, height: 1080 }, { width: 1080, height: 2424 }, 270)).toBe(true)
  })

  it('agrees once the fold has settled — unfolded', () => {
    // Unfolded the skin and the display agree, so there is no correction to apply.
    expect(agrees({ width: 2152, height: 2076 }, { width: 2152, height: 2076 }, 0)).toBe(true)
  })

  it('disagrees in the window the flash lives in', () => {
    // Mid-fold: the stream is already the cover panel, the chrome still describes the inner one.
    expect(agrees({ width: 2424, height: 1080 }, { width: 2152, height: 2076 }, 0)).toBe(false)
    // And the other way, unfolding.
    expect(agrees({ width: 2152, height: 2076 }, { width: 1080, height: 2424 }, 270)).toBe(false)
  })

  it('tolerates the encoder\'s 16-pixel alignment', () => {
    // A 2076-wide panel is encoded 2080 wide; that is not a disagreement.
    expect(agrees({ width: 2080, height: 2152 }, { width: 2076, height: 2152 }, 0)).toBe(true)
  })

  it('tolerates a downscaled stream, which keeps the ratio', () => {
    // Server-side resize halves the frame; the screen it depicts is unchanged.
    expect(agrees({ width: 1212, height: 540 }, { width: 1080, height: 2424 }, 270)).toBe(true)
  })
})
