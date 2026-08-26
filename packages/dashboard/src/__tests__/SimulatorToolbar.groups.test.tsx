// The toolbar's four groups, in the order a tester works through them (#634).
//
// **This exists because the grouping had no enforcement and no record.** Reordering every Android
// button into one group left the whole dashboard suite green — the buttons were arranged by a
// criterion nobody had written down, so nothing could notice it changing. The rule now lives in
// `packages/dashboard/AGENTS.md` → "Where a new device button goes", and this is what holds it.
//
// Asserted as **relative order in the accessibility tree**, not as a count or a snapshot: a count
// passes on buttons in the wrong groups, and a snapshot fails on every unrelated style change and
// gets updated without being read.
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { SimulatorToolbar } from '@/components/device/shared/SimulatorToolbar'

/** Stand-ins for what the viewers pass, labelled so the assertions read as the rule does. */
const navButtons = <button aria-label="Home" />
const deviceButtons = <button aria-label="Software keyboard" />

function toolbar() {
  return render(
    <SimulatorToolbar
      joined
      onScreenshot={() => {}}
      onRecordToggle={() => {}}
      recordState="idle"
      onRotate={() => {}}
      onDeepLink={() => {}}
      navigationSlot={navButtons}
      deviceSlot={deviceButtons}
      network={{ position: 'online', steerable: true, pending: false, onToggle: () => {} }}
    />,
  )
}

/** Where each button sits in the rendered order, by accessible name. */
function positions() {
  const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '')
  return (label: RegExp) => names.findIndex((n) => label.test(n))
}

describe('the device toolbar groups by what the tester is doing to the device', () => {
  it('runs Navigation → Device → Capture → Environment', () => {
    toolbar()
    const at = positions()
    const navigation = at(/^Home$/)
    const device = at(/Software keyboard/)
    const rotate = at(/Rotate/)
    const capture = at(/screenshot/i)
    const environment = at(/device (offline|online|network)/i)

    for (const [name, i] of Object.entries({ navigation, device, rotate, capture, environment })) {
      expect(i, `${name} is not rendered at all`).toBeGreaterThan(-1)
    }
    expect(navigation).toBeLessThan(device)
    expect(device).toBeLessThan(rotate)
    expect(rotate, 'rotate leaves the device in a condition, so it closes the Device group')
      .toBeLessThan(capture)
    expect(capture).toBeLessThan(environment)
  })

  it('exists in the accessibility tree, not only as a line on screen', () => {
    // **The dividers are `<div>`s with a background colour.** Without a role and a name the four
    // groups this whole change is about are, to a screen reader or voice control, one flat run of
    // icon buttons — and the order assertion above would pass over exactly that.
    toolbar()
    const groups = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))
    expect(groups).toEqual(['Navigation', 'Device', 'Capture', 'Environment'])
  })

  it('puts each button in the group the rule assigns it to', () => {
    // Order alone does not say which side of a boundary a button is on. This is what fails when a
    // button drifts one group over — which is the change the rule exists to make a decision.
    toolbar()
    const group = (name: string) => within(screen.getByRole('group', { name }))
    expect(group('Navigation').getByRole('button', { name: /^Home$/ })).toBeTruthy()
    expect(group('Navigation').getByRole('button', { name: /deeplink/i })).toBeTruthy()
    expect(group('Device').getByRole('button', { name: /Software keyboard/ })).toBeTruthy()
    expect(group('Device').getByRole('button', { name: /Rotate/ })).toBeTruthy()
    expect(group('Capture').getByRole('button', { name: /screenshot/i })).toBeTruthy()
    expect(group('Environment').getByRole('button', { name: /device (offline|online|network)/i })).toBeTruthy()
  })

  it('keeps the deeplink in Navigation rather than with the tools', () => {
    // From the tester's side this is "go to this screen", not "type a URL" — the one placement the
    // issue called out as genuinely arguable, so it is the one worth pinning.
    toolbar()
    const at = positions()
    expect(at(/deeplink/i)).toBeGreaterThan(at(/^Home$/))
    expect(at(/deeplink/i), 'the deeplink drifted into Capture').toBeLessThan(at(/screenshot/i))
  })

  it('puts the network control last, alone in Environment', () => {
    toolbar()
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '')
    expect(names.at(-1), 'Environment is the last group and the network control is its only member')
      .toMatch(/device (offline|online|network)/i)
  })
})
