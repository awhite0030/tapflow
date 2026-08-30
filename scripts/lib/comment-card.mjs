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

/**
 * `gh api …/comments` and `…/replies` with a body — the form an inline review reply takes.
 *
 * Not reachable through `ghInvocations`, whose shape is `gh <noun> <verb>`. Matched on the path
 * argument instead, and only when something is being written: a `POST` is the default for `gh api`
 * once a field is supplied, so the presence of a body field is the signal rather than the method.
 */
function apiCommentInvocations(cmd) {
  const found = []
  for (const words of ghInvocations(cmd, 'api', null)) {
    const path = words.find((w) => /\/(comments|replies)(\/|$|\?)/.test(w))
    const writes = words.some((w) => w === '-f' || w === '-F' || w === '--field' || w === '--raw-field'
      || /^-{1,2}(f|F|field|raw-field)=/.test(w))
    if (path && writes) found.push(words)
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
