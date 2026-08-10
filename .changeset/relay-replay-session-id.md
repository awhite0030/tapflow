---
'@tapflowio/protocol': minor
'@tapflowio/relay': patch
---

fix(relay): the session-state replay carries a sessionId, so two of the three can require it

`session:chrome`, `session:deviceInfo` and `device:ready` were declared `sessionId?: string` while both
agents stamped the field on every copy they sent. The relay was the only producer that did not: its
replay of cached session state to a re-joining viewer (`handleSessionStart`) omitted it, and the three
share one declaration with the forwarded copies, so `optional` was the honest thing that declaration
could say about two producers that disagreed.

**The disagreement was the defect.** When this surface was consolidated, two ways to tighten the
*declaration* were weighed and rejected. The third option was not considered: fix the producer. The relay
stamps `session:chrome` and `session:deviceInfo` now and both are required. Closes the Major deferred
on #503 for those two.

**`device:ready` is deliberately left optional, and that is the interesting half.** Its `sessionId?` is
doing correlation work by accident: `mcp-server` and `flow-runner` gate a pending `device:boot` on
`msg.sessionId === sessionId` with no truthiness escape, so the unstamped replay is invisible to them.
Stamping it makes a *replayed* `device:ready` satisfy an in-flight boot — measured on a real relay with a
silent agent, `boot_device` answers `{booted: true}` having received nothing, where the same harness
reports still-waiting without the stamp. The replay is cached state addressed to a **join**, not an answer
to a **boot**, and `readySent` is cleared by nothing while an agent is wedged-but-connected, which is
exactly when a boot hangs — so the value is stalest precisely when it would be consumed.

The defect underneath is that leaving a session does not clear its waiters: a *real* `device:ready` after
a re-join already satisfies the stale one, so this is pre-existing and stamping only widens the trigger.
Filed separately. What makes this message tightenable is a request correlator, not another field.

`minor`, because the two that changed are published exports and adding a required field is source-breaking
for an out-of-repo producer that omits it. `CONTRIBUTING.md` makes any breaking change a `major`, relaxed
to `minor` before `v1.0.0`, and that is not conditional on a consumer being known.

**The dashboard's session gate got stricter as a consequence.** It read
`'sessionId' in msg && msg.sessionId && msg.sessionId !== sessionId`. The middle check was never what
carried the replay — the relay omits the key, so `'sessionId' in msg` already lets those through — it only
ever admitted a key that was *present and falsy*. With it gone, `sessionId: ''` is a mismatch rather than
a pass. That is defence in depth against the unvalidated-inbound gap (#444), not a live hole: measured, an
agent-sent `''` never reaches a viewer, because every agent→browser forward resolves
`sessions.get(msg.sessionId!)` against a `randomUUID` key and breaks on the miss.

One correction to a reason recorded three times in this package: rejecting the `Omit`-mapping alternative
was justified by "it breaks `useClipboardBridge`, which reads its replies through `Extract<>`". It does
not — that hook takes the three replies as named members and says so in its own comment, and its only
`Extract` is over `ClipboardRequest`, an outbound union the mapping would never touch. The outcome is
unchanged, since fixing the producer made both alternatives unnecessary.
