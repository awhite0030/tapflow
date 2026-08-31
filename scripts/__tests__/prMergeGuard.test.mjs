// The gate that leaves merging and approving to the user, on both roads that reach them.
//
// **Two halves, on purpose.** `gh pr merge` is identifiable from its words, so a shell matcher
// anchored on command position decides it — and that half had no test file at all until now, having
// been calibrated against a measured failure (2191 parse failures to 1 success) rather than fixtures.
// `gh api` names what it acts on in a path and how in a flag, and the same path is a read or a write
// depending on the method, so that half parses.
//
// The `gh pr merge` strings below are assembled rather than written out: the shell half has no
// notion of a heredoc or of a string literal, so a literal in this file is a command position as far
// as it is concerned, and it blocks the test that tests it.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { judge } from '../lib/pr-merge.mjs'

const REPO = path.resolve(import.meta.dirname, '../..')
const HOOK = path.join(REPO, '.claude/hooks/pr-merge-guard.sh')

const run = (command) =>
  spawnSync('bash', [HOOK], { input: JSON.stringify({ tool_input: { command }, cwd: REPO }), encoding: 'utf8', cwd: REPO })

const PR_MERGE = ['gh', 'pr', 'merge'].join(' ')
const PR_REVIEW = ['gh', 'pr', 'review'].join(' ')

describe('gh api reaches the same two actions', () => {
  const BLOCKED = {
    'a merge by PUT': 'gh api --method PUT repos/o/r/pulls/1/merge -f merge_method=squash',
    'a merge by -X': 'gh api -X PUT repos/o/r/pulls/1/merge',
    'an approval': 'gh api -X POST repos/o/r/pulls/1/reviews -f event=APPROVE',
    // A review left pending is still one submitted under the user's name, and the shell half refuses
    // `gh pr review` whatever its flags. Anything that writes to the path counts.
    'a review with no event': 'gh api -X POST repos/o/r/pulls/1/reviews -f body=x',
    // With no method given, gh sends POST when a field is present — so the method need not be typed
    // for the call to be a write.
    'a write with the method implied': 'gh api repos/o/r/pulls/1/reviews -f event=APPROVE',
    'behind a separator': 'git status && gh api --method PUT repos/o/r/pulls/1/merge',
    'with the command word broken by quotes': 'g"h" api --method PUT repos/o/r/pulls/1/merge',
  }
  for (const [what, cmd] of Object.entries(BLOCKED)) {
    it(`blocks ${what}`, () => expect(judge(cmd).blocked, cmd).toBe(true))
  }

  const ALLOWED = {
    // `GET …/merge` asks whether a PR is merged; `GET …/reviews` lists them. Refusing these would
    // refuse the two calls most likely to precede a legitimate question about a PR.
    'asking whether a PR is merged': 'gh api --method GET repos/o/r/pulls/1/merge',
    'listing reviews': 'gh api repos/o/r/pulls/1/reviews',
    'a HEAD request': 'gh api --method HEAD repos/o/r/pulls/1/merge',
    // The comment card owns this path; this gate is about merging and approving.
    'a comment': 'gh api repos/o/r/pulls/1/comments -f body=hi',
    'an unrelated endpoint': 'gh api repos/o/r/issues -f title=x',
    'prose that mentions the endpoint': 'echo "gh api --method PUT repos/o/r/pulls/1/merge"',
    // `pulls/1/merge` is the path; `merge` alone is a different endpoint family.
    'a branch merge': 'gh api --method POST repos/o/r/merges -f base=main',
  }
  for (const [what, cmd] of Object.entries(ALLOWED)) {
    it(`allows ${what}`, () => expect(judge(cmd).blocked, cmd).toBe(false))
  }

  it('names which of the two it refused', () => {
    expect(judge('gh api -X PUT repos/o/r/pulls/1/merge').reason).toBe('merge')
    expect(judge('gh api -X POST repos/o/r/pulls/1/reviews').reason).toBe('review')
  })
})

describe('the hook runs both halves', () => {
  it('still blocks the gh pr forms the shell half owns', () => {
    expect(run(`${PR_MERGE} 1`).status).toBe(2)
    expect(run(`${PR_REVIEW} 1 --approve`).status).toBe(2)
  })

  it('blocks the api forms through the whole hook', () => {
    const r = run('gh api --method PUT repos/o/r/pulls/1/merge')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/merging a PR through the API/)
  })

  it('leaves everything else alone', () => {
    for (const cmd of ['git status', 'gh pr create -t x', 'gh api repos/o/r/pulls/1']) {
      expect(run(cmd).status, cmd).toBe(0)
    }
  })

  it('costs no node process for a command that is not gh api', () => {
    // The prefilter is the reason this gate is cheap on every Bash call in a session. A command with
    // no `gh` and no `api` in it must not reach the parsing half at all.
    const r = run('ls -la')
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })
})
