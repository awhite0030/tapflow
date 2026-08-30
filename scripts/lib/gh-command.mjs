import fs from 'node:fs'

/**
 * Reading a Bash command well enough to tell a `gh` invocation from the words that spell one.
 *
 * **Two gates needed this and only one had it.** `issue-parent.mjs` was written because a shell
 * regex got three rules wrong in the same way — it matched text anywhere in the command instead of
 * parsing anything — and the language gate next to it in `settings.json` was still a perl regex over
 * the whole command. It refused a `node -e` script that carried `gh issue create` inside a string
 * literal. Rather than write the parser twice, it lives here and both import it; a second, weaker
 * copy is how this kind of guard drifts, which `check-changeset.mjs` already says about `proseLines`.
 */

/**
 * Split a shell command into words the way the shell would, enough for this job: single quotes are
 * literal, double quotes group, a backslash escapes the next character.
 *
 * **Operators are their own tokens even with no space around them.** Splitting on whitespace alone
 * meant an operator glued to `gh` stayed inside that word and command position was never reached, so
 * `true&&gh issue create`, `cd /tmp;gh …`, `(gh …)` and `echo x|gh …` were all invisible. The
 * commonest form was the worst: `URL=$(gh` is a *prefix* match for `ASSIGNMENT`, so the mechanism
 * added to see through `GH_REPO=o/r gh issue create` swallowed the capture form whole.
 *
 * **An unquoted newline becomes a `NEWLINE` token** rather than vanishing into whitespace, because a
 * newline starts a command and the caller has to see that. A NUL is used as the sentinel since it is
 * the one byte that cannot appear in a real argument — `execve` strings are NUL-terminated — so no
 * quoted body can forge one. A backslash before a newline is a line continuation and produces
 * neither a token nor a break.
 *
 * Not a shell parser and not trying to be. It cannot see through `$VAR`, `$(…)` or an alias, and it
 * resolves quoting before the caller consults `SEPARATOR`, so a quoted word that happens to read
 * `do` or `then` is taken for one. Every case that costs is a false block rather than a miss.
 */
export const NEWLINE = '\0'

/** Unquoted characters that end a word and begin a new command. `(` and `)` are here so that both
 *  `(gh …)` and `$(gh …)` reach command position. */
const OPERATOR = '&|;()'

export function tokenize(cmd) {
  const out = []
  let cur = ''
  let started = false
  let quote = null
  const flush = () => { if (started || cur) out.push(cur); cur = ''; started = false }
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
    if (c === '\\' && cmd[i + 1] === '\n') { i++; continue }
    if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; started = true; continue }
    if (c === '\n') { flush(); out.push(NEWLINE); continue }
    if (OPERATOR.includes(c)) {
      flush()
      // A run of the same operator is one token, so `&&` and `||` stay recognisable rather than
      // arriving as two singles that both happen to be separators anyway.
      let run = c
      while (cmd[i + 1] === c) { run += c; i++ }
      out.push(run)
      continue
    }
    if (/\s/.test(c)) { flush(); continue }
    cur += c
    started = true
  }
  flush()
  return out
}

/** `FOO=bar`, the form that let `GH_REPO=o/r gh issue create` past a matcher anchored on `gh`. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Wrappers that keep the next word in command position. */
const PASSTHROUGH = new Set(['env', 'sudo', 'command', 'nohup', 'time', 'xargs'])

/** Separators after which a new command begins. */
const SEPARATOR = new Set([NEWLINE, ';', ';;', '&', '&&', '|', '||', '(', ')', '{', '}', 'then', 'do', 'else', '!'])

/**
 * The opening of a heredoc: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`.
 *
 * **Anchored to the end of the line.** Unanchored it fired on a `<<` written inside an argument —
 * `grep -n "<<EOF" file` — and the strip below then deleted every line up to whatever terminator a
 * later, genuine heredoc supplied, taking a real invocation with it. A real opener is the last thing
 * on its line in every shape this repo writes; one followed by a further redirection is treated as
 * no heredoc at all, which leaves its text scanned rather than skipped.
 */
const HEREDOC_OPEN = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2\s*$/

/** Split on either line ending. A CRLF command reaching `'\n'` alone left `EOF\r` never matching its
 *  delimiter, so every payload read as unterminated and the prose regression came back. */
const lines = (cmd) => cmd.split(/\r?\n/)

/**
 * Every heredoc payload in a command, in order.
 *
 * The caller blocks when a command carries more than one, because picking is guessing. A heredoc
 * that is never terminated has no payload anyone can read and is skipped.
 */
