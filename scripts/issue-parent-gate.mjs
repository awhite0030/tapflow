#!/usr/bin/env node
// The decision half of `.claude/hooks/issue-parent-gate.sh`. Reads the PreToolUse payload on stdin,
// exits 0 to allow and 2 to block. Kept out of the shell because the rules are parsing rules and the
// shell version got three of them wrong — see `scripts/lib/issue-parent.mjs`.
//
// **A blocked command is told which rule it broke.** This file used to print one constant for all
// three outcomes, so a body file the gate could not open was answered with the parent rule — and the
// author goes to add a line the body already has. That happened filing #700, whose body carried
// `Parent: #609` the whole time; the real fault was a relative `--body-file` resolved against the
// repo root rather than the directory the command would have run in.
import { judge } from './lib/issue-parent.mjs'

const NO_PARENT = `Blocked: this issue names no parent.

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

const NO_BODY = `Blocked: no body could be read from this issue creation.

The gate reads --body, --body-file, or the heredoc behind \`--body-file -\`. It found none of them,
or found several heredocs and will not guess which one is the body.

Nothing has been decided about the Parent: line — the body was never read.`

/** Names the path that was opened, because the reason it was not found is never in the command. */
const unreadableBodyFile = (detail) => `Blocked: ${detail}

The gate runs from the repository root, not from the directory your command runs in, so a relative
--body-file resolves against the repo. Pass an absolute path, or --body, and re-run.

Nothing has been decided about the Parent: line — the body was never read.`

const MESSAGES = {
  'no-parent': () => NO_PARENT,
  'no-body': () => NO_BODY,
  'unreadable-body-file': unreadableBodyFile,
}

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

// An unrecognised reason falls back to the parent rule rather than to silence: a new reason added
// without a message here should still block, since blocking is what the verdict said.
const message = (MESSAGES[verdict.reason] ?? MESSAGES['no-parent'])(verdict.detail)
process.stderr.write(`${message}\n`)
process.exit(2)
