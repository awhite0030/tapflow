import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SimulatorToolbar, type NetworkControl } from '@/components/device/shared/SimulatorToolbar'

function toolbar(network?: NetworkControl) {
  return render(
    <SimulatorToolbar
      joined
      onScreenshot={() => {}}
      onRecordToggle={() => {}}
      recordState="idle"
      onRotate={() => {}}
      onDeepLink={() => {}}
      network={network}
    />,
  )
}

const control = (over: Partial<NetworkControl> = {}): NetworkControl =>
  ({ position: 'online', pending: false, onToggle: () => {}, ...over })

/** The button, found by the one name it keeps in every position. */
const networkButton = () => screen.queryByRole('button', { name: 'Take device offline' })

describe('SimulatorToolbar — network control', () => {
  it('renders nothing when the agent did not say it could do this', () => {
    // The gate, and the control for every assertion below: without it they pass on a toolbar that
    // renders the button unconditionally, which is the shape #447 exists to prevent — a control
    // offered for an agent that has no code behind it.
    //
    // Mutation: rendering the block without the `network &&` guard fails here.
    toolbar(undefined)
    expect(networkButton()).toBeNull()
    // …and the rest of the toolbar is unaffected, so this is not passing on an empty render.
    expect(screen.getByRole('button', { name: /rotate/i })).toBeTruthy()
  })

  it('renders when it did', () => {
    toolbar(control())
    expect(networkButton()).toBeTruthy()
  })

  it('keeps one name across every position, and says the state in aria-pressed', () => {
    // The APG shape for a toggle. A name that flipped between "Device is offline" and "Take device
    // offline" leaves voice control with no stable phrase to say, and when offline it never says what
    // activating the button does.
    const names = (['online', 'offline', 'waiting', 'unknown'] as const).map((position) => {
      const { unmount } = toolbar(control({ position }))
      const name = networkButton()!.getAttribute('aria-label')
      unmount()
      return name
    })
    expect(new Set(names).size, 'the name moved with the position').toBe(1)
  })

  it('explains the two positions it cannot draw, outside the tooltip', () => {
    // The tooltip is not a channel here: Radix attaches its `aria-describedby` only while open, and
    // on touch it never opens. So `waiting` and `unknown` each carry a described-by of their own, and
    // the positions that need no explanation carry none.
    //
    // Mutation: rendering one shared sentence for both, or leaving `aria-describedby` on when the
    // state is known, fails here.
    // **The id and the text, not the text alone.** An earlier version resolved the attribute through
    // `getElementById` and returned `null` when it pointed at nothing — so a control that always
    // carried `aria-describedby`, dangling at an element that is not rendered, read as having none.
    // AT announces a dangling reference as no description, which is the same *outcome* and a
    // different defect; the mutation that produced it survived until this looked at both.
    const described = (position: NetworkControl['position']) => {
      const { unmount } = toolbar(control({ position }))
      const id = networkButton()!.getAttribute('aria-describedby')
      const text = id === null ? null : document.getElementById(id)?.textContent ?? '<dangling>'
      unmount()
      return { id, text }
    }
    expect(described('online').id, 'described by an element that is not there').toBeNull()
    expect(described('offline').id).toBeNull()
    const waiting = described('waiting')
    const unknown = described('unknown')
    expect(waiting.text).toBeTruthy()
    expect(unknown.text).toBeTruthy()
    expect(waiting.text, 'waiting and unknown say the same thing').not.toBe(unknown.text)
  })

  it('leaves the button usable in every position, including the ones it cannot read', () => {
    // **The #447 resolution.** A disabled control owes a reason it cannot give here, and an absent one
    // cannot come back: the click is the only thing that produces a fresh `network:state`, so hiding
    // the control when the state goes unreadable would strand the session. Staying clickable is what
    // makes `unknown` a position to work from rather than a dead end.
    //
    // Mutation: `disabled={position === 'unknown'}` fails here.
    for (const position of ['online', 'offline', 'waiting', 'unknown'] as const) {
      const { unmount } = toolbar(control({ position }))
      expect((networkButton() as HTMLButtonElement).disabled, position).toBe(false)
      unmount()
    }
  })

  it('leaves aria-pressed absent where there is no state to report', () => {
    // **`false` is not "unknown".** It asserts the device is on the network, which is the claim this
    // design refuses to make from silence — the same boolean collapse the agent shipped on the other
    // side of this wire, arriving through ARIA instead of through state. Absent is how the platform
    // spells "this toggle has no state".
    //
    // Mutation: `aria-pressed={position === 'offline'}` reads `"false"` for the last two and fails.
    for (const [position, pressed] of [
      ['offline', 'true'], ['online', 'false'], ['waiting', null], ['unknown', null],
    ] as const) {
      const { unmount } = toolbar(control({ position }))
      expect(networkButton()!.getAttribute('aria-pressed'), position).toBe(pressed)
      unmount()
    }
  })

  it('says a request is in flight', () => {
    // The icon is swapped for a bare spinner, which nothing reads out. Without this a screen-reader
    // user hears nothing between the click and the answer.
    const { unmount } = toolbar(control({ pending: true }))
    expect(networkButton()!.getAttribute('aria-busy')).toBe('true')
    unmount()
    toolbar(control({ pending: false }))
    expect(networkButton()!.getAttribute('aria-busy')).toBe('false')
  })

  it('passes the click through', async () => {
    const onToggle = vi.fn()
    toolbar(control({ onToggle }))
    await userEvent.click(networkButton()!)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('keeps its name while a request is in flight', async () => {
    // The spinner replaces the icon, not the label — an icon-only control that loses its accessible
    // name mid-request is unreachable for the duration.
    toolbar(control({ position: 'offline', pending: true }))
    expect(networkButton()).toBeTruthy()
  })
})
