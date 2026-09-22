import { describe, it, expect } from 'vitest'
import { useRef } from 'react'
import { render, screen } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { useFocusAfterSwap } from '@/hooks/useFocusAfterSwap'

/**
 * **The hook's contract, held where every branch of it can be reached.**
 *
 * `AppCenter.switch.test.tsx` holds the page, including its one removal-without-a-swap (a row's
 * status being picked). What the page has no way to arrange — a control kept across a swap, a focus
 * dropped by hand in the same commit as a swap, a portal owned by content that is swapped out — is
 * arranged here, where the view the hook keys on and the content that is rendered are separate props.
 * The nine pages still to move off fetch-in-effect will each bring their own views, so the cases
 * below are the ones a mutation of the hook has to fail on, measured one condition at a time.
 */

type Content =
  | 'a' | 'aPortal' | 'b' | 'bFirstOnly' | 'keep' | 'keepPlusOther' | 'empty' | 'skippy'

function Harness({ view, content, withFallback = false }: { view: string; content: Content; withFallback?: boolean }) {
  const fallback = useRef<HTMLInputElement>(null)
  const region = useFocusAfterSwap<HTMLDivElement>(view, withFallback ? fallback : undefined)
  return (
    <>
      <button>outside</button>
      <input ref={fallback} aria-label="fallback" />
      <div {...region}>
        {content === 'a' && <button>a1</button>}
        {content === 'aPortal' && createPortal(<button>in portal</button>, document.body)}
        {/* One slot for the list and its shrunk form, so b1 is the same node in both and only b2
            goes — a row leaving a list. */}
        {(content === 'b' || content === 'bFirstOnly') && [
          <button key="b1">b1</button>,
          content === 'b' ? <button key="b2">b2</button> : null,
        ]}
        {/* Likewise one slot, keyed, so "keep" is the same node in both. Two separate conditionals
            are two slots, and a key does not reach across slots — a first draft did that and
            recreated the button it meant to keep. */}
        {(content === 'keep' || content === 'keepPlusOther') && [
          content === 'keepPlusOther' ? <button key="other">other</button> : null,
          <button key="keep">keep</button>,
        ]}
        {content === 'empty' && <p>nothing to press</p>}
        {content === 'skippy' && (
          <>
            <p tabIndex={-1}>a heading</p>
            <button disabled>off</button>
            <button>on</button>
          </>
        )}
      </div>
    </>
  )
}

const button = (name: string) => screen.getByRole('button', { name })
const microtask = () => Promise.resolve()

describe('useFocusAfterSwap', () => {
  it('moves focus to the first control when a swap removed the element that had it', () => {
    const { rerender } = render(<Harness view="one" content="a" />)
    button('a1').focus()

    rerender(<Harness view="two" content="b" />)

    expect(button('b1')).toHaveFocus()
  })

  it('counts focus inside a portal the region owns as the region\'s', () => {
    // A popover opened from a row lives under `body` in the DOM and inside the row in React. A swap
    // takes it with its owner — and a DOM `contains` check says it was never inside.
    const { rerender } = render(<Harness view="one" content="aPortal" />)
    button('in portal').focus()

    rerender(<Harness view="two" content="b" />)

    expect(button('b1')).toHaveFocus()
  })

  it('does not act when an element is removed without the view changing', () => {
    // **The case the second design broke.** Picking a row's status removes the Select's content —
    // focus drops to `body` — and Radix puts it back on the trigger a macrotask later. A commit of
    // the page in between is not a swap, and must not move focus anywhere.
    const { rerender } = render(<Harness view="list" content="b" />)
    button('b2').focus()

    rerender(<Harness view="list" content="bFirstOnly" />)

    expect(document.body).toHaveFocus()
  })

  it('forgets a removal that was not a swap, so a later swap does not act on it', () => {
    // Otherwise the record outlives the thing it was about, and some unrelated swap later — a
    // refresh minutes on — pulls focus into the region on its strength.
    const { rerender } = render(<Harness view="list" content="b" />)
    button('b2').focus()
    rerender(<Harness view="list" content="bFirstOnly" />)

    rerender(<Harness view="other" content="a" />)

    expect(document.body).toHaveFocus()
  })

  it('leaves focus alone when the element that had it survived the swap', () => {
    const { rerender } = render(<Harness view="one" content="keep" />)
    const kept = button('keep')
    kept.focus()

    rerender(<Harness view="two" content="keepPlusOther" />)

    // Same node, or this is not the case it claims to be.
    expect(button('keep')).toBe(kept)
    expect(kept).toHaveFocus()
  })

  it('does not act on an element still in the document, even with focus on body at the swap', () => {
    // Focus dropped by hand in the same task as a swap that keeps the element — before the
    // `focusout` check has run. The element is still there, so nothing was taken.
    const { rerender } = render(<Harness view="one" content="keep" />)
    button('keep').focus()
    button('keep').blur()

    rerender(<Harness view="two" content="keepPlusOther" />)

    expect(document.body).toHaveFocus()
  })

  it('does not reclaim focus that had already moved out of the region', () => {
    const { rerender } = render(<Harness view="one" content="a" />)
    button('a1').focus()
    button('outside').focus()
    button('outside').blur()

    rerender(<Harness view="two" content="b" />)

    expect(document.body).toHaveFocus()
  })

  it('forgets focus that was left without moving anywhere', async () => {
    // Safari and Firefox on macOS do not focus a clicked button, so clicking one outside drops focus
    // to `body` with no `focusin` to clear the record. `blur()` is that drop.
    const { rerender } = render(<Harness view="one" content="a" />)
    button('a1').focus()
    button('a1').blur()
    await microtask()

    rerender(<Harness view="two" content="b" />)

    expect(document.body).toHaveFocus()
  })

  it('takes no focus when nothing had been focused', () => {
    const { rerender } = render(<Harness view="one" content="a" />)

    rerender(<Harness view="two" content="b" />)

    expect(document.body).toHaveFocus()
  })

  it('leaves focus on body when the new view has nothing to press and there is no fallback', () => {
    const { rerender } = render(<Harness view="one" content="a" />)
    button('a1').focus()

    rerender(<Harness view="two" content="empty" />)

    expect(document.body).toHaveFocus()
  })

  it('sends focus to the fallback when the new view has nothing to press', () => {
    const { rerender } = render(<Harness view="one" content="a" withFallback />)
    button('a1').focus()

    rerender(<Harness view="two" content="empty" withFallback />)

    expect(screen.getByRole('textbox', { name: 'fallback' })).toHaveFocus()
  })

  it('prefers a control in the new view over the fallback', () => {
    const { rerender } = render(<Harness view="one" content="a" withFallback />)
    button('a1').focus()

    rerender(<Harness view="two" content="b" withFallback />)

    expect(button('b1')).toHaveFocus()
  })

  it('lands on a control that can act, past a tabIndex={-1} element and a disabled button', () => {
    // The `tabIndex={-1}` exclusion is what keeps "a control, not a heading" true, and the disabled
    // one is what keeps focus off something that cannot be pressed.
    const { rerender } = render(<Harness view="one" content="a" />)
    button('a1').focus()

    rerender(<Harness view="two" content="skippy" />)

    expect(button('on')).toHaveFocus()
  })

  it('sends focus to the fallback when an element leaves without a view swap', () => {
    const { rerender } = render(<Harness view="list" content="b" withFallback />)
    button('b2').focus()

    rerender(<Harness view="list" content="bFirstOnly" withFallback />)

    expect(screen.getByRole('textbox', { name: 'fallback' })).toHaveFocus()
  })
})
