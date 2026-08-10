---
'@tapflowio/protocol': minor
'@tapflowio/relay': patch
---

fix(relay): the session-state replay carries a sessionId, so the three messages that shared a declaration can require it

`session:chrome`, `session:deviceInfo` and `device:ready` were declared `sessionId?: string` while both
agents stamped the field on every copy they sent. The relay was the only producer that did not: its
replay of cached session state to a re-joining viewer (`handleSessionStart`) omitted it, and the three
share one declaration with the forwarded copies, so `optional` was the honest thing that declaration
could say about two producers that disagreed.

**The disagreement was the defect.** When this surface was consolidated, two ways to tighten the
*declaration* were weighed and rejected — declaring the three twice (drift, the finding that work
existed to remove), and mapping the union through `Omit<T,'sessionId'> & { sessionId: string }` (turns
them into intersections, so `Extract<BrowserInbound, …>` stops yielding one member, which
`useClipboardBridge` reads its replies through without a cast). The third option was not considered:
fix the producer. The relay stamps it now and the field is required.

This closes the Major deferred on #503.

`minor`, not `patch`: the three are published exports and adding a required field is source-breaking for
an out-of-repo producer that omits it. `CONTRIBUTING.md` makes any breaking change a `major`, relaxed to
`minor` before `v1.0.0`, and that is not conditional on a consumer being known.

**The dashboard's session gate got stricter as a consequence.** It read
`'sessionId' in msg && msg.sessionId && msg.sessionId !== sessionId`, and the middle truthiness check
existed to let the unstamped replay through. Nothing validates inbound messages (#444), so
`sessionId: ''` type-checks and arrives — and a falsy sessionId *passed* that gate and was applied to
whichever viewer was mounted, which is the unattributed-message defect #445 exists to prevent, reachable
through the hole that existed for the replay. With the replay stamped the check is gone, and an empty
sessionId is now simply a mismatch.
