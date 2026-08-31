#!/usr/bin/env node
// The `gh api` half of `.claude/hooks/pr-merge-guard.sh`. Reads the PreToolUse payload on stdin,
// exits 0 to allow and 2 to block. The `gh pr merge` half stays in the shell, where a text matcher
// is the right tool — see `scripts/lib/pr-merge.mjs` for why these are two questions.
import { judge } from './lib/pr-merge.mjs'

const WHAT = {
  merge: 'merging a PR through the API',
  review: 'submitting a PR review through the API',
}

let raw = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) raw += chunk

// Fail open on anything unparseable, matching every other gate in this directory.
let cmd
try {
  const payload = JSON.parse(raw)
  cmd = payload?.tool_input?.command
  // A payload with no `command` is judged on the whole payload, the way the shell half does.
  if (typeof cmd !== 'string' || !cmd) cmd = raw
} catch { process.exit(0) }
if (!cmd) process.exit(0)

let verdict
try { verdict = judge(cmd) } catch { process.exit(0) }
if (!verdict.blocked) process.exit(0)

process.stderr.write(`Blocked: ${WHAT[verdict.reason]}.

Creating the PR is yours to do; merging and approving are the user's — leave them, even with --admin
(AGENTS.md > Core Principles). Reaching the same endpoint through \`gh api\` is the same action.

A read of the same path is allowed: \`--method GET\` asks whether a PR is merged, or lists its
reviews, without doing either.
`)
process.exit(2)
