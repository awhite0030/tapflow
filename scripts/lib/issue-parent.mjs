import fs from 'node:fs'
import { proseLines } from './prose-lines.mjs'

/**
 * Does an issue split out of other work name what it came from?
 *
 * **The decision lives here rather than in the hook's shell**, because the first version was shell
 * and three of its four rules were wrong in the same way: they matched text anywhere in the command
 * instead of parsing anything. `gh issue new` — an undocumented alias that works — went straight
 * through, so did `GH_REPO=o/r gh issue create`, `-F "issue body.md"` read the file `issue`, and
 * `Parent: #607` in a `--title` satisfied a gate about bodies.
 *
 * It also means this repo stops keeping a third, weaker copy of "which lines of a markdown body
 * count". `check-changeset.mjs` already had `proseLines`, whose own comment warns that a second copy
 * is how the guard drifts. Both markers here are switches that turn a gate **off**, so a body that
 * merely quotes one must not trip it — the same rule, now shared rather than re-derived.
 */

/**
 * Split a shell command into words the way the shell would, enough for this job: single quotes are
 * literal, double quotes group, a backslash escapes the next character.
 *
 * Not a shell parser and not trying to be. It cannot see through `$VAR`, `$(…)` or an alias, and the
 * caller treats an unresolvable body as "no parent found" — which fails toward blocking, which for a
 * cooperative agent costs one line and for a wrong guess costs nothing.
 */
export function tokenize(cmd) {
  const out = []
  let cur = ''
  let started = false
  let quote = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) cur += cmd[++i]
      else cur += c
      continue
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue }
    if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; started = true; continue }
    if (/\s/.test(c)) {
      if (started || cur) out.push(cur)
      cur = ''
      started = false
      continue
    }
    cur += c
    started = true
  }
  if (started || cur) out.push(cur)
  return out
}

/** `FOO=bar`, the form that let `GH_REPO=o/r gh issue create` past a matcher anchored on `gh`. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Wrappers that keep the next word in command position. */
const PASSTHROUGH = new Set(['env', 'sudo', 'command', 'nohup', 'time'])

/** Separators after which a new command begins. */
const SEPARATOR = new Set([';', '&&', '||', '|', '&', '(', ')', '{', '}', 'then', 'do', 'else', '!'])

/**
 * Every `gh issue create` (or `new`) in the command, as the token slice that starts at `gh`.
 *
 * Command position is tracked rather than pattern-matched, so this repo's own docs — which print
 * `gh issue create` inside prose and inside `echo` — do not trip it, while the wrapped and prefixed
 * forms do.
 */
export function issueCreateInvocations(cmd) {
  const words = tokenize(cmd)
  const found = []
  let atStart = true
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (SEPARATOR.has(w)) { atStart = true; continue }
    if (!atStart) continue
    let j = i
    while (j < words.length && (ASSIGNMENT.test(words[j]) || PASSTHROUGH.has(words[j]))) j++
    if (words[j] === 'gh' && words[j + 1] === 'issue' && (words[j + 2] === 'create' || words[j + 2] === 'new')) {
      found.push(words.slice(j))
    }
    atStart = false
  }
  return found
}

/** The `--body-file` / `-F` argument, quoting resolved. `-` means stdin, which is not a path. */
export function bodyFileArg(words) {
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '--body-file' || words[i] === '-F') return words[i + 1] ?? null
    const eq = /^--body-file=(.*)$/.exec(words[i])
    if (eq) return eq[1]
  }
  return null
}

/** The `--body` / `-b` argument, quoting resolved. */
export function bodyArg(words) {
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '--body' || words[i] === '-b') return words[i + 1] ?? null
    const eq = /^--body=(.*)$/.exec(words[i])
    if (eq) return eq[1]
  }
  return null
}

/**
 * `Parent: #607` on a line of its own.
 *
 * Anchored, because the point of the rule is that a checklist can be regenerated from it. Prose that
 * happens to contain the words — "raised by the review of #647" was the measured case — is exactly
 * what the gate exists to reject, and an unanchored match accepted a sentence with `Parent:` in the
 * middle of it just as readily.
 */
export function hasParent(body) {
  for (const { line } of proseLines(body, { skipFrontmatter: true })) {
    if (/^Parent:\s*[A-Za-z0-9_.\/-]*#\d+\s*$/.test(line)) return true
  }
  return false
}

/** `<!-- standalone: reason -->`, and the reason has to say something. An empty one is the marker
 *  without the part that makes it a decision. */
export function hasStandalone(body) {
  for (const { line } of proseLines(body, { skipFrontmatter: true })) {
    const m = /^<!--\s*standalone:\s*(.*?)\s*-->$/.exec(line)
    if (m && m[1]) return true
  }
  return false
}

/**
 * @param {string} cmd the Bash command the tool was asked to run
 * @param {(p: string) => string} [readFile] injected for the tests
 * @returns {{ blocked: boolean, detail?: string }}
 */
export function judge(cmd, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const invocations = issueCreateInvocations(cmd)
  if (invocations.length === 0) return { blocked: false }

  for (const words of invocations) {
    // **Only the body is consulted.** `haystack = the whole command` let a `--title` satisfy a rule
    // about bodies, which is the gate agreeing with itself rather than with the issue.
    let body = null
    const file = bodyFileArg(words)
    if (file && file !== '-') {
      try { body = readFile(file) } catch { body = null }
    }
    if (body === null) body = bodyArg(words)
    // A heredoc reaches `--body-file -`; its text is in the command and nowhere else, so that one
    // case reads the command rather than losing the body entirely.
    if (body === null && file === '-') body = cmd

    if (body === null) return { blocked: true, detail: 'no body could be read from the command' }
    if (!hasParent(body) && !hasStandalone(body)) return { blocked: true, detail: 'the body names no parent' }
  }
  return { blocked: false }
}
