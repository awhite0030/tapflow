#!/bin/bash
# PreToolUse(Bash) gate: blocks `gh pr merge` / `gh pr review`, because merging
# and approving are the user's to do (AGENTS.md > Core Principles).
#
# This lived inline in .claude/settings.json until it was found inert: it piped
# the payload through `echo "$input"`, which expands backslash escapes, so jq
# never parsed a command containing \n or \" and the grep decided on an empty
# string. Measured across 150 sessions: 2191 parse failures against 1 success —
# every multi-line command passed unguarded. Reading stdin with printf is the fix.
#
# Match the invocation only in command position: line start, after ; && |,
# inside $( ) capture, or after then/do. A plain substring match would
# false-positive on commit messages / docs that merely mention the command —
# and this repo's own docs discuss `gh pr merge` by name.
# Backticks are deliberately NOT a command position (markdown quoting).
#
# Fail-open by design (jq missing, unparseable payload), matching
# adversarial-review-gate.sh: this gate guards a cooperative-but-forgetful
# agent, not an adversary. Fail-closed here would block every Bash call in the
# session on a missing jq, and the 2191 failures above are the calibration for
# how long such a break can go unnoticed.
#
# Not covered, deliberately: the `gh api` / git plumbing equivalents. Same
# threat model — see the issue linked from the review record.

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""') || exit 0

printf '%s' "$cmd" | grep -qE '(^[[:space:]]*|(;|&&|\||\$\()[[:space:]]*|(^|[[:space:]])(then|do)[[:space:]]+)gh[[:space:]]+pr[[:space:]]+(merge|review)' || exit 0

echo "Blocked: PR merge/approve는 직접 수행해주세요. Creating the PR is yours to do; merging and approving are the user's — leave them, even with --admin (AGENTS.md > Core Principles). If this command is not actually merging or approving (the text merely mentions the command), split that text into a separate command." >&2
exit 2
