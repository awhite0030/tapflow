#!/usr/bin/env node
// The deciding half of `.claude/hooks/pr-merge-guard.sh`. Reads the PreToolUse payload on stdin,
// exits 0 to allow and 2 to block. It judges both roads to the same two actions — the `gh pr` verbs
// and the `gh api` endpoints — because the shell matcher it sits behind misses every prefixed and
// wrapped spelling of the first. See `scripts/lib/pr-merge.mjs`.
import { judge } from './lib/pr-merge.mjs'

const WHAT = {
  merge: 'merging a PR',
  review: 'submitting a PR review',
}

let raw = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) raw += chunk

// Fail open on anything unparseable, matching every other gate in this directory.
let cmd
let cwd
try {
  const payload = JSON.parse(raw)
  cmd = payload?.tool_input?.command
  // A payload with no `command` is judged on the whole payload, the way the shell half does.
  if (typeof cmd !== 'string' || !cmd) cmd = raw
  // The directory the command would run in, so a `@file` in a GraphQL field is read from the tree
  // the session is in rather than from wherever the hook was launched.
  cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd()
} catch { process.exit(0) }
if (!cmd) process.exit(0)

let verdict
try { verdict = judge(cmd, cwd) } catch { process.exit(0) }
if (!verdict.blocked) process.exit(0)

process.stderr.write(`Blocked: ${WHAT[verdict.reason]}.

Creating the PR is yours to do; merging and approving are the user's — leave them, even with --admin
(AGENTS.md > Core Principles). Reaching the same endpoint through \`gh api\` is the same action.

A read of the same path is allowed: \`--method GET\` asks whether a PR is merged, or lists its
reviews, without doing either.
`)
process.exit(2)
