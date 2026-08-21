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

/** The button, found by whichever action its current position offers. */
const networkButton = () =>
  screen.queryByRole('button', { name: /device (offline|online)$/ })

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

  it('names the action rather than the state, and never offers the one already done', () => {
    // A name that said the state ("Device is offline") never tells the user what clicking does, and a
    // fixed action name offers "Take device offline" to a device that already is. The name is the
    // action available *from here*.
    //
    // Mutation: a constant label fails the offline case.
    const named = (position: NetworkControl['position']) => {
      const { unmount } = toolbar(control({ position }))
      const name = networkButton()!.getAttribute('aria-label')
      unmount()
      return name
    }
    expect(named('offline')).toBe('Bring device online')
    for (const p of ['online', 'waiting', 'unknown'] as const) expect(named(p)).toBe('Take device offline')
  })

  it('says nothing about pressedness, in either direction', () => {
    // **`aria-pressed` was tried and dropped.** The name already carries the state as an action, so
    // adding it says the same fact in two grammars — and `false` in the two positions this design
    // refuses to draw would assert the device is on the network, which is the claim the whole thing
    // exists to avoid making from silence.
    //
    // Mutation: `aria-pressed={position === 'offline'}` fails here.
    for (const position of ['online', 'offline', 'waiting', 'unknown'] as const) {
      const { unmount } = toolbar(control({ position }))
      expect(networkButton()!.getAttribute('aria-pressed'), position).toBeNull()
      unmount()
    }
  })

  it('shows the action in the tooltip too, so what is said matches what is read', async () => {
    // WCAG 2.5.3: the visible label has to contain the accessible name, or a voice-control user says
    // what they see and hits nothing. The status is appended rather than substituted for it.
    //
    // Mutation: rendering `status` alone in the tooltip fails here.
    toolbar(control({ position: 'unknown' }))
    // Radix keeps `TooltipContent` out of the DOM until it opens, so this has to hover rather than
    // query — a `getByText` here would assert on a node that never exists and fail for the wrong reason.
    await userEvent.hover(networkButton()!)
    const tip = await screen.findByRole('tooltip')
    expect(tip.textContent).toContain('Take device offline')
    expect(tip.textContent).toContain('could not be read')
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

  it('says a request is in flight, in the channel that is actually announced', () => {
    // The icon is swapped for a bare spinner, which nothing reads out — and `aria-busy` on a button is
    // not spoken by NVDA, VoiceOver or JAWS. The live region is, so that is where the sentence goes.
    //
    // Mutation: relying on `aria-busy` alone leaves nothing to find here.
    toolbar(control({ position: 'online', pending: true }))
    const live = screen.getByRole('status')
    expect(live.textContent).toMatch(/changing/i)
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
