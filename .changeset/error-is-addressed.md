---
'@tapflowio/protocol': minor
'@tapflowio/relay': patch
'@tapflowio/mcp-server': patch
'@tapflowio/flow-runner': patch
---

feat(protocol): `error` is the session-start refusal, and it names the session it refuses

Closes #512's first finding, and ends a contradiction that sat in two files at once. `GenericError`'s doc
claimed *"the escape hatch for a failure the relay cannot correlate to a session"*, while
`SessionStartFailure`'s claimed the reason has **a single producer inside `handleSessionStart`**. Both cannot
be true.

The correlation work settled it by removing the general role rather than the specific one. A request naming no
session is dropped at the relay's door, because answering it would ship a frame whose own required `sessionId`
`JSON.stringify` erases — and `error` has no `requestId` either, so a caller could not attribute the answer and
would wait out the same deadline silence costs. With nothing left needing an unaddressed failure, all four
producers answer one specific join.

## What the address buys

The join waiters in `mcp-server` and `flow-runner` matched `sessionId === undefined || sessionId === mine`, and
with no such key **the left half was always true** — so any refusal resolved any pending join. Two concurrent
`connect_device` calls and the first refusal woke the wrong one, reported as a failure that session never had,
while the one actually refused waited out its deadline, because `dispatch` resolves only the first matching
waiter. That is the defect; the escape was it.

## `extends SessionError`, not a bolted-on field

The naming check forced the decision the plan had left open. `protocolMessageNames.test.mjs` asserts that a
session-scoped failure declares `extends SessionError`, and its predicate is exactly this change: `'error'`
already matched `/error$/`, and it survived only because it had no `sessionId`. Adding the field flips that.

Joining the family is the honest answer rather than carving an exception: the shape is the base verbatim, and
the base's own definition — a failure a *session* is waiting on — is now exactly what `error` is. The check's
note saying `error` *"cannot be a `SessionError`… that is the member's nature, not an exception"* described a
nature this change replaced, so the note is corrected in place rather than worked around.

## The name stays `GenericError`

A first draft leaned toward `SessionStartError`, arguing that a narrowed role was the only chance to remove the
naming exception. **Review refuted it.** The derivation rule splits the literal and PascalCases it, so `'error'`
yields `Error` — which shadows the global, and that is the exception's whole reason. `SessionStartError` is not
the derived name either, so it needs an exception entry just the same; `NAME_EXCEPTIONS.size` stays 6. The
exception is removable only by renaming the **wire literal**, which this slice does not scope. Renaming would
have touched every consumer plus `typeAssertions` and bought nothing.

## Skew is logged, not hedged

A client newer than its relay sees unaddressed refusals, which now match nothing — so the join runs to its
deadline instead of reporting why it was refused. There is no version handshake anywhere in this protocol, so
the alternative was a fallback, and a fallback here is the ambiguity this work removes. Both clients log once
per session instead: the same shape and the same reasoning as the input-ack skew record, that logging is not
matching. Approved as part of the breaking change, in that direction specifically.

## What the design review changed

Eight things, and two of them were premises the plan had asserted rather than measured.

