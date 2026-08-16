---
'@tapflowio/protocol': minor
'@tapflowio/relay': patch
'@tapflowio/ios-agent': patch
'@tapflowio/android-agent': patch
'@tapflowio/mcp-server': patch
'@tapflowio/flow-runner': patch
---

feat(protocol): correlate input acks, and refuse an input from a socket that does not hold the session

Closes #499. Five requests carry a required `requestId` — the four terminal frames (`input:touch:end`,
`input:pinch:end`, `input:key`, `input:button`) and `input:type` — and so do the four replies. The four pairs
already correlated arrive at the speed a person clicks a button; a swipe is dozens of frames, which is why an
ack that missed its own deadline being consumed by the **next** input's waiter was never a corner case.

**Opening and move frames carry none, and neither does `input:rotate`.** Nothing acks them, so an id there
would name a waiter that does not exist.

## Required on both sides, and the compiler holds more here than anywhere else in this work

No producer of these replies sends one unsolicited — `ackInput` fires on terminal outcomes only,
`ackNoSession` answers a terminal input for a session the agent lost, and the relay answers one it cannot
dispatch. Six producers of `input:error`, every one behind a request. So both sides are required, unlike the
lifecycle pair (#521) whose replies have genuinely unsolicited producers.

That matters concretely: the relay's own `input:error` goes through `sendTo(msg: RelayOutbound)` and the
agents' through `sendMsg(msg: AgentControlOutbound)`, so omitting the echo is a **compile error** rather than
something only a test could catch. That is the position #521 could not reach, and it is exactly where the same
defect had already shipped twice.

`input:type-error` moved from `AgentToBrowser` to `RelayOrAgentToBrowser`, because the relay produces it now —
the compiler refused the send until the union said so, which is the rule `relay/AGENTS.md` states.

## The eleven input cases became two clauses

Written into the shared body, the correlator gate would have dropped every opening and move frame with it: no
swipe, no pinch, no rotation, and nothing said. `correlatedRequestsGated` resolves fall-through by sharing the
next non-empty body, so it would have read one gate as covering all eleven — the trap `#521`'s own comment
documents, walked into one slice later. `TERMINAL_INPUT_TYPES` is deleted: the clause labels are the
definition now, and a second source of truth for "which inputs are answered" is what this work removes.

## The sender must hold the session — on every branch, not just input

Folded in rather than deferred, because it changes this layer's own reasoning: with the check, a foreign
`input:error` cannot reach the dashboard, so the rule "the dashboard does not correlate" gets a durable reason
instead of one a later slice deletes.

Review then found that **input was one branch of ten.** The relay acted on every browser→agent command on the
strength of the session existing — `clipboard:write` pasting attacker text into the victim's device,
`clipboard:read` pressing copy or cut on it with the payload landing on *that* tester's host OS clipboard,
`session:end` deleting their session. `clipboard:data` has asked the mirror-image question since the bridge
was written, with the reason beside it; the browser direction had none anywhere. And the hole was already
documented in-repo: `SessionList.tsx` sends `session:start` before a shutdown purely to work around it, and
its comment says so.

So the check now covers the five acked inputs, `device:boot`, `open-url`, `app:install`, `app:launch`,
`app:clear-state`, `clipboard:read`, `clipboard:write`, `session:leave` and `session:end`. Nothing in-repo
relied on the old behaviour — every sender joins first, and the dashboard's app, deeplink and clipboard
senders all live under the component that joins.

`dispatchTarget` decides it once: session exists, this socket holds it, agent connected. That collapsed three
conditions spread across seven `case` bodies as two each — with ownership in none of them — so the cases got
**shorter**. The app-command handlers check ownership directly instead, after the session lookup and before
the build lookup: the resolver also decides agent liveness, and using it there would move `agent offline`
ahead of `Build not found`, changing which of two simultaneous problems the caller is told about.

A refusal is **answered where a waiter exists** and dropped where none does. Answering is the load-bearing
half: a session that has never acked reports silence as *success*, so dropping would report a command that
never left the relay as having landed. `session:leave` and `session:end` have no reply, so they are dropped —
the same asymmetry as the input frames nothing acks.

`not-session-owner` is its own reason on this set's rule — one reason per thing a consumer must do
differently — and it is the only member that can promise nothing reached the device, so the first whose advice
says "retry after joining" without a hedge (#491). Two prose strings behind it (`ownershipRefusal`), because
telling a caller the session is in use when it is idle steers it off a device it could have had.

**`device:shutdown` is the one command left out of the ownership gate**, and the blocker is the dashboard
rather than the relay:
three of its four senders come from `useAgentSession`, whose socket never joins, so the gate would break going
back and the unmount teardown. The question is whether that hook should join — #527.

One diagnosis improved for free: `open-url` answered `'agent offline'` for a session the relay does not have,
which is the wrong-diagnosis class #492 fixed for `device:boot` and `input:error` and had left here. The
shared resolver corrected it, and the test that pinned the old prose says so.

## A second door predicate: the request must name a session

CodeRabbit found that `isCorrelated` validated `requestId` only, so a command with no `sessionId` — or an
empty one, which type-checks and which `mcp-server`'s bare `z.string()` tool schemas let a model produce —
reached the reply builders and shipped a frame whose **required** `sessionId` `JSON.stringify` erases. Every
consumer's session gate then discards it, so the caller waits out its deadline with the diagnosis in hand and
no way to attribute it. `isAddressed` closes it at the same doors, with the same policy: not forwarded, not
answered, logged.

**Dropped rather than answered, and the note this contradicts is in this repo.** `SessionError`'s doc said
"the only correct thing for it to send with no sessionId is `{ type: 'error' }`". That was written before
requests carried a second correlator, and its own premise refutes it now: `GenericError` has no `requestId`,
so a caller that receives one cannot attribute it and waits out the same deadline it would have waited out on
silence. Answering was never the payoff — not shipping a frame that violates its own declaration is, and
dropping achieves that more cheaply. Widening `SessionStartFailure` to carry an "unaddressed" reason was the
alternative, and it is what L5d is for: that union's own doc says it has a single producer in
`handleSessionStart`, so adding a member would make that false while pre-deciding what `error` is.

Narrowing `dispatchTarget` to `sessionId: string` is what found the doors — exactly four compile errors, then
the handler signatures carried the rest. **Seven `msg.sessionId!` assertions went away** on the request side
as a consequence, which is the payoff `SessionError`'s doc predicted. Twelve are left, and reviewing L5d
corrected the sentence that stood here: they are **not** all agent→browser forwards. Eight are; `stream:register`,
`device:shutdown` and `forwardUnacked` are request-side paths that deliberately carry no address gate, and
`handleAckedInput`'s assertion is dead — this slice's own door predicate narrowed that parameter, so the `!`
counted itself into #444's body while asserting nothing. Still #444, minus one line L5d removes.

Three places got the predicate and then **had it removed again**, because a mutation showed there was nothing
observable to hold it with: the unacked input clause, `device:shutdown`, and the two session commands. In each
the frame is dropped by the session miss anyway, so the gate bought only its log — one line per
`input:touch:move` in the first case, which is the ~60/s the ownership warn had already been removed from that
same method for. A line no test can hold is a line that will drift, and the reason is recorded at each site.

## The ledger records a *correlated* ack

`ackedSessions` gates whether silence is fatal, and it now records `input:done` only when it carries a
correlator. `strict` licenses one inference — *silence here is an anomaly, not an agent that does not ack* —
and for an agent that never carries a correlator, silence at the waiter is **structural**: its acks can never
match. Recording it would make every input after the first report a failure the agent had no way to avoid.

Not a provenance question, which is what a first draft claimed: an id-less `input:done` is still the agent's
word. What it lacks is attribution, and attribution is the waiter's question. Nor is the condition "an id
*this client* issued" — that needs a set of issued ids outliving their waiters, and since the late ack is
precisely the one worth recording, the set would never shrink in a long-lived stdio process.

The cost lands on agents predating the correlator, and it is not a revert of #457: `mcp-server/AGENTS.md`
already documented that an agent whose acks never arrive keeps the optimistic path. This widens that
exemption from "predating the ack protocol" to "predating the correlator". Because there is **no version
handshake anywhere** in this system, an id-less ack is the only skew signal that exists — so it goes in a
second set carrying no strictness, logged once per session. Dropped silently, the session would return to
optimistic reporting, which from an operator's seat is indistinguishable from #457.

## Not closed: #517

`input:keyboard:toggle` stays out, and not for the reason a first draft gave. It **has** a reply on iOS
(`keyboard:toggled`) with a consumer that sets session state; what is missing is the **failure half** — the
`.catch` only logs, so the pending flag never clears and the button latches off. Correlating a pair whose
failure half does not exist leaves it half-correlated, and the missing half is platform-asymmetric, since
Android's toggle has no device-side effect at all. #517 is the prerequisite.

## What the mutation round found

**26 mutations, none surviving** — reached in three rounds, and what each round found is the story.

Round one: nine mutations, **five alive** on a green suite. The correlator gate deleted (600 relay tests
passed), the ownership check deleted (600 passed), both agents' `input:done` echo replaced with a literal,
`ackNoSession`'s echo likewise, and a `sessionId` fallback added back to the waiter (77 passed). Every one was
a test the plan had specified and this work had not written — the same blind spot as #521, where fixing the
fixtures felt like finishing.

Round two, after six new tests: the two review channels found **four more**, and the sharpest was not a gap in
coverage but a new failure mode. `flow-runner`'s `tap`, `swipe` and `pressKey` await nothing, so setting their
minted id to `''` left all 63 tests passing while every frame was dropped at the relay's door — a flow whose
taps never left the relay reports **PASS**. The old code could not fail that way, because there was no id to
get wrong. Also unpinned: the `input:error` half of both agents' `ackInput` (worse than a hang — an unmatched
reply resolves *optimistically*, so a stated device failure reaches the caller as success), `input:type`'s
correlation on all four producers and both consumers, and an **unheld** session accepting input from anyone.

Round three: two of the tests written in round two were themselves Potemkin. Both staged a stale reply and
then asserted the request count — 1 either way, so they passed with the correlator check deleted. Making the
stale reply an *error* is what made which reply resolved the call observable. Asserting a property needs the
mutation that removes it to fail, and counting requests was not that.

Six more mutations cover the widened gate, including one that collapses the two ownership prose strings into
one (nine tests) and one that drops `Session not found` from the resolver (four).

Two things caught by tooling rather than by me. `pnpm exec tsc -b` does not cover
`protocol/tsconfig.assertions.json`, so four errors there passed straight through my checks until the
pre-commit hook refused the commit. And lint reported `TERMINAL_INPUT_TYPES` dead the moment the clause split
removed its last use.

Promoting the request side hung both agent suites rather than failing to compile: 64 fixtures across
`IOSAgent.test.ts` and `AndroidAgent.test.ts` send these inputs from inside `JSON.stringify({ … })`, where no
annotation exists for a compiler to check. Third slice in a row on that surface — worth a rule for the agent
packages, as the dashboard has, and out of scope here.
