#!/bin/bash
# PreToolUse(Bash) gate: an issue split out of other work has to name what it came from.
#
# **The problem this exists for is measured, not hypothetical.** One day of work on #607 produced
# nine issues, and not one of them was reachable *from* #607 — every review finding graded `later`
# became a sibling nobody could enumerate. Asked "is #607 finished?", the honest answer was that
# nobody could tell, because the feature's remaining surface existed only as nine unlinked rows in a
# tracker sorted by date. Two of those nine were closed minutes later as things that should never
# have been filed.
#
# Prose mentions are not the fix and were already there: most of those nine said "raised by the
# review of #647" somewhere in the body. GitHub builds no tree from that, and neither can a script.
# A `Parent:` line is greppable, so the parent's checklist can be regenerated instead of maintained
# by memory.
#
# Standalone issues are normal — a bug someone reports, a chore, an idea. They opt out by saying so,
# which costs one line and makes the choice visible in the issue itself.
#
# Fail-open on a missing/unparseable payload, matching the other gates in this directory: this guards
# a cooperative-but-forgetful agent, not an adversary, and failing closed would block every Bash call
# in the session on a missing jq.

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""') || exit 0

# Command position only, the same rule pr-merge-guard.sh uses: a substring match would fire on this
# repo's own docs, which discuss `gh issue create` by name.
printf '%s' "$cmd" \
  | tr '\n' ' ' \
  | grep -qE '(^|[;&|]|\$\(|\bthen\b|\bdo\b)[[:space:]]*gh[[:space:]]+issue[[:space:]]+create' || exit 0

# Either a parent, or an explicit standalone marker. `Parent: #123` / `Parent: owner/repo#123`.
if printf '%s' "$cmd" | grep -qE 'Parent:[[:space:]]*[A-Za-z0-9_.\/-]*#[0-9]+'; then exit 0; fi
if printf '%s' "$cmd" | grep -qF '<!-- standalone:'; then exit 0; fi

cat >&2 <<'MSG'
Blocked: this issue names no parent.

An issue split out of other work needs a line of its own in the body:

    Parent: #607

so the work it came from can enumerate what it still owes. Prose like "raised by the review of #647"
does not count — nothing can build a checklist from it, which is how nine issues from one day of
work on #607 became unreachable from #607.

If it genuinely stands alone — a reported bug, a chore, a new idea — say so instead:

    <!-- standalone: reported by a user, not split out of anything -->

And before filing at all: a finding under ~10 lines that the lens you are already running can judge
is fixed in that PR, not deferred. AGENTS.md > "An adjacent defect is fixed here unless it needs its
own decision".
MSG
exit 2