- **The scope in the program plan was wrong in three ways.** Its table called this slice *"`session:start`/`error`
  echo (#512 finding 1 · #444's seven reply sites)"*. The seven reply sites had **already gone** — the input
  slice's door predicate removed them, so what is left is #444's own body. "Echo" was rejected by the same
  file's decision log, which had already refused a correlator on `error` on the grounds that attaching one
  makes it a different message. And the general role was already dead in code while two comments still claimed
  it.
- **Three consumers, not one.** The plan said the dashboard's filtering would newly affect
  `DeviceViewer`, `SessionList` and `useAgentSession`. `SessionList` has no session gate at all, and **`error`
  never arrives at `useAgentSession`** — every producer is `sendTo(ws, …)` to the socket that sent
  `session:start`, and that hook's socket only sends `agents:list` and `device:shutdown`. So the filtering
  affects one consumer, and it is a no-op there: no `error` the wire can deliver to that socket will be dropped.
  A planned test for "the dashboard receives another session's error" was deleted — the wire cannot produce it.
- **`useAgentSession`'s `error` and `session:joined` branches are unreachable**, and `inboundDisposition` named
  it as handling both. Correcting that by *removing* the name made the table stale in the other direction, and
  the reverse-direction check said so: `at` answers "which files compare `.type` against this", which is still
  true. The name stays and the reachability went into the comment — with what the first attempt got wrong.
- **Stale prose was in six places, not two — and a second review found five more that the first pass had not
  reached.** The sharpest of the first six is `SessionList`, where three comments justify a serialisation guard
  on `error` carrying no sessionId, and #527 has that list joining before it shuts down as a client-side
  stand-in for a missing server check, so someone deleting the guard on the strength of the old comment would
  unlock the wrong row's badge. The sharpest of the second five is worse, because this change's own headline
  claimed to have fixed it: the retired *"send `error` instead"* argument was still on `SessionError`, the
  interface `GenericError` now `extends`, 140 lines above the rewritten block — so the contradiction moved
  inside one file instead of ending, and a #444 implementer reading the base was told to do the thing this
  slice removed, with seven line numbers that had drifted onto a `break` and three comments. Two files were
  where the first pass looked; the six places it then found were the ones that mention `error` by name. What it
  did not do was re-read the **paragraph above each edit**, and four of the five survivors were exactly that.
- **`typeAssertions` needed two edits and a relocation.** One line was in the must-compile section and failed
  under `pnpm --filter @tapflowio/protocol typecheck`, which `tsc -b` does not cover. And the `@ts-expect-error`
  being flipped was the file's **only whole-message excess-property assertion** — flipping it would have retired
  an assertion class as a side effect, so the guard moved to another message instead.
- **Fixtures the compiler cannot see.** Two `mcp-server` fixtures send `error` through a fake relay typed
  `Record<string, unknown>`; they carried neither `sessionId` nor the already-required `reason` and passed only
  because of the escape. `flow-runner` had **no `error` fixture at all**, so removing its escape was untested in
  both directions — three tests now cover it.

- **The remaining `msg.sessionId!` count was wrong, and its composition was the misleading half.** A first
  draft of this note said "the eleven left are all agent→browser forwards". There were **twelve**, and four
  were not forwards: `stream:register`, `device:shutdown`, `forwardUnacked` and `handleAckedInput` — whose
  assertion was **dead**, since L5c's door predicate had already narrowed that parameter to
  `sessionId: string`. Removing it leaves eleven, of which eight are forwards and three are request-side
  paths that deliberately carry no address gate. "All forwards" invited the conclusion that the request side
  was settled, while `device:shutdown` sits on it with no ownership gate either (#527). The count and the
  composition are now recorded next to the sites, with an instruction to re-derive rather than trust the
  sentence.

## Mutations

Ten in the author's round, none surviving — and then **four more from review, all four alive**, which is the
number worth reporting.

- **`session:joined`'s address held nothing.** Pointing it at `session.deviceId` passed relay 620, ios 382,
  android 263 and the static suite, while **no client could join at all**: both clients match
  `sessionId === mine` strictly and the dashboard's gate drops the rest. This slice added four assertions that
  each *refusal* names the right session and zero that the *reply* does — and the reply is the half that was
  already strict, so it had the largest blast radius and the least cover. The agent suites miss it because they
  wait on the type alone.
- **The mcp skew log's stated reason was free**, and its keying contradicted its own docstring. Adding
  `&& this.waiters.length > 0` passed 81, so nothing held the "recorded whether or not anything is waiting"
  claim — which exists for the refusal that arrives *after* its join gave up, the one caller who has been told
  "timed out" with no cause. Worse, the record keyed on the literal `'a pending join'`, so it was once per
  **process** rather than once per session: against an old relay the first refused session logged and every
  later one was silent. Keying per session is not available — the frame carries no address and `Waiter` keeps
  its predicate as a closure — and naming one anyway is a guess between pending joins, which is the false
  attribution this slice removes. So it is once per **client**, which is the honest cardinality: an agent is
  per session, a relay is per client.
- **`flow-runner`'s once-guard was free too.** Its fixture answered a single `session:start`, so "once" and
  "every time" were indistinguishable. The premise that flow-runner already held all three properties was
  two-thirds true.
- **The gate's new reach over `error` was unpinned in both directions.** Exempting `error` passed all 329.
  Unreachable today because `useRelay` opens a socket per hook, but the unreachability expires with #527, and
  then a foreign `session-not-found` tears down a healthy viewer. Four on the relay's `error` exits — and the fourth, the `join()` catch, **survived at
first**: it is reached only when `join()` throws for something the two checks above it do not cover, so no
existing test touched it. Forced with a spy rather than left unpinned, on the rule the previous slice arrived at:
an address no test can hold is one that will drift.

Three more on the mcp client survived at first for a subtler reason — the foreign-address test does not exercise
the `sessionId === undefined` escape, because that half only fires for a refusal carrying **no** address. The
test that holds it is the unaddressed one, and it holds the skew log and its once-guard too.
