import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AreaChartInner } from '@/src/pages/MacResources'

// **The series is clipped to the plot, and this is what says so.** The window's right edge is rounded *up*
// to a clean tick so the times stay round (`ceil(now / step) * step`), which pushes its left edge up to one
// step later than the oldest sample the relay returns — the API selects from `now - interval`, the chart
// draws from `ceil(now/step)*step - interval`. On the 1h range that is 10 minutes of points sitting left of
// the y-axis, and `scaleTime` does not clamp: they map to a negative x and the area painted straight
// through the tick labels. It showed worst on RAM, which sits at ~57% right where "50%" and "25%" are.
//
// Rendered directly rather than through the page: `ParentSize` measures 0 in jsdom, so `ChartCard` renders
// nothing there and a test of the page would assert against an empty div.

const AT = Date.parse('2026-08-18T02:55:00.000Z')
const STEP = 600_000 // the 1h range's tick step

/** One sample per minute across the last hour — which starts before the rounded-up window does. */
const series = Array.from({ length: 60 }, (_, i) => {
  const t = AT - (59 - i) * 60_000
  return { time: new Date(t).toISOString(), cpu: 20, mem: 57 }
})

const paths = (c: HTMLElement) => [...c.querySelectorAll('path')].map((p) => p.getAttribute('d') ?? '')
const xs = (d: string) => [...d.matchAll(/[ML]\s*(-?[\d.]+)/g)].map((m) => Number(m[1]))

describe('the resource chart does not paint over its own axis', () => {
  it('has samples that fall left of the plot — the premise, measured', () => {
    // Without this the test below could pass on a chart that simply has nothing to clip.
    const maxT = Math.ceil(AT / STEP) * STEP
    const minT = maxT - 3_600_000
    const before = series.filter((d) => Date.parse(d.time) < minT)
    expect(before.length, 'no sample precedes the window — pick an `AT` that is not on a step boundary')
      .toBeGreaterThan(0)
  })

  it('draws the series inside a clip that starts at the axis', () => {
    const { container } = render(
      <AreaChartInner width={600} height={220} data={series} dataKey="cpu" hex="#60a5fa" range="1h" now={AT} label="CPU %" />,
    )

    const clipped = container.querySelector('g[clip-path]')
    expect(clipped, 'the series is not clipped').not.toBeNull()
    expect(clipped!.querySelectorAll('path').length, 'the area and the line are both inside the clip').toBe(2)

    const rect = container.querySelector('clipPath rect')!
    expect(rect.getAttribute('x'), 'the clip must start at the axis, not left of it').toBe('0')
    expect(Number(rect.getAttribute('width'))).toBeGreaterThan(0)
  })

  it('and the geometry it clips really does reach past the axis', () => {
    // The other half: if the scale ever started clamping, the clip would be inert and this file would go on
    // reporting success for a fix that no longer does anything.
    const { container } = render(
      <AreaChartInner width={600} height={220} data={series} dataKey="mem" hex="#a78bfa" range="1h" now={AT} label="RAM %" />,
    )
    const drawn = paths(container).flatMap(xs)
    expect(drawn.length, 'no path geometry was rendered').toBeGreaterThan(0)
    expect(Math.min(...drawn), 'nothing extends past the axis — the clip is guarding nothing').toBeLessThan(0)
  })
})

