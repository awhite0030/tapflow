import { useCallback, useEffect, useLayoutEffect, useRef, type FocusEvent, type RefObject } from 'react'

const FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/**
 * **Puts focus back when swapping a region's view removed the element that had it** (#829).
 *
 * Replacing one view with another — a list with its failure, the failure with the list a retry
 * brought back — unmounts whatever inside had focus, and the browser drops it on `document.body`.
 * A keyboard or screen-reader user is returned to the top of the document with nothing said about
 * why.
 *
 * Spread the returned props onto the element holding the region's views, and pass `view` as the name
 * of whichever one is showing. Focus moves only when a commit both changed `view` and removed the
 * element that last had focus in the region, and focus is now on `body`. It goes to the first control
 * in the new view, or to `fallback` when the view has none.
 *
 * **Both halves in the same commit, and that is the whole design.** A second version dropped the view
 * and acted on any removal. That reached more cases and broke the most common one: picking a row's
 * status unmounts the `Select`'s content, focus drops to `body`, and Radix hands it back to the
 * trigger a macrotask later — but the status mutation notifies first, so the page commits in between
 * and a hook acting on any removal pulled focus to the first release, scrolling the list to the top
 * under a mouse user. A removal that is not a swap belongs to whatever caused it: Radix returns its
 * own focus, and a row that leaves a list needs a decision about its neighbours this hook cannot make
 * (#833).
 * So the record is decided on at the first commit after the removal, and dropped unless that commit
 * was the swap.
 *
 * **"Had focus in the region" follows the React tree, not the DOM.** A popover opened from a row
 * renders in a portal under `body`, so `region.contains(activeElement)` says it is outside while the
 * swap still takes it with its owner. React's `onFocus` bubbles through portals and records the
 * element; a capture-phase `focusin` on the document, which runs before React's own listener on the
 * root, clears the record first on every real move.
 *
 * **Leaving without moving clears it too.** Safari and Firefox on macOS do not focus a button that is
 * clicked, so clicking one elsewhere drops focus to `body` with no `focusin` — and the record would
 * then claim a focus the user had deliberately left. A `focusout` with nowhere to go clears it a
 * microtask later if focus is still on `body`. That cannot take a record a swap needs: a browser that
 * fires `focusout` when React removes the element does so inside the commit, and the commit's layout
 * effects — this hook's among them — run in the same synchronous pass, before any microtask. (React's
 * `ViewTransition` can defer layout effects behind a promise, which would break that; the dashboard
 * uses none.) What it does clear is a removal by a commit the page took no part in, which is not a
 * swap anyway.
 *
 * **It goes to a control, not a `tabIndex={-1}` heading.** `DeviceViewer` parked focus on a
 * non-control once and took it out again: such an element also takes focus from a mouse, and a focus
 * nothing can act on still has to wear a ring. And a control that is landed on should say what
 * happened itself, because NVDA and JAWS flush a pending polite announcement when focus moves in the
 * same commit — App Center's "Try again", search box and first release each carry theirs through
 * `aria-describedby`.
 *
 * **What the suite does not hold**, measured by removing each and watching nothing fail:
 *
 * - The layout effect, which runs before paint so no frame shows focus on `body`. jsdom cannot tell
 *   a layout effect from a passive one here.
 * - "Focus is now on `body`", a backstop: every real move fires `focusin` and clears the record, so
 *   a set record already means focus is in the region or was dropped to `body`. It stays for a path
 *   that focuses something without `focusin`, which would otherwise have that focus taken from it.
 */
export function useFocusAfterSwap<T extends HTMLElement>(view: string, fallback?: RefObject<HTMLElement | null>) {
  const ref = useRef<T>(null)
  const lastFocused = useRef<Element | null>(null)
  const shownView = useRef(view)
  const wasInside = useRef(false)

  useEffect(() => {
    const clearOnMove = () => { lastFocused.current = null }
    const clearOnLeave = (e: globalThis.FocusEvent) => {
      if (e.relatedTarget !== null) return
      const left = e.target
      queueMicrotask(() => {
        if (lastFocused.current === left && document.activeElement === document.body) {
          lastFocused.current = null
        }
      })
    }
    document.addEventListener('focusin', clearOnMove, true)
    document.addEventListener('focusout', clearOnLeave, true)
    return () => {
      document.removeEventListener('focusin', clearOnMove, true)
      document.removeEventListener('focusout', clearOnLeave, true)
    }
  }, [])

  const onFocus = useCallback((e: FocusEvent) => {
    lastFocused.current = e.target as Element
    wasInside.current = ref.current?.contains(e.target as Node) ?? false
  }, [])

  useLayoutEffect(() => {
    const swapped = shownView.current !== view
    shownView.current = view
    const last = lastFocused.current
    if (last === null || last.isConnected) return
    // Decided on once, whether or not this commit was the swap: a record kept past a removal that
    // was not a swap would pull focus in on some later swap nobody connects with it.
    lastFocused.current = null
    if (document.activeElement !== document.body) return

    if (!swapped) {
      if (!wasInside.current) return
      // A removal within the same view (e.g. a row leaving a list).
      // We fall back to the provided fallback instead of the first control in the region,
      // avoiding arbitrary jumps to unrelated list items.
      fallback?.current?.focus()
      return
    }

    ;(ref.current?.querySelector<HTMLElement>(FOCUSABLE) ?? fallback?.current)?.focus()
  })

  return { ref, onFocus }
}
