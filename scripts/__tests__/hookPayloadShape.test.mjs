// What every PreToolUse gate does with a payload that is not the shape it expects.
//
// **`// ""` made a missing key and an empty command the same thing.** Every pattern then failed to
// match and the gate passed at exit 0 — verified against the shipped hooks: `{"tool_input":{}}` was
// allowed by all of them. The failure is silent by construction, so the policy is asserted here
// rather than left to whichever hook is edited next.
//
// **How much this buys, measured rather than assumed.** Review asked what payload actually arrives
// with no `command`, and the answer is: none that carries anything to judge. For the `Bash` tool
// `tool_input.command` is always a non-empty string; the only sibling whose name matches the `Bash`
// matcher is `BashOutput`, whose payload is `{bash_id}` and contains no command text at all. So the
// fallback is a floor under a shape that does not arrive today, not a hole being closed — and the
// case below says so, because a reader who takes it for the latter will over-trust it.
//
// **The assertions run the payload through to a verdict**, not just to exit 0. A test that only
// checks the unexpected shape is allowed cannot tell a working fallback from a gate that died on the
// way — the shape `contributing/test-and-guard-coverage.md` is about. So each case carries text the
// gate should refuse, in a key it does not read.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '../..')
const HOOKS = path.join(REPO, '.claude/hooks')

/** Every hook that reads a Bash command out of the payload. */
const READS_A_COMMAND = [
  'pr-merge-guard.sh',
  'gh-language-gate.sh',
  'adversarial-review-gate.sh',
  'issue-parent-gate.sh',
  'comment-card-gate.sh',
]

const run = (hook, payload) =>
  spawnSync('bash', [path.join(HOOKS, hook)], { input: JSON.stringify(payload), encoding: 'utf8', cwd: REPO })

describe('every command-reading hook falls back to the whole payload', () => {
  // Inspection, because the policy has to hold for a hook added later too. The three that lacked it
  // were found this way rather than by running them: a gate that is off answers exactly like a gate
  // with nothing to say.
  for (const hook of READS_A_COMMAND) {
    it(`${hook} does not treat a missing key as an empty command`, () => {
      const src = fs.readFileSync(path.join(HOOKS, hook), 'utf8')
      expect(src, hook).toMatch(/\[ -n "\$cmd" \] \|\| cmd=\$input/)
    })
  }
})

describe('the fallback reaches a verdict, not just exit 0', () => {
  // **Assembled rather than written out.** The merge guard is a shell matcher with no notion of a
  // heredoc, so the literal form in this file's own source sits in a command position as far as it
  // is concerned — writing this test was blocked by the gate it tests. The node-side gates strip
  // heredoc payloads and need no such care, which is the difference the two halves exist for.
  const MERGE = ['gh', 'pr', 'merge'].join(' ')

  it('pr-merge-guard judges a merge hidden in an unread key', () => {
    // The command-position rule still applies to the payload, so the text has to sit where a command
    // would. That is the honest reach of this fallback, and saying so here keeps the next reader from
    // expecting a substring scan.
    const r = run('pr-merge-guard.sh', { tool_input: { other: `x; ${MERGE} 1` }, cwd: REPO })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/Blocked/)
  })

  it('a parsing gate reaches its parser, and its parser reads JSON as quoted text', () => {
    // **The honest limit of this policy, measured rather than assumed.** The shell prefilter widens
    // — `*gh*issue*` matches the raw payload, so node is spawned and the parser runs on it. The
    // parser then reads what a shell would: every value in a JSON payload sits inside double quotes,
    // so `gh` there is a quoted word rather than a command, exactly as `echo "gh issue create"` is.
    //
    // So the fallback keeps the gate *running* rather than making it see through JSON, and that is
    // the whole of what it buys. Asserted so nobody reads the policy as broader than it is: the
    // alternative — treating every string in an unrecognised payload as a command — is guessing at a
    // shape whose meaning we do not know.
    const r = run('issue-parent-gate.sh', { tool_input: { other: 'gh issue create -t x --body "a bug"' }, cwd: REPO })
    expect(r.status).toBe(0)
  })

  it('an ordinary payload is unaffected', () => {
    for (const hook of ['pr-merge-guard.sh', 'issue-parent-gate.sh', 'gh-language-gate.sh']) {
      expect(run(hook, { tool_input: { command: 'git status' }, cwd: REPO }).status, hook).toBe(0)
    }
  })

  it('the one real payload without a command carries nothing to judge', () => {
    // `BashOutput` is the only sibling tool whose name matches the `Bash` matcher, and its payload
    // is a handle rather than a command. Recorded so the fallback is not read as closing a live
    // hole: it is a floor under a shape that does not arrive today. If a future tool does arrive
    // with command-shaped text under a different key, this is the case that will change.
    for (const hook of ['pr-merge-guard.sh', 'adversarial-review-gate.sh', 'issue-parent-gate.sh']) {
      expect(run(hook, { tool_input: { bash_id: 'bash_1' }, cwd: REPO }).status, hook).toBe(0)
    }
  })
})
