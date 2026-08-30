#!/bin/bash
# PreToolUse(Bash) gate: a PR or issue title and body are written in English.
#
# **It replaces an inline perl regex in `settings.json`**, which matched
# `/gh\s+(pr|issue)\s+(create|edit)/` against the whole command and blocked anything that also
# contained Hangul. Measured: a `node -e` script investigating this very gate carried
# `gh issue create` inside a JS string literal and Korean in a `console.log` label, and was refused
# as an issue creation. It creates no issue. That is the mistake `issue-parent-gate.sh` next to it
# was written to end, still live one hook over.
#
# The regex was also blind in the other direction. It saw only the command text, so Korean in a
# `--body-file` — the form CONTRIBUTING tells everyone to use — was never looked at.
#
# **This file is only the prefilter.** Deciding needs the command tokenized and the body read, which
# is `scripts/gh-language-gate.mjs`, where it is tested. Node is spawned only for a command that
# mentions `gh` and one of the two nouns, which is rare.

input=$(cat)
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

case "$input" in
  *gh*issue*|*gh*pr*) ;;
  *) exit 0 ;;
esac
[ -f scripts/gh-language-gate.mjs ] || exit 0

printf '%s' "$input" | node scripts/gh-language-gate.mjs
