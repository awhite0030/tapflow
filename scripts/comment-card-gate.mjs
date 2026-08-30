#!/usr/bin/env node
// The decision half of `.claude/hooks/comment-card-gate.sh`. Reads the PreToolUse payload on stdin,
// exits 0 to allow and 2 to block.
//
// **PreToolUse, not Stop.** The sibling prose gate runs at Stop, which is right for a file — you can
// still edit it. A comment is public the moment the command runs, so the only stage where a check
// can change anything is before it.
import path from 'node:path'
import { judge } from './lib/comment-card.mjs'

const CARD = '.work/COMMENT-CARD.md'

const message = `Blocked: read ${CARD} before writing this comment.

It is one page, and it is there because a comment written from scratch each time reads like a
different person. The rules it carries are the ones your own edits produced — name the comment's
job, say only what is new since your last comment on this thread, and file a finding with no action
for this reader as an issue instead.

Read it, then run this command again.`

let raw = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) raw += chunk

// Fail open on anything unparseable, matching every other gate in this directory: these guard a
// cooperative-but-forgetful agent, and a gate that dies would block every Bash call in the session.
let payload
try { payload = JSON.parse(raw) } catch { process.exit(0) }

const cmd = payload?.tool_input?.command
if (typeof cmd !== 'string' || !cmd) process.exit(0)

// Fail open here too. Every other missing field lets the command through; a missing transcript is
// the one that used to block, which is the wrong direction for a gate whose whole posture is that
// it guards a cooperative reader.
const transcript = payload?.transcript_path
if (typeof transcript !== 'string' || !transcript) process.exit(0)

// **The shell already resolved the root and `cd`-ed there**, so this is it. Re-deriving it from
// `payload.cwd` looked equivalent and was not: that field is the session's working directory, which
// is a subdirectory for most of a session's life — 26 distinct values in this project's transcripts,
// exactly one of them the repo root. The gate then looked for the card under `packages/relay/.work/`,
// found nothing, and allowed the command for the same reason a contributor's checkout allows it.
const root = process.cwd()

let verdict
try {
  verdict = judge(cmd, {
    cardPath: path.join(root, CARD),
    transcriptPath: transcript,
  })
} catch { process.exit(0) }

if (!verdict.blocked) process.exit(0)
process.stderr.write(`${message}\n`)
process.exit(2)