describe('the chart can be read without a mouse', () => {
  // The tooltip is the only place a reading is written down, and it opened on `mousemove` alone — so the
  // page was unreadable to a keyboard user, which is what the a11y gate blocked this change on. Held here
  // rather than left to the gate: the gate reads a diff, and nothing would fail once the file stops changing.
  const setup = () =>
    render(
      <AreaChartInner width={600} height={220} data={series} dataKey="cpu" hex="#60a5fa" range="1h" now={AT} label="CPU %" />,
    )
  const surfaceOf = (c: HTMLElement) => c.querySelector('rect[role="slider"]')!

  it('exposes the cursor as a slider, which is the role whose key model is the arrow keys', () => {
    // **Not `img` or `application`.** A non-widget role leaves NVDA and JAWS in browse mode, where the
    // virtual cursor takes the arrow keys before `onKeyDown` ever runs — the keyboard path would exist and
    // be unreachable for the users it was built for. The reading rides on `aria-valuetext`, so there is no
    // live region to keep in step with it.
    const { container } = setup()
    const surface = surfaceOf(container)
    expect(surface.getAttribute('tabindex')).toBe('0')
    expect(surface.getAttribute('aria-valuemax')).toBe(String(series.length - 1))
    expect(surface.getAttribute('aria-valuetext')).toMatch(/CPU %/)
  })

  it('the arrows walk the series and Escape dismisses the reading', () => {
    const { container } = setup()
    const surface = surfaceOf(container)

    fireEvent.focus(surface)
    const atFocus = surface.getAttribute('aria-valuenow')
    expect(surface.getAttribute('aria-valuetext')).toMatch(/\d+%/)

    fireEvent.keyDown(surface, { key: 'ArrowLeft' })
    expect(surface.getAttribute('aria-valuenow'), 'ArrowLeft did not move the cursor').not.toBe(atFocus)

    fireEvent.keyDown(surface, { key: 'Home' })
    expect(surface.getAttribute('aria-valuenow')).toBe('0')

    // Dismissible without moving focus (WCAG 1.4.13) — the reading overlays the plot.
    fireEvent.keyDown(surface, { key: 'Escape' })
    expect(container.querySelector('[class*="pointer-events-none"]'), 'Escape left the reading up').toBeNull()
  })

  it('names itself with the title the card shows', () => {
    // The page passes its visible card title (`CPU %`), not the legend key (`CPU`) — asserting the latter
    // would check a string the page never produces and would miss the name drifting from what is on screen.
    const { container } = setup()
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toMatch(/^CPU %, last 1h/)
    expect(surfaceOf(container).getAttribute('aria-label')).toBe('CPU % samples')
  })

  it('keeps the cursor where the reader left it when the overlay is dismissed', () => {
    // Derived from `tooltipData`, every path that hid the reading — Escape, blur — snapped the announced
    // value back to the last sample: a change nobody made, and the next arrow key resumed from the end.
    const { container } = setup()
    const surface = surfaceOf(container)

    fireEvent.focus(surface)
    fireEvent.keyDown(surface, { key: 'Home' })
    expect(surface.getAttribute('aria-valuenow')).toBe('0')
    fireEvent.keyDown(surface, { key: 'Escape' })
    expect(surface.getAttribute('aria-valuenow'), 'Escape moved the cursor').toBe('0')
    fireEvent.blur(surface)
    expect(surface.getAttribute('aria-valuenow'), 'blur moved the cursor').toBe('0')
  })

  it('answers the vertical arrows too, which are half of the slider key set', () => {
    const { container } = setup()
    const surface = surfaceOf(container)
    fireEvent.focus(surface)
    fireEvent.keyDown(surface, { key: 'Home' })
    fireEvent.keyDown(surface, { key: 'ArrowUp' })
    expect(surface.getAttribute('aria-valuenow'), 'ArrowUp did not move the cursor').toBe('1')
    fireEvent.keyDown(surface, { key: 'ArrowDown' })
    expect(surface.getAttribute('aria-valuenow')).toBe('0')
  })

  it('keeps the announced value inside the series when the range shrinks under it', () => {
    // Switching 7d → 1h leaves a cursor that was valid pointing past the end. Unclamped, `aria-valuenow`
    // sat above `aria-valuemax` with no `aria-valuetext` at all — a slider announcing an index.
    const { container, rerender } = setup()
    const surface = surfaceOf(container)
    fireEvent.focus(surface)
    fireEvent.keyDown(surface, { key: 'End' })
    expect(surface.getAttribute('aria-valuenow')).toBe(String(series.length - 1))

    rerender(
      <AreaChartInner width={600} height={220} data={series.slice(0, 3)} dataKey="cpu" hex="#60a5fa" range="1h" now={AT} label="CPU %" />,
    )
    const after = surfaceOf(container)
    expect(Number(after.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(Number(after.getAttribute('aria-valuemax')))
    expect(after.getAttribute('aria-valuetext'), 'the reading went missing').toMatch(/CPU %/)
  })

  it('returns focus to where the reader left the cursor, not to the end', () => {
    // Focus used to select the newest sample every time, so Escape (or tabbing away) and coming back moved
    // the reader to the other end of the series without a keypress — and the next arrow stepped from there.
    const { container } = setup()
    const surface = surfaceOf(container)

    fireEvent.focus(surface)
    expect(surface.getAttribute('aria-valuenow'), 'the first focus should open at the newest sample')
      .toBe(String(series.length - 1))
    fireEvent.keyDown(surface, { key: 'Home' })
    fireEvent.keyDown(surface, { key: 'ArrowRight' })
    expect(surface.getAttribute('aria-valuenow')).toBe('1')

    fireEvent.blur(surface)
    fireEvent.focus(surface)
    expect(surface.getAttribute('aria-valuenow'), 'refocus jumped the reader to the end').toBe('1')
  })

  it('tells adjacent samples apart on every range', () => {
    // `formatTick` is the axis format: on 7d it is the date alone, so every sample in a day announced
    // identically and arrowing between neighbours sounded like nothing had moved. The visible tooltip is
    // `aria-hidden`, so this string is the only reading AT gets.
    const { container } = render(
      <AreaChartInner width={600} height={220} data={series} dataKey="cpu" hex="#60a5fa" range="7d" now={AT} label="CPU %" />,
    )
    const surface = surfaceOf(container)
    fireEvent.focus(surface)
    const first = surface.getAttribute('aria-valuetext')
    fireEvent.keyDown(surface, { key: 'ArrowLeft' })
    expect(surface.getAttribute('aria-valuetext'), 'two samples announce the same thing').not.toBe(first)
  })

  it('announces exactly what it draws', () => {
    // The tooltip is `aria-hidden`, so `aria-valuetext` is the only reading AT gets — and the two used to
    // be formatted separately, diverging first on the date and then on precision (57.4% drawn, "57%"
    // announced). One formatter, asserted against a fractional value so a rounding difference would show.
    const fractional = [{ time: series[0]!.time, cpu: 57.4, mem: 57.4 }, { time: series[1]!.time, cpu: 12.3, mem: 12.3 }]
    const { container } = render(
      <AreaChartInner width={600} height={220} data={fractional} dataKey="cpu" hex="#60a5fa" range="1h" now={AT} label="CPU %" />,
    )
    const surface = surfaceOf(container)
    fireEvent.focus(surface)
    fireEvent.keyDown(surface, { key: 'Home' })

    const announced = surface.getAttribute('aria-valuetext') ?? ''
    expect(announced).toContain('57.4%')
    const drawn = container.querySelector('[aria-hidden="true"]')?.textContent ?? ''
    expect(drawn, 'the drawn reading disagrees with the announced one').toContain('57.4%')

    // The third rendering of the same number: the chart's own summary name, which a reader hears on the
    // way in. It rounded to an integer while both of the above kept a digit.
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toContain('12.3%')
  })

  it('does not paint an outline until focus asks for one', () => {
    // `outline-none` is a *transparent* 2px outline, so colouring it inline drew a black box around every
    // plot at rest — reported from a screenshot, not by any gate.
    const surface = surfaceOf(setup().container)
    expect(surface.getAttribute('style') ?? '', 'an inline outline colour is visible at rest').not.toMatch(/outline/i)
    expect(surface.getAttribute('class') ?? '').toMatch(/focus-visible:outline/)
  })
})