export function heredocs(cmd) {
  const src = lines(cmd)
  const out = []
  for (let i = 0; i < src.length; i++) {
    const m = HEREDOC_OPEN.exec(src[i])
    if (!m) continue
    const [, dash, , delim] = m
    const body = []
    let j = i + 1
    for (; j < src.length; j++) {
      const candidate = dash ? src[j].replace(/^\t+/, '') : src[j]
      if (candidate === delim) break
      body.push(src[j])
    }
    if (j >= src.length) continue          // never terminated: not a payload anyone can read
    out.push(body.join('\n'))
    i = j
  }
  return out
}

/**
 * The same command with every heredoc payload removed, leaving the lines that are commands.
 *
 * **A payload is text, and it was being read as a command.** Quoting is what keeps
 * `echo "gh issue create"` from counting; a heredoc body is unquoted, so its words tokenize as bare
 * words and any line inside one could land in command position. Found by being blocked from writing
 * the plan document for this change, whose prose carried the example `&& gh issue create …`.
 *
 * The opening line stays — the invocation lives there — and so does an unterminated heredoc, whose
 * text keeps being scanned. That direction costs a false block rather than a miss.
 */
export function withoutHeredocPayloads(cmd) {
  const src = lines(cmd)
  const kept = []
  for (let i = 0; i < src.length; i++) {
    kept.push(src[i])
    const m = HEREDOC_OPEN.exec(src[i])
    if (!m) continue
    const [, dash, , delim] = m
    let j = i + 1
    for (; j < src.length; j++) {
      const candidate = dash ? src[j].replace(/^\t+/, '') : src[j]
      if (candidate === delim) break
    }
    if (j >= src.length) continue          // unterminated: nothing to strip, keep scanning it
    i = j                                  // skip the payload and its terminator
  }
  return kept.join('\n')
}

/**
 * Every `gh <noun> <verb>` in the command, as the token slice that starts at `gh`.
 *
 * Command position is tracked rather than pattern-matched, so this repo's own docs — which print
 * these commands inside prose, inside `echo`, and inside heredocs — do not trip it, while the
 * wrapped, prefixed and unspaced forms do.
 */
export function ghInvocations(cmd, noun, verbs) {
  const words = tokenize(withoutHeredocPayloads(cmd))
  const wanted = new Set(verbs)
  const found = []
  let atStart = true
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (SEPARATOR.has(w)) { atStart = true; continue }
    if (!atStart) continue
    let j = i
    while (j < words.length && (ASSIGNMENT.test(words[j]) || PASSTHROUGH.has(words[j]))) j++
    if (words[j] === 'gh' && words[j + 1] === noun && wanted.has(words[j + 2])) {
      // **Stop at the next separator.** Running to the end of the token list meant a later command's
      // flags counted as this one's: `gh issue create --web && echo --body "Parent: #607"` was
      // allowed, because `bodyArg` found `echo`'s argument.
      let end = j
      while (end < words.length && !SEPARATOR.has(words[end])) end++
      found.push(words.slice(j, end))
    }
    atStart = false
  }
  return found
}

/**
 * Read a flag's argument, in every spelling gh accepts for it.
 *
 * **Including the value attached to the shorthand**, which pflag takes and this read none of:
 * verified against the binary, `gh issue list -Lx` answers `invalid argument "x" for "-L, --limit"`.
 * The prefix rule refuses a double dash, or `--title` — which does start with `-t` — would come back
 * as `itle`.
 */
function flagArg(words, long, short) {
  const eq = new RegExp(`^${long}=([\\s\\S]*)$`)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w === long || w === short) return words[i + 1] ?? null
    const m = eq.exec(w)
    if (m) return m[1]
    if (!w.startsWith('--') && w.startsWith(short) && w.length > short.length) return w.slice(short.length)
  }
  return null
}

/** The `--body-file` / `-F` argument, quoting resolved. `-` means stdin, which is not a path. */
export const bodyFileArg = (words) => flagArg(words, '--body-file', '-F')

/** The `--body` / `-b` argument, quoting resolved. */
export const bodyArg = (words) => flagArg(words, '--body', '-b')

/** The `--title` / `-t` argument, quoting resolved. */
export const titleArg = (words) => flagArg(words, '--title', '-t')

/**
 * The reader both gates use for a `--body-file`.
 *
 * **It stats before it reads**, because `readFileSync` on a FIFO with no writer blocks until the
 * hook times out — a gate that hangs is worse than one that blocks, and the language gate reaching
 * body files put that on the `gh pr create` path for the first time. `statSync` does not open, so it
 * answers immediately. A directory keeps its own errno so the message can name it.
 */
export function readBodyFile(p) {
  const st = fs.statSync(p)
  if (!st.isFile()) {
    const err = new Error(`not a regular file: ${p}`)
    err.code = st.isDirectory() ? 'EISDIR' : 'ENOTFILE'
    throw err
  }
  return fs.readFileSync(p, 'utf8')
}
