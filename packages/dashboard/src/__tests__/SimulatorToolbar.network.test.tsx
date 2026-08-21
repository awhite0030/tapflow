import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SimulatorToolbar, type NetworkControl } from '@/components/device/shared/SimulatorToolbar'

type RecordState = 'idle' | 'recording' | 'uploading' | 'done'

function toolbar(network?: NetworkControl, recordState: RecordState = 'idle') {
  return render(
    <SimulatorToolbar
      joined
      onScreenshot={() => {}}
      onRecordToggle={() => {}}
      recordState={recordState}
      onRotate={() => {}}
      onDeepLink={() => {}}
      network={network}
    />,
  )
}

const control = (over: Partial<NetworkControl> = {}): NetworkControl =>
  ({ position: 'online', steerable: true, pending: false, onToggle: () => {}, ...over })

/** The button, found by whichever action its current position offers. */
const networkButton = () =>
  screen.queryByRole('button', { name: /(device (offline|online|network)|^Retry: )/ })

/** What the button is called in a given position — read from the render, not restated here. */
function networkButtonName(position: NetworkControl['position']) {
  const { unmount } = toolbar(control({ position }))
  const name = networkButton()!.getAttribute('aria-label')
  unmount()
  return name
}

describe('SimulatorToolbar — the record button it sits beside', () => {
  it('says what each of its four states is, including the two that disable it', () => {
    // A disabled button suppresses pointer events, so Radix never opens its tooltip and never
    // attaches the description — the same #447 gap the network control is built around. While
    // uploading it announced "Start recording, unavailable": the wrong action, and no reason.
    //
    // Mutation: branching the label on `recording` alone fails here.
    const named = (recordState: RecordState) => {
      const { unmount } = toolbar(undefined, recordState)
      const name = screen.getAllByRole('button')
        .map((b) => b.getAttribute('aria-label'))
        .find((n) => n && /record/i.test(n))
      unmount()
      return name
    }
    const names = (['idle', 'recording', 'uploading', 'done'] as const).map(named)
    expect(names.every(Boolean), 'a record state has no name').toBe(true)
    expect(new Set(names).size, 'two record states share a name').toBe(4)
  })
})

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
    expect(named('online')).toBe('Take device offline')
  })

  it('puts no direction in the name of a state it could not read', () => {
    // **The same claim-from-silence, one channel over.** "Take device offline" asserts the device is
    // currently online, which is what `aria-pressed={false}` was dropped for — moving it from the
    // state into the name does not stop it being that claim. The pulse and the muted colour say "we
    // do not know" to anyone who can see them; this says it to everyone else, and unlike the
    // description beside it a name cannot be silenced by a verbosity setting.
    //
    // Mutation: falling back to 'Take device offline' for these two fails here.
    for (const position of ['waiting', 'unknown'] as const) {
      const { unmount } = toolbar(control({ position }))
      expect(networkButton()!.getAttribute('aria-label'), position).toBe('Toggle device network')
      unmount()
    }
  })

  it('announces every position, including the ones that went well', () => {
    // Two failures in one. A live region **inserted** with its first sentence is routinely dropped by
    // NVDA, JAWS and VoiceOver, and a region that **empties** on success announces nothing — so the
    // request was announced starting and never announced finishing, with the failure path the only
    // one that spoke. A name change on an already-focused button does not reliably carry it either.
    //
    // Mutation: clearing the text for `online`/`offline`, or mounting the span only when it has
    // something to say, fails here.
    const said = (position: NetworkControl['position'], pending = false) => {
      const { unmount } = toolbar(control({ position, pending }))
      const text = screen.getByRole('status').textContent
      unmount()
      return text
    }
    const sentences = (['online', 'offline', 'waiting', 'unknown'] as const).map((p) => said(p))
    expect(sentences.every((t) => t && t.trim().length > 0), 'a position says nothing').toBe(true)
    expect(new Set(sentences).size, 'two positions say the same thing').toBe(4)
    expect(said('online', true)).toMatch(/changing/i)
  })

  it('describes each toolbar with its own element', () => {
    // Two viewers on screen would otherwise point both buttons at the first span, so one device's
    // control would be described by another device's network state.
    //
    // Mutation: a literal id makes both ids equal and fails here.
    const { container: a } = toolbar(control({ position: 'unknown' }))
    const { container: b } = toolbar(control({ position: 'waiting' }))
    const idOf = (root: HTMLElement) =>
      root.querySelector('[aria-describedby]')!.getAttribute('aria-describedby')
    expect(idOf(a)).not.toBe(idOf(b))
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
    expect(tip.textContent).toContain('Toggle device network')
    expect(tip.textContent).toContain('No network state has been reported')
  })

  it('describes every position with the sentence for that position', () => {
    // **Every position is described, including the settled ones** — an earlier version of this comment
    // said the opposite and named a mutation that was the shipped code, which is the defect
    // `test-and-guard-coverage.md` §1 is about. The description is the only channel that reaches
    // touch: Radix attaches a tooltip's own `aria-describedby` only while it is open.
    //
    // The id has to resolve to *that position's* sentence, not merely to something. Checking only
    // that an element exists would pass on a span that repeated the button's name, leaving the state
    // said nowhere.
    //
    // Mutation: pointing `aria-describedby` at a span that is not rendered, or rendering the label
    // there instead of the status, fails here.
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
    const seen = new Set<string>()
    for (const p of ['online', 'offline', 'waiting', 'unknown'] as const) {
      const { id, text } = described(p)
      expect(id, `${p} is described by nothing`).not.toBeNull()
      expect(text, `${p} is described by an element that is not there`).not.toBe('<dangling>')
      expect(text, `${p} is described by its own name rather than its state`)
        .not.toBe(networkButtonName(p))
      seen.add(text ?? '')
    }
    expect(seen.size, 'two positions are described the same way').toBe(4)
  })

  it('still shows where the device is when tapflow can no longer move it', () => {
    // **The ratchet this replaced.** `available: false` means "cannot change it", not "cannot read
    // it" — the protocol carries `offline` on that member for exactly this — and an earlier draft
    // rendered it as a position-less state. From there every click asked for offline again, so a
    // device taken offline on a write that could not be confirmed could not be brought back.
    //
    // Mutation: rendering `steerable: false` as `unknown` fails here.
    const { unmount } = toolbar(control({ position: 'offline', steerable: false }))
    // The name says the direction **and** that the last attempt did not land. Putting the caveat only
    // in the description would leave it to a channel a verbosity setting can drop.
    expect(networkButton()!.getAttribute('aria-label')).toBe('Retry: bring device online')
    const id = networkButton()!.getAttribute('aria-describedby')!
    expect(document.getElementById(id)!.textContent).toContain('offline')
    expect(document.getElementById(id)!.textContent).toContain('no longer change')
    unmount()
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

  it('marks the control busy while it refuses clicks', () => {
    // `toggle` returns early for as long as this lasts — up to `NETWORK_REQUEST_DEADLINE_MS`, eight
    // seconds — and neither the swapped icon nor the one-shot live sentence is a property AT can
    // query on the control itself.
    //
    // Mutation: removing `aria-busy` fails here.
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
