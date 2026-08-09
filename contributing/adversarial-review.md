---
type: rules
topics: [process, review, quality]
status: living
---

# Adversarial review — how to run one, and how to keep it cheap

> The gate itself is stated in the root [AGENTS.md](../AGENTS.md): every code-change PR needs an
> independent review, recorded in `.work/reviews/<branch>.md` with the full 40-character HEAD hash,
> and a PreToolUse hook enforces it. **This file is the how.** Read it before launching a reviewer —
> the difference between a 4-minute review and a 106-minute one is entirely in how the prompt is
> written.

## Why an independent context

The authoring session inherits its own assumptions. It cannot refute them, because the reasoning that
produced the diff is the same reasoning that would have to find the hole. So the reviewer must be a
context that has **not** seen the working conversation — given only the diff, repo access, and a
refute-first prompt.

Docs-only PRs may skip the review itself, but still write the record with the skip reason. The gate
always requires the record.

## Channels

- **Default reviewer**: a fresh subagent given only the diff, repo access, and a refute-first prompt —
  "find bugs, contract violations, and missing cases; verify every claim with commands; report
  findings with severity and evidence, plus a checked-and-cleared list". Do not share the authoring
  session's reasoning with it.
- **Escalation**: protocol / public-interface / release-infrastructure changes get a second
  independent channel — a second subagent with a different lens, or Codex for cross-model
  independence.

## Keeping a review affordable

Review wall-clock is dominated by **what the reviewer has to execute**, not by how hard it thinks.
Measured across one session: a read-and-probe review of a protocol change took 11 minutes at 93k
tokens; a review of ~590 lines of tooling took **106 minutes at only 134k tokens** — fewer tokens,
10× the time, because it spent that time on `pnpm install`, `pnpm build`, starting real dev servers
and waiting out sleeps.

- **Only use an isolated worktree when the reviewer must edit files.** A fresh worktree has no
  `node_modules` and no `dist`, so it pays 8–10 minutes of install and build before it can run
  anything — and a reviewer that does not know this reports results from commands that silently did
  nothing (`vitest: command not found` swallowed by a shell exit). A read-only lens (contract,
  compatibility, documentation) can work against the primary checkout, which is already built.
- **Say what to install.** When a worktree is required, the prompt must open with
  `pnpm install --frozen-lockfile && pnpm build`, or the first `pnpm test` result is meaningless.
- **Do the mutation testing yourself, then hand over the list.** Ask the reviewer to find what your
  mutations *missed*, not to redo them. Every surviving mutation found so far came from someone
  imagining a different way to break a test — never from running more of them.
- **No blanket "run it 10 times".** Repeat runs have found zero flakes across two rounds; they cost
  4+ minutes each time. Ask for 3 runs, and only for tests that use timers or real sleeps.
- **Split by lens and run the lenses in parallel.** Wall-clock is then the slowest lens, not the sum.
  Two channels on the same commit took 11 and 40 minutes concurrently, against 51 serially.
- **A design review can be made to execute nothing at all.** This is the cheapest review there is, so
  there is no excuse for skipping the one the cross-cutting section below requires. Hand the reviewer
  the measurements you already took and **forbid re-running them**, name the files to read so it does
  not sweep the tree, list the commands it must not run (`eslint`, `pnpm test`, `tsc`, `pnpm build`),
  cap the findings (4 is enough), and state a time budget. Two lenses over a plan plus its
  uncommitted diff came back in **4m30s and 3m25s at 83k / 74k tokens**, wall-clock 4m30s in
  parallel. The measurements in the prompt were what made it cheap — a reviewer told "src 40 files,
  hooks 13, components 51, lib 19, and here are the 2 errors" spends its time judging instead of
  counting.
- **Verify the reviewer's grounds, not just its verdict.** On that plan a `blocker` rested on correct
  evidence carrying the wrong weight: the component it flagged is an unused export that never
  renders, so the regression it predicted could not occur. The conclusion survived and the reason
  changed — which matters, because the reason is what goes in the record. Grade severity yourself. A
  finding whose evidence you have not reproduced is a hypothesis, including when it agrees with you.
- **Some cost is irreducible.** Verifying code that kills processes means starting and killing
  processes, with real waits. Budget for it and say so up front, rather than discovering it at 100
  minutes.

## The cleared list ages with the diff

