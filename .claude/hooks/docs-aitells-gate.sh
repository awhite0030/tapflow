#!/usr/bin/env bash
# Stop: if this session edited docs/*.md and never ran /ai-tells detect, block finishing and ask for
# the pass. Running ai-tells once satisfies it, so there is no loop.
#
# **English, because a contributor's agent reads it.** `.claude/` is committed, so these hooks fire
# for anyone working in the repo with Claude Code — measured: #698 arrived from a first-time
# contributor carrying a `.work/reviews/` record, which exists only because a hook demanded one.
# A Korean-language block is unreadable to exactly the people AGENTS.md says to write English for.
set -euo pipefail

input=$(cat)

# **Fail open on anything unparseable**, the way every other gate in this directory does. Under
# `set -e` a bare `jq` on a malformed payload took the whole script down with jq's own exit 5, which
# is not the clean pass this is supposed to be — and `pr-merge-guard.sh` is the calibration for how
# long a hook can be wrong about its payload without anyone noticing: 2191 parse failures to 1
# success, across 150 sessions.
tx=$(printf '%s' "$input" | jq -r '.transcript_path // ""' 2>/dev/null) || exit 0
[ -f "$tx" ] || exit 0

# Safety net: if the Stop hook has already re-entered after blocking (stop_hook_active), let it
# through so the user can deliberately skip — a scripting error must not block forever.
active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null) || exit 0
[ "$active" = "true" ] && exit 0

# How many times docs/*.md was edited.
#
# **`file_path` is not the first field of the tool input, and requiring it to be made this gate see
# 6 of 34 docs edits.** `Write` serialises `{"file_path": …}`, so it matched; `Edit` serialises
# `{"replace_all": false, "file_path": …}` and never did — 1102 `Edit` records in this project's
# transcripts, not one of them adjacent. Editing an existing doc is what `Edit` is for, so the gate
# was blind to the common case and green about it. Scoped to the same `input` object with `[^}]*`
# rather than to the whole line, which keeps an unrelated tool call on the same line out of it.
edited=$(grep -cE '"name":"(Edit|Write|MultiEdit)","input":\{[^}]*"file_path":"[^"]*/docs/[^"]*\.md' "$tx" || true)
# How many times the ai-tells skill was invoked. Matched on the key rather than on the reminder's
# own wording, which would otherwise satisfy the gate by being injected.
ran=$(grep -cE '"skill": *"ai-tells"' "$tx" || true)

if [ "${edited:-0}" -gt 0 ] && [ "${ran:-0}" -eq 0 ]; then
  jq -n '{
    decision: "block",
    reason: "This session edited docs/ but never ran /ai-tells detect. Check the prose before finishing — translationese in KO, em-dash asides, word order. To skip deliberately, just stop again and this passes."
  }'
fi
exit 0
