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
# **This file is only the prefilter.** Deciding needs the command tokenized and the body parsed, and
# the version that tried both in shell got three rules wrong at once — `gh issue new` walked through,
# so did an environment assignment before `gh`, `-F "issue body.md"` read a file called `issue`, and
# a `--title` could satisfy a rule about bodies. The decision is in `scripts/issue-parent-gate.mjs`,
# where it is tested. Node is spawned only for a command that mentions both words, which is rare.

input=$(cat)
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

case "$input" in
  *gh*issue*) ;;
  *) exit 0 ;;
esac
[ -f scripts/issue-parent-gate.mjs ] || exit 0

printf '%s' "$input" | node scripts/issue-parent-gate.mjs