A reviewer's "checked and cleared" list describes the code **as the reviewer read it**. Fixing the
findings changes that code — so **after applying the fixes, re-check whether any fix invalidated a
cleared item.** The list is evidence, not a warranty, and it expires the moment you edit.

This is not a hypothetical. On #503 a reviewer cleared `setAgentCapabilities(msg.capabilities ?? [])`:
type-dead now that `capabilities` is required, but live at runtime, and *"removing it would be caught
by `sessionScope.test.tsx:35,74`"*. That was true when it was written. Both of those lines were
`{ type: 'session:joined' } as BrowserInbound` — a fixture omitting the field — and a later finding in
the same review was that those casts must go. Typing the fixtures correctly is right, and it silently
removed the fallback's only coverage: the mutation went from caught to surviving all 297 tests, with
nothing failing to say so.

The failure mode is specific and worth naming: **a cleared item whose grounds are a test, where
another finding changes that test.** So:

- When a review yields several findings, treat the cleared list as **one of the things the fixes can
  break**. Read it again at the end, not once at the start.
- If a cleared item's grounds were "a test catches this", re-run that mutation after the fixes. Being
  told a mutation is caught is not the same as it being caught now.
- Record the reversal in the review file rather than quietly deleting it — strike the original and say
  what overturned it. Someone later needs to know the clearance was real and then stopped being real.

The same applies to your own mutation results: a mutation you ran before the fixes was run against
code that no longer exists.

### A prompt skeleton that stays cheap

What made the 4m30s pair cheap was structural, not stylistic. Each prompt carried:

1. **One lens, named.** "Your lens is whether the uncommitted diff changes runtime behaviour" — not
   a list of five concerns.
2. **The measurements, as premises.** File counts, error counts, config contents, wired-up scripts —
   whatever you already ran. Followed by: do not re-run these.
3. **The files to read, listed.** Otherwise the reviewer greps the tree to find them.
4. **The commands not to run**, by name.
5. **A findings cap and a time budget.**
6. **A required "checked and cleared" list**, so coverage is visible when nothing is found.

## Cross-cutting changes — review the design before the code

Applies when a change spans **two or more packages, or both platforms**. Skip it for work inside one
package.

1. **Write the invariant table first** — one row per path or state, one column per platform, and what
   the *user* observes. Put it in the plan document. The clipboard bridge took eleven review rounds
   largely because this table was never written: the same class of defect (one platform fixed, the
   other not) was found five separate times, each by a reviewer rather than by looking.
2. **Review the design before the code.** One adversarial pass over the plan and that table, before
   implementing. The expensive rounds on a multi-package feature are the ones where the mechanism
   itself was wrong, and a wrong mechanism is cheapest to find on paper. This is **in addition to**
   the pre-PR review, not instead of it.
3. **A design-level review finding means replan, not patch.** If a reviewer says the *shape* is wrong
   — wrong scope for a flag, wrong owner for a decision — stop and redo that part. Patching a design
   finding produced the next design finding three times in a row on the clipboard branch.
4. **Mutate the guards too.** A test written to catch drift or protect an invariant is itself untested
   until you break the thing it guards and watch it fail — and until you run it **alone**. Three
   separate guards on the clipboard branch had the very hole they were written to close, including
   one that only worked because a sibling `describe` leaked its environment.

A worked example of the payoff: a two-package chore planned two code edits to satisfy new lint
errors. The design pass established that one error was a false positive on a load-bearing rotation
path and the other sat in an export that never renders — both planned edits became suppressions with
recorded reasons, and the regressions they would have introduced had no test to catch them. Cost: 4
minutes 30 seconds.

## The record

Write findings + dispositions (fixed, or skipped with a reason) to `.work/reviews/<branch>.md`
(slashes → `__`), including the **full 40-character HEAD hash** (`git rev-parse HEAD` — an
abbreviated hash will not pass the gate). Mention the review in the PR body.

The hook `.claude/hooks/adversarial-review-gate.sh` blocks PR creation unless that record exists and
references the current HEAD. **Any commit after the review invalidates the record** until it is
refreshed against the new diff — including a commit that only fixes what the review found.

Record the dispositions honestly. A finding you skipped needs the reason in writing; a finding whose
severity you re-graded needs the re-grading and its basis, not a silent downgrade. The record is read
later by someone deciding whether a defect was known.
