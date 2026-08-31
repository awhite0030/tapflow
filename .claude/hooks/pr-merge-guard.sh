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

# Join backslash-newline continuations before matching. grep decides line by
# line, so `gh \` / `pr \` / `merge` on three physical lines reads as three
# non-matching lines while bash executes it as one `gh pr merge`. Verified: the
# unjoined form passed the matcher at exit 0.
#
# Delete the pair, substituting NOTHING — bash inserts no space, and the pair
# can split a word. Substituting a space was wrong in both directions, measured:
#   g\<nl>h pr merge  -> bash runs `gh pr merge`; a space gives `g h pr merge`,
#                        which does not match — a live bypass.
#   gh\<nl>pr merge   -> bash runs `ghpr merge`, not gh at all; a space gives
#                        `gh pr merge`, which blocks a command that is not one.
# Indentation after the newline is likewise kept, because bash keeps it: it
# stays as the whitespace separating the next word, which `[[:space:]]+` covers.
#
# A backslash-newline inside single quotes is literal, not a continuation, so
# joining can in principle over-match quoted prose. That direction is the safe
# one, and the block message says to split such text into its own command.
cmd=$(printf '%s' "$cmd" | perl -0777 -pe 's/\\\r?\n//g') || exit 0

printf '%s' "$cmd" | grep -qE '(^[[:space:]]*|(;|&&|\||\$\()[[:space:]]*|(^|[[:space:]])(then|do)[[:space:]]+)gh[[:space:]]+pr[[:space:]]+(merge|review)' || exit 0

echo "Blocked: creating the PR is yours to do; merging and approving are the user's — leave them, even with --admin (AGENTS.md > Core Principles). If this command is not actually merging or approving (the text merely mentions the command), split that text into a separate command." >&2
exit 2
