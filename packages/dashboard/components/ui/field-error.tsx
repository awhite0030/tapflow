import { cn } from '@/lib/utils'

/**
 * A field's validation message, in a slot that is always mounted and takes no space until it has
 * something to say.
 *
 * **Always mounted, because an announcement needs a region that was already being watched.** A live
 * region created together with its text is the case assistive technology supports worst, and for the
 * form-level message there is no second channel: no field owns `errors.root` and focus never moves
 * to it, so a missed announcement is a sign-in that failed for no stated reason.
 *
 * **Out of flow while empty, so the form at rest looks as it did before any of this.** A reserved
 * line under every field reads as a gap somebody forgot to close. `absolute` rather than `hidden`:
 * `display: none` takes the element out of the accessibility tree too, which would undo the reason
 * it is mounted early.
 *
 * **Polite per field, assertive for the form.** `aria-live="polite"` and not `role="status"`,
 * because `Team.tsx` and `Tokens.tsx` already put a `role="status"` region in their dialogs and a
 * second one would make `getByRole('status')` ambiguous — the live region is what matters here, not
 * the role name. Assertive belongs only to `errors.root`: a submit with three bad fields would
 * otherwise fire three announcements that interrupt each other.
 *
 * **Why a field needs its own region at all, when `aria-describedby` already names it.** Because the
 * description is only read when focus arrives, and on submit react-hook-form calls `.focus()` on the
 * first invalid input — which fires no focus event when that input is already focused, the common
 * case for someone pressing Enter in the field they were typing in. It also never reaches the second
 * and third invalid fields. The description carries the message when focus does move; this carries
 * it when focus does not.
 *
 * **Callers gate on `?.message`, never on the error object.** An error with no message would
 * otherwise leave `aria-invalid="true"` pointing at an empty slot. Nothing produces one today —
 * every `setError` call in this package passes a message and every zod rule has a default — which is
 * why this is a sentence rather than a guard.
 */
export function FieldError({
  id,
  message,
  className,
  assertive,
}: {
  id: string
  message?: string
  className?: string
  assertive?: boolean
}) {
  return (
    <p
      id={id}
      {...(assertive ? { role: 'alert' as const } : { 'aria-live': 'polite' as const })}
      className={cn('text-sm text-destructive', !message && 'absolute', className)}
    >
      {message ?? ''}
    </p>
  )
}
