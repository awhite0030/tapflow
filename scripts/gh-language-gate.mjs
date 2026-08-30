#!/usr/bin/env node
// The decision half of `.claude/hooks/gh-language-gate.sh`. Reads the PreToolUse payload on stdin,
// exits 0 to allow and 2 to block. Kept out of the shell for the reason the file it replaces proves:
// a regex over the whole command cannot tell a `gh` call from the words that spell one.
import { judge } from './lib/gh-language.mjs'

const message = (where) => `Blocked: ${where} is in Korean.

PR and issue titles and bodies are written in English, so a contributor of any language can read
them (AGENTS.md > "Branches, Commits & Releases"). Conversation and docs keep their own KO/EN rules,
and this gate reads only the title and body — the rest of your command is yours.

Rewrite that argument in English and re-run.`

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

process.stderr.write(`${message(verdict.where)}\n`)
process.exit(2)
