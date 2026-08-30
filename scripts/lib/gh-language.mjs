import fs from 'node:fs'
import { ghInvocations, titleArg, bodyArg, bodyFileArg, heredocs } from './gh-command.mjs'

/**
 * Are this PR's or issue's title and body in English, as AGENTS.md requires?
 *
 * **This replaces a perl regex over the whole command**, which was wrong in both directions. It
 * refused a `node -e` script carrying `gh issue create` inside a string literal, because the pattern
 * matched text rather than a command — the same mistake `issue-parent.mjs` exists to have fixed, in
 * the hook sitting next to it. And it never saw a `--body-file`, so Korean in the form CONTRIBUTING
 * tells everyone to use went straight through while Korean typed inline was caught.
 *
 * What is judged is what reaches GitHub: the title, the body, the body file's contents, and the
 * heredoc behind `--body-file -`. Everything else in the command is somebody else's text.
 */

/** Hangul anywhere. The rule is about the language of the prose, not about a particular character. */
const HANGUL = /\p{Script=Hangul}/u

/** Every `gh` call that writes a title or body to GitHub. `comment` is not one: a review comment is
 *  a conversation, and the rule AGENTS.md states is about PR and issue titles and bodies. */
export function authoringInvocations(cmd) {
  return [
    ...ghInvocations(cmd, 'issue', ['create', 'new', 'edit']),
    ...ghInvocations(cmd, 'pr', ['create', 'edit']),
  ]
}

/**
 * @param {string} cmd the Bash command the tool was asked to run
 * @param {(p: string) => string} [readFile] injected for the tests
 * @returns {{ blocked: boolean, where?: string }} `where` names the argument it found Korean in
 */
export function judge(cmd, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  for (const words of authoringInvocations(cmd)) {
    for (const [where, text] of textsReachingGitHub(words, cmd, readFile)) {
      if (HANGUL.test(text)) return { blocked: true, where }
    }
  }
  return { blocked: false }
}

/**
 * Every piece of prose this invocation would publish, paired with what to call it in the message.
 *
 * **An unreadable body file is skipped rather than blocked, and that is a real limit.** The gate
 * runs from the repository root while the command runs wherever its own `cd` put it, so a relative
 * path can be readable to `gh` and not to this. Blocking every such path would refuse correct work
 * over a file the gate merely could not open. What that leaves uncovered is a Korean body passed by
 * a relative path from another directory — a floor, not a fence.
 */
function* textsReachingGitHub(words, cmd, readFile) {
  const title = titleArg(words)
  if (title !== null) yield ['--title', title]

  const body = bodyArg(words)
  if (body !== null) yield ['--body', body]

  const file = bodyFileArg(words)
  if (file !== null && file !== '-') {
    let contents = null
    try { contents = readFile(file) } catch { contents = null }
    if (contents !== null) yield [`the body file ${file}`, contents]
  }
  if (file === '-') {
    // One heredoc is the body. Several means the command builds text elsewhere too, and picking
    // would be guessing — the parent gate blocks on that ambiguity because a wrong guess there is
    // permissive; here a wrong guess would refuse someone else's prose, so it is left alone.
    const docs = heredocs(cmd)
    if (docs.length === 1) yield ['the heredoc body', docs[0]]
  }
}
