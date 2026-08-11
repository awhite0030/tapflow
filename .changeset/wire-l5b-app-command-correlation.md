---
'@tapflowio/protocol': minor
'@tapflowio/relay': patch
'@tapflowio/mcp-server': patch
'@tapflowio/flow-runner': patch
'@tapflowio/ios-agent': patch
'@tapflowio/android-agent': patch
---

feat(protocol): the app commands carry a requestId, and the relay carries it across a rebuild

`app:install`, `app:launch` and `app:clear-state` now correlate by `requestId` like `open-url`, so a caller
matches its own reply instead of matching on `sessionId` + message type and taking whichever arrives first.

**Two of the three are not forwards, and that is the new part.** `open-url` was re-serialised whole, so the
correlator rode along for free. `app:install` / `app:launch` arrive carrying a `buildId`, and the relay
looks up the build and sends the agent a **different message** — so the id has to be copied across the
rebuild or the agent's reply, which the relay forwards without inspecting, cannot be attributed to
anything. `AppInstallToAgent` / `AppLaunchToAgent` declare it required, which makes *dropping* the copy a
compile error.

**The reply direction is held entirely by tests, and the first version of this change had none of them.**
Review made both relay `fail()` closures, the clear-state error exit and all six agent `respond` helpers emit
a fabricated correlator, and every suite held its baseline exactly. A wrong echo is worse than a
misattribution now that consumers gate strictly: the dashboard discards the reply and nothing clears
`installing`, so the Launch control never appears, and the MCP caller burns its full deadline. There are
assertions on all nine relay error exits, echo tests per pair on both agents, six concurrency tests (the
mutation that hoists the correlator out of per-request scope was invisible to everything else), dashboard
tests for both gates, and `mcp-server` tests that fail if the predicate reverts to `sessionId` — which it
could, silently, before.

**Nothing type-checks that the copied value is the request's**, and that is not for want of trying. Four
candidate guards were built and broken: a branded `CorrelatedId` is laundered by any cast to the brand,
because a brand names a *kind* while provenance is a property of the *instance* and TypeScript has no
value-dependent types; a generic `Omit`-body helper does not compile without a cast of its own, which is
worse than the literal it replaces since a literal at least gets its whole shape checked. So the reply side
keeps its `<Pair>ReplyBody` — worth it there, with ~20 literal sites — and the request side is held by
tests, one per handler, asserting the forwarded id is the one that came in.

**`device:shutdown` was in this slice and came out.** It has no error type, and two properties this shape
cannot express: the relay **originates** one itself when a browser socket closes (`DeviceShutdown` is a
single interface shared by both directions, so a required correlator would force the relay to invent an id
for a request nobody made — exactly what the door checks exist to prevent), and `device:shutdown-done` is
consumed by `SessionList` as a **device-status broadcast** rather than as a reply to its own request. That
second property is why `device:ready` was carved out too, so the two go together into the slice that
decides what a relay-originated request and a dual-role reply mean. It also cannot have a meaningful
concurrency test — the agents' shutdown handler returns early once state is gone, so a second request
produces no second reply to correlate.

**An agent older than this field strands the command, and that is the upgrade cost.** The earlier draft
argued the skew window is zero because the packages share a `fixed` version group — but `fixed` makes them
*release* together, not *install* together, and the agent runs on a tester's Mac installed separately from
the relay. Such an agent's `app:install-done` has the key absent, the dashboard discards it, and "Installing…"
persists with no Launch control. For `open-url` last slice the same skew cost a toast; here it costs the
primary manual-testing flow. The relay's door checks log now, since otherwise all three hops are silent.

**Door checks, one policy per request**: an uncorrelatable request is not forwarded, not rebuilt and not
answered, since every reply these produce declares `requestId` as required. They go through a type
predicate rather than a bare `typeof`, because a bare check narrows the property and not the object — the
handler call would not compile — and because narrowing does not survive into a nested function, so a
`fail()` closure built after the check sees `string | undefined` again, whose shortest fix is the
`msg.requestId!` that was removed for `open-url` in the previous slice.

`clipboard:read` / `clipboard:write` get the same door check, and `clipboard:error` stops asserting
`msg.requestId!`. Not part of this slice's pairs — clipboard has carried a required correlator since it was
written — but it had the identical defect, and leaving it would have made this change's own claim of one
policy at the door false the moment it landed.

The dashboard mints and records ids for its install and launch, like it does for deeplinks, so an
`mcp-server` install on a session this viewer holds no longer flips its install state. The relay delivers a
reply to whichever socket holds the session, not to whoever asked.

One thing this does **not** cover, stated because "every exit carries the request's id" would be false: a
throw out of the build lookup — SQLITE_BUSY, a closed database, I/O — unwinds to the message-loop catch and
answers nothing at all. Pre-existing and unchanged.
