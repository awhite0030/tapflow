---
'@tapflowio/protocol': minor
'@tapflowio/relay': patch
'@tapflowio/ios-agent': patch
'@tapflowio/android-agent': patch
'@tapflowio/mcp-server': patch
'@tapflowio/flow-runner': patch
---

feat(protocol): correlate device:boot and device:shutdown, with an optional correlator

The lifecycle pair joins the four already correlated by `requestId` (`screenshot`, `ui:tree`, `clipboard`, the
app commands). It is the first one whose correlator is **optional on every reply**, and that difference is the
whole design — `device:ready`, `device:boot-error` and `device:shutdown-done` all have producers that answer no
request at all, so absence has a real and permanent meaning: *this frame is not the answer to anything*.

Consumers correlate when the id is present and fall back to `sessionId` + type when it is not
(`mcp-server`, `flow-runner`). That fallback is not compatibility slack that expires — it is what lets the
relay's own replay and Android's mid-session stream failure keep reaching the surfaces that report them.

What correlation buys on this pair is narrower than the obvious claim, and review caught the first draft
making the obvious one. It does **not** let two concurrent boots both resolve: the agents answer a
superseded boot with nothing at all (`bootSeq` returns silently at every checkpoint), so one of two
overlapping boots times out either way. Both clients' `dispatch` resolves the first waiter whose predicate
matches and then stops — so on `sessionId` + type alone, that single reply went to the boot registered
**first**, the superseded one, and the boot that actually happened was reported as a failure. The
correlator sends the reply to the request it answers. Same one timeout, correct attribution.

## What the design review changed

The first draft made `DeviceReady.sessionId` required and had the relay stamp its replay, then argued the pair
faced a forced choice: correlate strictly and break every agent predating the field, or keep a fallback and
let a replayed ready satisfy an in-flight boot. Measured against a real `RelayServer`, that choice was
manufactured by the draft itself. **The discriminator today is that the replay carries no `sessionId`**, and
both boot waiters already depend on it — so requiring and stamping it is what deletes the working guard.
Dropped from this change; `sessionId` on `device:ready` stays optional, and closing #516's deferral is its own
later slice, which must carry a test pinning the *value* stamped. There is none: with the stamp mutated to
`session.deviceId` — a plausible slip on a line whose payload reads `{ deviceId: session.deviceId }` — the
relay's 591 tests, the dashboard's 317 and the entire static suite still pass.

The review also found the producer inventory wrong. `AndroidAgent.restartVideoStream` sends
`device:boot-error` for a video stream that died mid-session and failed to restart, with no `device:boot`
anywhere behind it. So that message qualifies for an optional correlator **on its own merits**, and the
consumer that reads it — `DeviceViewer`, the only surface reporting a dead stream — must not gate on the
correlator at all, or #426's symptom comes back.

## Optional means tests are the entire enforcement

`<Pair>ReplyBody` cannot be built for a field an object may omit: `Omit<T,'sessionId'|'requestId'>` is
satisfied by an object with no correlator, so the excess-property trick that catches a freshly minted id has
nothing to bite on. And `scripts/__tests__/correlatedRequestsGated.test.mjs` derives its set from *required*
declarations, so it does not see this pair — including the position that matters most: **the relay is itself a
producer of `device:boot-error`**, answering a boot it cannot hand to an agent. An uncorrelated diagnosis
there is read as unsolicited and discarded, and the caller waits out its deadline instead of failing. That
exact defect shipped twice from agent code (`open-url:error`, then `clipboard:error` a slice later); here it
sits where no check can reach, so a relay test holds it.

Every echo, prohibition and fallback added here was verified by mutation — 23 of them, each failing only the
tests that claim it: 5 on the relay, 7 across the two agents, 5 on the dashboard, 6 across the two clients.
Two are worth naming. A *strict* correlator gate on `device:boot-error` and a mere *presence* check fail
**different** tests, which is why both prohibition cases exist. And replacing an echoed id with a freshly
minted one fails the echo test **and** the absence test — a shape that, one slice earlier, only the first of
those caught.

Those 23 shared a blind spot, and review found it: they all probed what the gate does **with** an id, so
nothing held how ids enter or leave `bootIdsRef`. Four mutations survived the whole suite. The sharpest is
`bootIdsRef.current.clear()` added to the `device:booting` branch — invited by the comment above it, since
that is where every other per-cycle record is dropped, and fatal because both agents send `device:booting`
*before* the ready answering the same boot. Every real ready is then rejected while `setDeviceReady(true)`
has already run: spinner cleared, device apparently healthy, app never installed, on the primary
manual-testing path. The other three: the rebind boot's id never registered (so #426's recovery keeps the
picture and loses the controls), the `session:joined` cross-cycle clear removed, and `mcp-server`'s
`shutdownDevice` correlator left off the wire — where `toMatchObject` ignored the absent key and the
mismatch test still passed against a hardcoded foreign id. All four are pinned now, each by one test.

## `DeviceBoot.requestId` is required, and 42 test fixtures said nothing about it

The request side is asymmetric on purpose, and for a mechanical reason rather than a stylistic one: a
request passes *through* the relay, so one door gates and logs every sender at once, while a reply does not
— the relay forwards it with `JSON.stringify` without inspecting it. Absence also has no legitimate meaning
on a boot: nothing originates one but a browser. So `device:boot` is the pair's one required correlator,
which is what puts it inside `correlatedRequestsGated` and makes the door gate reachable. `device:shutdown`
stays optional because the relay sends that one itself, from its idle timer.

Promoting it produced no compile error, and the reason is worth stating precisely, because the convenient
version of it is false. It is **not** that the compiler cannot see the request side: all four `device:boot`
senders go through a sink typed `BrowserToRelay` (`DeviceViewer.tsx:38`, `mcp-server/src/client.ts:182`,
`flow-runner/src/RelayClient.ts:126`), so every one of them would have errored. They did not error because
the earlier hunks of this same commit had already added the ids. The request side is exactly where the
compiler works.

What it produced instead was **two hung agent suites**. 42 fixtures across `IOSAgent.test.ts` and
`AndroidAgent.test.ts` send `device:boot` through a real `RelayServer`; the door now drops them, and each
test waited for a `device:ready` that never came. None was a type error, and typechecking the test folders
would not have found them: those literals sit inside `JSON.stringify({ … })` at an untyped `ws.send`, so
there is no annotation for a compiler to check. Three *documented* recipes had the same shape and were
updated too — `ios-agent/AGENTS.md`, `test-utils/src/socket.ts` and `test-utils/AGENTS.md` — because that
first one is the file the 42 were copied from, so leaving it would hand the next contributor the same
30-second mystery. The dashboard has a rule against untyped injected fixtures ("not `as never`, not a local
shape") and the agent packages have no equivalent; worth one, and out of scope here.

`case 'device:boot': case 'device:shutdown':` was one fall-through clause and is now two. Not cosmetic: the
correlator on `device:shutdown` cannot be required, because the relay originates that message from its idle
timer with no browser behind it — so a gate written into the shared body would have stopped the dashboard's
four senders and the relay's own from reaching the agent, silently, in the one direction nothing replies to.

`DeviceViewer` correlates `device:ready` only past the line that clears the spinner, which newly rejects a
straggler ready from an earlier boot cycle — it used to release the current rebind and install on top of an
install already in flight. It does **not** close the duplicate-install-on-re-join case that branch's comment
describes: the replayed ready carries no id, so it is still accepted, and it has to be while an agent
predating the echo answers the same way. Separating those two needs the replay to be identifiable on its own,
which is the deferred `sessionId` tightening.
