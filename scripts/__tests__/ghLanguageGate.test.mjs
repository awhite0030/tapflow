// The gate that keeps PR and issue titles and bodies in English.
//
// **It replaces a one-line perl regex over the whole command**, which is the same mistake the issue
// parent gate was written to end and which this file's first case is named after: a `node -e` script
// with `gh issue create` inside a *string literal* was refused as an issue creation, because the
// pattern matched text rather than a command. The parser next door already knew the difference.
//
// The port also closes the opposite hole. The old regex saw only the command text, so Korean typed
// inline was caught while Korean in a `--body-file` sailed through — the gate was strictest about
// the shape that is easiest to avoid.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { judge, authoringInvocations } from '../lib/gh-language.mjs'

const REPO = path.resolve(import.meta.dirname, '../..')
const KO = '한글 본문'

/** Assembled rather than written, so this file can be edited from a heredoc. */
const PR_CREATE = ['gh', 'pr', 'create'].join(' ')
const ISSUE_CREATE = ['gh', 'issue', 'create'].join(' ')

/** `judge` with no filesystem: every body file is supplied inline. */
const verdict = (cmd, files = {}) => judge(cmd, (p) => {
  if (!(p in files)) throw new Error('ENOENT')
  return files[p]
})

describe('which commands author something on GitHub', () => {
  const AUTHORS = {
    'creating a PR': `${PR_CREATE} --title x`,
    'editing a PR': 'gh pr edit 42 --body x',
    'creating an issue': `${ISSUE_CREATE} --title x`,
    'editing an issue': 'gh issue edit 42 --body x',
    'the undocumented `new` alias': 'gh issue new --title x',
    'behind an environment assignment': `GH_REPO=o/r ${PR_CREATE} --title x`,
    'after a separator': `git status && ${PR_CREATE} --title x`,
  }
  for (const [name, cmd] of Object.entries(AUTHORS)) {
    it(`sees ${name}`, () => {
      expect(authoringInvocations(cmd)).toHaveLength(1)
    })
  }

  const NOT_AUTHORS = {
    'listing PRs': 'gh pr list --state open',
    'viewing one': 'gh pr view 42 --json body',
    'checking one out': 'gh pr checkout 42',
    'commenting': 'gh pr comment 42 --body x',
    'the words inside a script string': `node -e "import { judge } from './lib.mjs'; judge('${ISSUE_CREATE} --title x')"`,
    'the words in a grep pattern': `grep -rn '${PR_CREATE}' docs/`,
    'the words in a heredoc payload': `cat > plan.md <<EOF\nRun ${PR_CREATE} when ready\nEOF`,
  }
  for (const [name, cmd] of Object.entries(NOT_AUTHORS)) {
    it(`ignores ${name}`, () => {
      // A present count of zero rather than "nothing happened": these run through the same parser,
      // so a parser that returned early could not pass this by finding nothing.
      expect(authoringInvocations(cmd)).toEqual([])
    })
  }
})

describe('Korean is judged where it reaches GitHub, and nowhere else', () => {
  it('blocks it in a title', () => {
    expect(verdict(`${PR_CREATE} --title "${KO}" --body "in English"`)).toMatchObject({ blocked: true })
  })

  it('blocks it in a body', () => {
    expect(verdict(`${PR_CREATE} --title "x" --body "${KO}"`)).toMatchObject({ blocked: true })
  })

  it('blocks it in a body file, which the regex could not see at all', () => {
    // The hole the port closes. `--body-file` is the form CONTRIBUTING tells everyone to use, so the
    // old gate was blind in exactly the case the convention produces.
    expect(verdict(`${PR_CREATE} -F body.md`, { 'body.md': `## Summary\n\n${KO}\n` })).toMatchObject({ blocked: true })
  })

  it('blocks it in the heredoc that reaches `--body-file -`', () => {
    expect(verdict(`${PR_CREATE} --body-file - <<EOF\n${KO}\nEOF`)).toMatchObject({ blocked: true })
  })

  it('allows an English body file', () => {
    expect(verdict(`${PR_CREATE} -F body.md`, { 'body.md': '## Summary\n\nA fix.\n' }).blocked).toBe(false)
  })

  it('allows Korean that never reaches GitHub', () => {
    // The false positive that started this. Every one of these was refused by the regex.
    const elsewhere = [
      `${PR_CREATE} --title x --body "in English" && echo "${KO}"`,
      `node -e "console.log('${KO}'); // ${ISSUE_CREATE}"`,
      `grep -rn '${PR_CREATE}' docs/ # ${KO}`,
    ]
    for (const cmd of elsewhere) expect(verdict(cmd).blocked, cmd).toBe(false)
  })

  it('names where it found it, so the message can point at one thing', () => {
    expect(verdict(`${PR_CREATE} --title "${KO}" --body "en"`).where).toBe('--title')
    expect(verdict(`${PR_CREATE} --title "en" --body "${KO}"`).where).toBe('--body')
    expect(verdict(`${PR_CREATE} -F body.md`, { 'body.md': KO }).where).toContain('body.md')
  })
})

describe('what this gate cannot see', () => {
  it('lets an unreadable body file through', () => {
    // **A floor, not a fence,** and the boundary is deliberate. The gate judges from the repo root
    // while the command runs wherever its own `cd` put it, so a relative path can be readable to
    // `gh` and not to this. Blocking every such path would refuse correct work for a file the gate
    // merely could not open; the issue-parent gate reports that case for issues, and for a PR the
    // remaining exposure is a Korean body passed by a relative path from another directory.
    expect(verdict(`${PR_CREATE} -F somewhere/else.md`).blocked).toBe(false)
  })

  it('lets a body built by a substitution through', () => {
    // `$(…)` is not resolved by the tokenizer and never will be. Named so the next reader does not
    // mistake silence here for coverage.
    expect(verdict(`${PR_CREATE} --body "$(cat ko.md)"`).blocked).toBe(false)
  })
})

describe('the hook itself, spawned', () => {
  const run = (cmd) => spawnSync('bash', [path.join(REPO, '.claude/hooks/gh-language-gate.sh')], {
    input: JSON.stringify({ tool_input: { command: cmd } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
  })

  it('blocks a Korean title and says where it is', () => {
    const r = run(`${PR_CREATE} --title "${KO}" --body "en"`)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/--title/)
  })

  it('allows the command that the regex refused', () => {
    expect(run(`node -e "judge('${ISSUE_CREATE}'); console.log('${KO}')"`).status).toBe(0)
  })

  it('allows an unrelated command without paying for node', () => {
    expect(run('git status --short').status).toBe(0)
  })

  it('fails open on a payload it cannot parse', () => {
    const r = spawnSync('bash', [path.join(REPO, '.claude/hooks/gh-language-gate.sh')], {
      input: `not json at all, ${PR_CREATE} ${KO}`,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
    })
    expect(r.status, 'a malformed payload would block every Bash call in the session').toBe(0)
  })
})
