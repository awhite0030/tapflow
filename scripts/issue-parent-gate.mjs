#!/usr/bin/env node
// The decision half of `.claude/hooks/issue-parent-gate.sh`. Reads the PreToolUse payload on stdin,
// exits 0 to allow and 2 to block. Kept out of the shell because the rules are parsing rules and the
// shell version got three of them wrong — see `scripts/lib/issue-parent.mjs`.
import { judge } from './lib/issue-parent.mjs'

const MESSAGE = `Blocked: this issue names no parent.

An issue split out of other work needs a line of its own in the body:

    Parent: #607

so the work it came from can enumerate what it still owes. Prose like "raised by the review of #647"
does not count — nothing can build a checklist from it, which is how nine issues from one day of
work on #607 became unreachable from #607.

If it genuinely stands alone — a reported bug, a chore, a new idea — say so instead, with a reason:

    <!-- standalone: reported by a user, not split out of anything -->

And before filing at all: a finding under ~10 lines that the lens you are already running can judge
is fixed in that PR, not deferred. AGENTS.md > "An adjacent defect is fixed here unless it needs its
own decision".`

let raw = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) raw += chunk

// Fail open on anything unparseable, matching the other gates in this directory: this guards a
// cooperative-but-forgetful agent, not an adversary, and a gate that dies noisily on a malformed
// payload would block every Bash call in the session.
let cmd
try { cmd = JSON.parse(raw)?.tool_input?.command ?? '' } catch { process.exit(0) }
if (typeof cmd !== 'string' || !cmd) process.exit(0)

let verdict
try { verdict = judge(cmd) } catch { process.exit(0) }
if (!verdict.blocked) process.exit(0)
process.stderr.write(`${MESSAGE}\n`)
process.exit(2)
