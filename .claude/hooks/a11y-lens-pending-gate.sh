#!/usr/bin/env bash
# Stop: if an a11y-lens pre-commit check was skipped and its files are still unreviewed, block
# finishing once and ask for `a11y-lens check --pending`.
#
# **Why a gate at all.** The pre-commit job never blocks on its own infrastructure — a timeout, an
# agent error, unparseable output, a file dropped for the prompt budget — so it exits 0 and lefthook
# prints the same ✔️ as a clean run (#827). a11y-lens records those files under the git common dir,
# and this is where somebody finally hears about it: an agent session usually ends right after its
# last commit, before any later commit could print the CLI's own warning.
#
# **Satisfied inside the session, not only by the files.** Stop fires at the end of every turn, and
# `--pending` is the same agent call that just failed; if it fails again the files stay, and a gate
# that looked only at them would block every turn after. So one `--pending` run in this session's
# transcript passes, the way one `/ai-tells` run passes `docs-aitells-gate.sh`.
#
# **Reads the layout, not the records.** a11y-lens documents `<git-common-dir>/a11y-lens/pending/
# *.json` as a public contract; counting files there needs no schema. The test builds its fixture
# with the installed CLI rather than by hand, so a layout change in an upgrade fails it instead of
# turning this gate silently off.
#
# English, because `.claude/` is committed and a contributor's agent reads it.
set -euo pipefail

input=$(cat)

# Fail open on anything unparseable, like every other gate in this directory.
active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null) || exit 0
[ "$active" = "true" ] && exit 0

common=$(cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
count=$(find "$common/a11y-lens/pending" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ') || exit 0
[ "${count:-0}" -gt 0 ] || exit 0

tx=$(printf '%s' "$input" | jq -r '.transcript_path // ""' 2>/dev/null) || tx=""
if [ -n "$tx" ] && [ -f "$tx" ]; then
  ran=$(jq -rR 'fromjson? | .message.content[]? | select(.type=="tool_use" and .name=="Bash") | .input.command // empty | select(test("a11y-lens\\s+check\\b.*--pending"))' "$tx" 2>/dev/null | wc -l) || ran=0
  [ "${ran:-0}" -gt 0 ] && exit 0
fi

jq -n '{
  decision: "block",
  reason: "An a11y-lens pre-commit check was skipped (timeout, agent error, or prompt budget), so some committed UI files were never reviewed. Run `pnpm exec a11y-lens check --pending` and address any errors it reports. To skip deliberately, just stop again and this passes."
}'
exit 0
