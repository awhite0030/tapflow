import { cn } from '@/lib/utils'

/**
 * A field's validation message.
 *
 * **Rendered only when there is something to say**, so a form at rest looks exactly as it did
 * before any of this — a reserved line under every field reads as a gap somebody forgot to close.
 * The message therefore moves what is below it when it appears, which is accepted rather than
 * overlooked: validation now runs on submit, so nothing appears while a pointer is on its way to a
 * dialog's Close button, which is the press that used to be eaten.
 *
 * **Announced by being named, not by shouting.** Submit is where react-hook-form moves focus to the
 * first invalid input, and focus alone says "Admin email, edit text" and nothing about what is
 * wrong — so the input carries `aria-describedby` pointing here, and the description is read with
 * the name. No live region on a field slot: three bad fields would fire three announcements that
 * interrupt each other *and* the focus announcement that is carrying the one the person needs.
 *
 * `assertive` is for the form-level message (`errors.root`: a sign-in refused, a request that
 * failed). No field owns it, focus never lands on it, and nothing else says it — so that one is a
 * `role="alert"`, which announces on the insertion this component is built around.
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
  if (!message) return null
  return (
    <p id={id} {...(assertive ? { role: 'alert' as const } : {})} className={cn('text-sm text-destructive', className)}>
      {message}
    </p>
  )
}
