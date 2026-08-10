/**
 * A correlation id for a request this browser sends to the relay.
 *
 * **`crypto.randomUUID` is not available here.** It is secure-context only, and a LAN deployment is
 * plain HTTP — the primary manual-testing path, and the reason `pickDecoder` has a WASM tier at all.
 * `getRandomValues` has no such restriction.
 *
 * It has to be unguessable rather than merely unique: a reply is addressed by `requestId`, and for the
 * clipboard bridge its payload lands on the user's own OS clipboard.
 *
 * Lived inside `useClipboardBridge` until the correlation work (L5) gave a second caller — `open-url`,
 * whose reply the viewer toasts. Moved rather than copied, because a second `randomUUID` would have
 * looked correct in every dev environment and thrown only on the deployment tapflow is for.
 */
export function newRequestId(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}
