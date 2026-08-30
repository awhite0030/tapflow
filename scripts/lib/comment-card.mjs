import fs from 'node:fs'
import { ghInvocations, tokenize } from './gh-command.mjs'

/**
 * Was the comment card read before writing a comment that goes out under the user's account?
 *
 * **A personal gate, wired locally.** Reviewing is done by two people here, so this fires for them
 * and not for a contributor leaving a note on their own PR — see `judge`'s contract below for the
 * three independent reasons that holds even if someone wires it wrongly.
 *
 * The card is a register, not a template: it exists because comments written from scratch each time
 * read like different people, and the fix is a fixed reference point rather than a rule about
 * adjectives. What it cannot do is judge whether a paragraph belongs; that stays a decision.
 */

/** Every `gh` call that posts prose into a conversation. `create` is not one — a PR body is a
 *  different genre with its own template, and the card is about comments. */
function commentInvocations(cmd) {
  return [
    ...ghInvocations(cmd, 'pr', ['comment', 'review']),
    ...ghInvocations(cmd, 'issue', ['comment']),
  ]
}

/** The value of a `gh api` flag, in both spellings: `--method GET` and `--method=GET`. */
function apiFlag(words, ...names) {
  for (let i = 0; i < words.length; i++) {
    if (names.includes(words[i])) return words[i + 1] ?? null
    for (const n of names) {
      if (words[i].startsWith(`${n}=`)) return words[i].slice(n.length + 1)
    }
  }
  return null
}

/**
 * `gh api …/comments` and `…/replies` that would publish something.
 *
 * Not reachable through `ghInvocations`, whose shape is `gh <noun> <verb>`, so the path argument is
 * what identifies it. What counts as writing took three corrections from review, each against
 * `gh api --help` as the authority:
 *
 * - **`--input` carries a whole body with no field flag at all** — "a request body may be read from
 *   file specified by `--input`" — and it is the natural form for a reply written to a file first.
 *   Reading only field flags missed it entirely.
 * - **A field does not mean a write.** "To send the parameters as a `GET` query string instead, use
 *   `--method GET`" — so `--method GET … -f per_page=100` is a *read*, and blocking it blocks the
 *   first thing the card asks for. Only a field named `body` is a body.
 * - An explicit write method counts on its own, since a `POST` to a comments path is one whatever
 *   else is on the line.
 */
function apiCommentInvocations(cmd) {
  const found = []
  for (const words of ghInvocations(cmd, 'api', null)) {
    const path = words.find((w) => /\/(comments|replies)(\/|$|\?)/.test(w))
    if (!path) continue
    const method = (apiFlag(words, '--method', '-X') ?? '').toUpperCase()
    if (method === 'GET' || method === 'HEAD') continue
    const hasInput = words.some((w) => w === '--input' || w.startsWith('--input='))
    const hasBody = words.some((w, i) => {
      const flags = ['-f', '-F', '--field', '--raw-field']
      if (flags.includes(w)) return /^body=/.test(words[i + 1] ?? '')
      return flags.some((f) => w.startsWith(`${f}=`)) && /^body=/.test(w.slice(w.indexOf('=') + 1))
    })
    if (hasInput || hasBody || ['POST', 'PATCH', 'PUT'].includes(method)) found.push(words)
  }
  return found
}

export function postsAComment(cmd) {
  return commentInvocations(cmd).length + apiCommentInvocations(cmd).length > 0
}

/**
 * Did this session put the card in front of itself?
 *
 * **Any tool call naming the card counts; a mention in prose does not.** Every way the content
 * reaches the context goes through a tool call that names the path — `Read`, a `Write` that authored
 * it, an `Edit`, a `cat` in Bash — and narrowing to `Read` alone excluded three of those for no
 * reason. What the rule has to exclude is the gate's own block message, which names the card and
 * would otherwise let it fire exactly once ever.
 *
 * A floor, not a fence: `grep -l COMMENT-CARD` is a tool call naming it and would count, without the
 * content having been seen. That direction costs a missed prompt for a cooperative reader, which is
 * the threat model these gates state.
 *
 * Parses the transcript rather than matching its serialisation — the lesson `docs-aitells-gate.sh`
 * paid for, where a matcher assuming key order saw 6 of 34. Only lines that mention the card are
 * parsed, so a 35 MB transcript costs a substring scan and a handful of `JSON.parse` calls.
 */
export function cardWasRead(transcriptPath, cardName = 'COMMENT-CARD.md') {
  let text
  try { text = fs.readFileSync(transcriptPath, 'utf8') } catch { return false }
  if (!text.includes(cardName)) return false
  for (const line of text.split('\n')) {
    if (!line.includes(cardName)) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    // **An `@path` mention is not a tool call and carries no `message` at all** — it arrives as its
    // own record with an `attachment`, 64 of them in this project's transcripts. It is the most
    // direct way the card's content reaches the context, and reading only `message.content` blocked
    // the person who had just supplied it.
    const att = rec?.attachment
    if (att && (String(att.filename ?? '').endsWith(cardName)
      || String(att.content?.file?.filePath ?? '').endsWith(cardName))) return true
    for (const c of rec?.message?.content ?? []) {
      // The `input` test is what excludes a text block naming the card — today's non-tool blocks
      // carry no `input` at all, so the type guard cannot currently change an answer. It stays for
      // block shapes that do not exist yet, and is named here rather than asserted, because a
      // fixture invented to make it fail would be testing the fixture.
      if (c?.type === 'tool_use' && JSON.stringify(c.input ?? null).includes(cardName)) return true
    }
  }
  return false
}

/**
 * @returns {{ blocked: boolean, reason?: 'card-not-read' }}
 *
 * **Three independent reasons a contributor is unaffected**, and the third is the one that matters:
 * the card lives under gitignored `.work/`, the wiring lives in gitignored `settings.local.json`,
 * and this returns `blocked: false` when the card is absent. The first two are "it was not wired for
 * them"; only the third survives someone wiring it by mistake.
 */
export function judge(cmd, { cardPath, transcriptPath, exists = (p) => fs.existsSync(p) } = {}) {
  if (!postsAComment(cmd)) return { blocked: false }
  if (!cardPath || !exists(cardPath)) return { blocked: false }
  if (cardWasRead(transcriptPath ?? '')) return { blocked: false }
  return { blocked: true, reason: 'card-not-read' }
}

export { tokenize }
