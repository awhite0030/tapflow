---
type: rules
topics: [testing, static-checks, review, quality]
status: living
related: [adversarial-review]
---

# What a test or a guard has to execute to actually hold its claim

> Read this **before writing a static check, or a test that asserts something does not happen.**
> Companion to [adversarial-review.md](./adversarial-review.md), which covers the review itself. This
> side is about the moment before there is anything to review.

Promoted from a program-length wire-contract redesign (`protocol` / `relay` / both agents / two
clients / dashboard, ~10 merged PRs). Across those PRs the **majority of review findings were defects
in the author's own work**, and the same four shapes kept producing them. Each rule below is here
because it was paid for at least twice.

The common root: **a claim written in prose reads, to the author and to a reviewer, as a claim that is
enforced.** A green suite is not evidence that a test holds what its name says. It is evidence that
nothing in the suite currently fails.

---

## 1. A check must execute the lesson its own header cites

The **first draft** of `scripts/__tests__/clientOutboundTyped.test.mjs` opened by citing a sibling
check's failure — *"anchoring on a name's spelling gets bypassed"* — and was then written **in exactly
that way**: two assertions pinned to the literal `private send(`. One extra helper, and a mistyped
message went to the wire with 7/7 green. (The file on disk is the corrected version: it now anchors on
**serialization** — the enclosing function of a `JSON.stringify` — and its header records what the
first draft got wrong. Read it there rather than trusting this paragraph.)

Writing the lesson down reads as having applied it. So when you write a check, **mutate every claim in
its header.** If the header says "anchored on X rather than on the name", run the mutation that
changes the name. If a claim cannot be made to fail, it is decoration — delete it or make it real.

And **read the sibling that already got it right.** `agentSendTyped` had reached a rule over three
rounds (*"in a file that writes to a socket, `JSON.stringify` appears only inside the send helper"*)
one file away. Citing its existence while reinventing the shape — more weakly — is how the same hole
gets reopened.

This is the static-check form of "the reason written beside the code is part of the fix." **If the
stated reason is false, that is a defect in the check, not in its documentation.**

## 2. A test that asserts absence is verified only by the mutation that creates the absence

Four tests pinned *"a request with no id is dropped"*. All four were green, all four shipped, and
**all four passed for the wrong reason**:

```ts
const reply = waitForTypeOrNull(sock, type, 0)   // 0ms deadline → null on the next tick
send(...)
await barrier(sock)                              // the round trip finishes after that
expect(await reply).toBeNull()                   // passes whether or not it was dropped
```

A test asserting **existence** (`expect(x).toBe(y)`) is self-verifying: a wrong value fails it. A test
asserting **absence** is not — passing when nothing happens *is its definition*, so it cannot
distinguish that from a bug that makes nothing happen.

→ **A test using `toBeNull`, `not.toHaveBeenCalled` or `not.toBeInTheDocument` gets the mutation that
creates the absence, before it is committed.** In the round that produced those four, the only sound
test was the one whose mutation had been run.

**Order:** send → `await barrier` → *then* read the recording with a 0ms deadline. The barrier is
evidence the other side finished; a deadline is a guess about timing.

**And a passing mutation proves "can fail", not "always fails".** After those four were fixed, one was
still a race — right order, **wrong socket**:

```ts
browser.send(request)     // trigger on the browser connection
await barrier(agent)      // synchronised on the agent connection
```

WebSocket ordering holds **within a connection**, so the relay answering the agent's ping is no
evidence it processed the browser's request. That test failed correctly under mutation anyway, because
today's relay happens to be synchronous enough — so the mutation did not disprove the race.

→ **Synchronise an absence assertion on the connection the trigger went out on.** Different
connections for trigger and observation need two barriers, trigger side first. A trigger that is a
direct function call (an agent test calling `handleRelayMessage`) involves no socket, so the
observation-side barrier alone is enough — that distinction is why only one of the four needed the fix.

## 3. A guard must not enumerate using the mechanism it forbids — and a spelling assertion needs a structural twin

A guard forbidding file enumeration via `git ls-files` was bypassed **four ways** by one reviewer, each
with the hole open and the whole suite green:

- **Move the call to a sibling helper and it is out of range.** The scan looked at `*.test.mjs` only —
  and the very change that added the guard had created the helper idiom it needed to cover. The next
  person writes `trackedFiles.mjs`. → scan recursively, and add a **structural** assertion that does
  not depend on spelling ("a module that calls `sources()` must import it from `./sourceFiles.mjs`").
- **The regex required adjacent quotes**, so template literals and string concatenation passed — and
  `git ls-tree` does not contain the forbidden string at all. → **write down that a spelling assertion
  does not catch deliberate obfuscation.** It is a floor, not a fence.
- **`readdirSync` does not recurse but the vitest `include` does**, so checks in subdirectories ran
  while being invisible to the guard.
- **An extraction silently dropped `.d.ts`** — pure coverage loss, and declaration files are exactly
  what one of the three callers is about.

The anti-vacuity floor is what caught a fifth (reusing a source skip-set for a module walk, cutting the
scan to 7 files). **Set that floor from the measured count, not a round number.**

## 4. Aim the mutation at the path that already worked

A slice that gave `error` an address asserted **four times** that each *refusal* names the right
session, and **zero times** that the *success reply* does. Pointing `session:joined`'s address at the
wrong field left relay 620, ios 382, android 263 and the static suite all green — while **no client
could join at all.**

Attention goes the wrong way by default. The new field is visible, so it gets tests; the half that was
already strict reads as "the part that already worked", so it gets none. **The blast radius is the
other way round**: both clients matched the reply strictly, so a wrong address there kills the feature,
while a wrong address on a refusal misdiagnoses one session.

→ When a change adds or moves a field, **mutate the success path first**, then the error paths.

**A suite that waits on a type says nothing about the payload.** Those agent suites use
`waitForType(browser, 'session:joined')` — type only. Green there was never evidence about the address,
and reading the helper is what shows it.

---

## Where the rest of that program's decisions live

Most of them are **not here on purpose.** The rationale for a rule belongs beside the code it governs
(`packages/protocol/AGENTS.md`, `packages/relay/AGENTS.md`, the docstring on the function), and this
directory's own rule is to read that record before changing the code it describes. A second copy here
would go stale independently of the first — which is the failure mode
[adversarial-review.md](./adversarial-review.md) documents under "the justification is part of the
change".

What earned a place here is the subset with **no code to sit beside**: rules about what a test or a
guard must *execute*, which are otherwise remembered rather than enforced.
