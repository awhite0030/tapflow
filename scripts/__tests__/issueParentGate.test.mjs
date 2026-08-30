// The gate that makes a split-out issue name what it came from.
//
// **Every case below was a bypass in the shell version this replaces**, which is the reason the file
// exists: the first draft matched strings in the whole command and its own review record admitted it
// was untested. Three of its four rules were wrong in the same way, and none of them was visible
// without running it.
//
// The last describe spawns the real hook rather than the library, because a correct decision reached
// through a prefilter that never calls it is not a gate.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { judge, issueCreateInvocations, hasParent, hasStandalone } from '../lib/issue-parent.mjs'
import { tokenize, bodyFileArg, heredocs } from '../lib/gh-command.mjs'

const REPO = path.resolve(import.meta.dirname, '../..')
const PARENT = 'Parent: #607'

/** `judge` with no filesystem: every body is supplied inline. */
const verdict = (cmd, files = {}) => judge(cmd, (p) => {
  if (!(p in files)) throw new Error('ENOENT')
  return files[p]
})

describe('which commands are issue creations', () => {
  const CREATES = {
    'the plain form': 'gh issue create --title x --body "Parent: #607"',
    'the undocumented `new` alias, which gh accepts': 'gh issue new --body "Parent: #607"',
    'behind an environment assignment': 'GH_REPO=o/r gh issue create --body "Parent: #607"',
    'behind two of them': 'A=1 GH_REPO=o/r gh issue create --body "Parent: #607"',
    'behind env(1)': 'env GH_REPO=o/r gh issue create --body "Parent: #607"',
    'after a separator': 'git status && gh issue create --body "Parent: #607"',
    'inside a subshell': '( gh issue create --body "Parent: #607" )',
  }
  for (const [name, cmd] of Object.entries(CREATES)) {
    it(`sees ${name}`, () => {
      expect(issueCreateInvocations(cmd)).toHaveLength(1)
    })
  }

  const NOT_CREATES = {
    'listing issues': 'gh issue list --state open',
    'viewing one': 'gh issue view 607 --json body',
    'a PR, not an issue': 'gh pr create --body-file /tmp/x.md',
    'the words inside an argument': 'echo "run gh issue create to file one"',
    'the words in a grep pattern': "grep -rn 'gh issue create' docs/",
  }
  for (const [name, cmd] of Object.entries(NOT_CREATES)) {
    it(`ignores ${name}`, () => {
      // Asserting a present count of zero rather than "nothing happened": these run through the same
      // tokenizer, so a broken tokenizer cannot pass this by returning early.
      expect(issueCreateInvocations(cmd)).toEqual([])
    })
  }
})

describe('an invocation ends where the command does', () => {
  it('does not borrow a later command\'s flags', () => {
    // `words.slice(j)` ran to the end of the token list, so `echo`'s `--body` counted as the issue's
    // and an invocation with no body at all was allowed.
    expect(verdict('gh issue create --web && echo --body "Parent: #607"').blocked).toBe(true)
    expect(verdict('gh issue create --web ; cat "Parent: #607"').blocked).toBe(true)
  })

  it('still judges each invocation in a chain on its own body', () => {
    const both = 'gh issue create --body "Parent: #607" && gh issue create --body "Parent: #608"'
    expect(verdict(both).blocked).toBe(false)
    const second = 'gh issue create --body "Parent: #607" && gh issue create --body "a bug"'
    expect(verdict(second).blocked, 'the second one names nothing').toBe(true)
  })
})

describe('where the body comes from', () => {
  it('reads a quoted --body-file path whole', () => {
    // `-F "issue body.md"` used to be cut at the first space and read a file called `issue`, so a
    // correctly-filed issue was refused for a line its body already had.
    expect(bodyFileArg(tokenize('gh issue create -F "issue body.md"'))).toBe('issue body.md')
    expect(bodyFileArg(tokenize("gh issue create --body-file 'my issue.md'"))).toBe('my issue.md')
    expect(bodyFileArg(tokenize('gh issue create --body-file=body.md'))).toBe('body.md')
  })

  it('allows a body file that carries the line, and blocks one that does not', () => {
    const cmd = 'gh issue create -F "issue body.md"'
    expect(verdict(cmd, { 'issue body.md': `${PARENT}\n\ntext\n` }).blocked).toBe(false)
    expect(verdict(cmd, { 'issue body.md': 'raised by the review of #647\n' }).blocked).toBe(true)
  })

  it('does not let a --title stand in for the body', () => {
    // The whole command used to be the haystack, so the gate could be satisfied by text that never
    // reached the issue.
    expect(verdict('gh issue create --title "Parent: #607" --body "a bug"').blocked).toBe(true)
  })

  it('blocks when no body can be read at all', () => {
    expect(verdict('gh issue create --title x').blocked).toBe(true)
    expect(verdict('gh issue create --body-file /nope.md').blocked).toBe(true)
  })

  it('reads a heredoc, whose body exists only in the command', () => {
    expect(verdict(`gh issue create --body-file - <<EOF\n${PARENT}\nEOF`).blocked).toBe(false)
    expect(verdict('gh issue create --body-file - <<EOF\nnothing\nEOF').blocked).toBe(true)
    expect(verdict(`gh issue create --body-file - <<'EOF'\n${PARENT}\nEOF`).blocked, 'quoted delimiter').toBe(false)
  })

  it('reads the payload rather than the command around it', () => {
    // The title bypass again, one case over: `body = cmd` let a `Parent:` line in a title-side
    // heredoc satisfy a check about the body.
    const cmd = `gh issue create --title "$(cat <<T\n${PARENT}\nT\n)" --body-file - <<B\nno parent here\nB`
    expect(heredocs(cmd), 'both payloads, in order').toEqual([PARENT, 'no parent here'])
    expect(verdict(cmd).blocked).toBe(true)
  })

  it('blocks rather than guessing when a command carries several heredocs', () => {
    // Picking one would be a guess, and the wrong guess is the permissive one.
    expect(verdict(`gh issue create --body-file - <<A\n${PARENT}\nA\ncat <<B\nx\nB`).blocked).toBe(true)
  })
})

describe('what counts as naming a parent', () => {
  it('takes the line on its own, with or without an owner/repo prefix', () => {
    expect(hasParent(`intro\n\n${PARENT}\n`)).toBe(true)
    expect(hasParent('Parent: jo-duchan/tapflow#607')).toBe(true)
  })

  it('refuses a half-written cross-repository reference', () => {
    // The prefix used to be any run of the characters an owner/repo contains, so neither of these
    // was a reference and both switched the gate off.
    expect(hasParent('Parent: owner#607')).toBe(false)
    expect(hasParent('Parent: /#607')).toBe(false)
    expect(hasParent('Parent: owner/#607')).toBe(false)
  })

  const NOT_A_PARENT = {
    'prose that mentions the issue': 'Raised by the review of #647.',
    'the words mid-sentence': 'Its Parent: #607 is where this came from.',
    'inside a fenced block': `Write it like this:\n\n\`\`\`\n${PARENT}\n\`\`\`\n`,
    'inside a tilde fence': `Write it like this:\n\n~~~\n${PARENT}\n~~~\n`,
    'inside an indented block': `Write it like this:\n\n    ${PARENT}\n`,
    'quoted inline': `Put \`${PARENT}\` in the body.`,
    'no number': 'Parent: #',
  }
  for (const [name, body] of Object.entries(NOT_A_PARENT)) {
    it(`refuses: ${name}`, () => {
      expect(hasParent(body)).toBe(false)
    })
  }

  // The exact shape AGENTS.md prints. If this ever counted, documenting the convention would satisfy
  // the gate for whoever documents it — the failure `changesetReason.test.mjs` already names.
  it('refuses the snippet as AGENTS.md prints it', () => {
    expect(hasParent('Every split-out issue names its parent, on a line of its own: `Parent: #607`.')).toBe(false)
  })
})

describe('what counts as standing alone', () => {
  it('takes a marker with a reason', () => {
    expect(hasStandalone('<!-- standalone: reported by a user -->')).toBe(true)
  })

  it('refuses one with no reason, which is the marker without the decision', () => {
    expect(hasStandalone('<!-- standalone: -->')).toBe(false)
    expect(hasStandalone('<!-- standalone:  -->')).toBe(false)
  })

  it('refuses an unterminated marker', () => {
    expect(hasStandalone('<!-- standalone: forgot the close')).toBe(false)
  })

  it('refuses one quoted in a fenced block', () => {
    expect(hasStandalone('Say:\n\n```\n<!-- standalone: a reason -->\n```\n')).toBe(false)
  })
})

describe('the hook itself, spawned', () => {
  const run = (cmd) => spawnSync('bash', [path.join(REPO, '.claude/hooks/issue-parent-gate.sh')], {
    input: JSON.stringify({ tool_input: { command: cmd } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
  })

  it('blocks a bare issue and says what to add', () => {
    const r = run('gh issue create --title x --body "a bug"')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/Parent: #607/)
  })

  it('allows one that names its parent', () => {
    expect(run(`gh issue create --title x --body "${PARENT}"`).status).toBe(0)
  })

  it('allows an unrelated command without paying for node', () => {
    // The prefilter's job. `git status` never reaches the decision, which is why it can afford to be
    // a node process.
    expect(run('git status --short').status).toBe(0)
  })

  it('fails open on a payload it cannot parse', () => {
    const r = spawnSync('bash', [path.join(REPO, '.claude/hooks/issue-parent-gate.sh')], {
      input: 'not json at all, gh issue create',
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
    })
    expect(r.status, 'a malformed payload would block every Bash call in the session').toBe(0)
  })
})

// ── Added with the gate-misdiagnosis work ───────────────────────────────────────────────────────

/** `gh issue create`, assembled rather than written, so this file can be edited from a heredoc. */
const CREATE = ['gh', 'issue', 'create'].join(' ')

describe('a blocked command is told which rule it broke', () => {
  // **Both failures printed one constant.** The decision layer separated them from the first commit
  // and the entrypoint dropped `detail`, so a body file the gate could not open was reported as a
  // body naming no parent — and the author goes off to add a line that is already there. Measured
  // filing #700: the body had `Parent: #609` on its own line the whole time.
  it('separates an unreadable body file from a body that names nothing', () => {
    expect(verdict(`${CREATE} --body-file rel.md`).reason).toBe('unreadable-body-file')
    expect(verdict(`${CREATE} --body "a bug"`).reason).toBe('no-parent')
  })

  it('separates a body file it could not read from no body at all', () => {
    expect(verdict(`${CREATE} --title x`).reason).toBe('no-body')
  })

  it('names the path it tried, resolved', () => {
    // The hook judges from `CLAUDE_PROJECT_DIR`, so a relative `--body-file` is resolved against the
    // repo root rather than the cwd the command would actually run in. Following the command's own
    // `cd` would be guessing; saying which path was opened is not, and it is the whole fix.
    expect(verdict(`${CREATE} --body-file rel.md`).detail).toContain(path.resolve('rel.md'))
  })

  it('still blocks all three', () => {
    // The reasons are for the message. Nothing about which rule broke may change whether it blocks.
    for (const cmd of [`${CREATE} --body-file rel.md`, `${CREATE} --title x`, `${CREATE} --body "a bug"`]) {
      expect(verdict(cmd).blocked, cmd).toBe(true)
    }
  })
})

describe('a heredoc payload is text, not a command', () => {
  it('does not read an invocation written inside one', () => {
    // Found by being blocked from writing the plan document for this change: its prose carried
    // `&& gh issue create --body-file rel.md` as an example, and a heredoc payload tokenizes as bare
    // words, so that line landed in command position. Quoting is what saves `echo "…"` and the grep
    // pattern above; nothing was saving a heredoc, and the file's own header claims this case works.
    const doc = ['cat > plan.md <<EOF', 'Repro:', `A) cd /elsewhere && ${CREATE} --body-file rel.md`, 'EOF'].join('\n')
    expect(issueCreateInvocations(doc)).toEqual([])
  })

  it('reads the payload when the invocation outside it is real', () => {
    // Two different questions, and the fix to the first must not answer the second. The payload is
    // not where invocations live, and it is exactly where `--body-file -` gets its body.
    expect(verdict(`${CREATE} --body-file - <<EOF\n${PARENT}\nEOF`).blocked).toBe(false)
    expect(verdict(`${CREATE} --body-file - <<EOF\nnothing\nEOF`).blocked).toBe(true)
  })

  it('is not fooled by an unterminated one', () => {
    // No terminator means no payload anyone can read, which `heredocs` already decides. Leaving the
    // text scannable fails toward blocking, which is the safe direction for a gate.
    expect(issueCreateInvocations(`${CREATE} --title x <<EOF\nstill the same command`)).toHaveLength(1)
  })
})

describe('a newline begins a command', () => {
  it('sees an invocation on a line of its own', () => {
    // **A hole, not a nuisance.** `SEPARATOR` carried `;`, `&&` and `|` but not the newline, so
    // command position never reset across lines and a multi-line Bash call — the ordinary shape for
    // anything with a heredoc or a long flag list — walked straight past the gate.
    const cmd = `git status\n${CREATE} --title x --body "a bug"`
    expect(issueCreateInvocations(cmd)).toHaveLength(1)
    expect(verdict(cmd).blocked).toBe(true)
  })

  it('judges each line-separated invocation on its own body', () => {
    expect(verdict(`${CREATE} --body "${PARENT}"\n${CREATE} --body "a bug"`).blocked).toBe(true)
    expect(verdict(`${CREATE} --body "${PARENT}"\n${CREATE} --body "${PARENT}"`).blocked).toBe(false)
  })

  it('does not treat a newline inside a quoted argument as one', () => {
    // The tokenizer resolves quotes first, so a body with paragraphs stays one word.
    expect(verdict(`${CREATE} --body "intro\n\n${PARENT}\n"`).blocked).toBe(false)
  })
})

describe('the hook reports the reason it decided on', () => {
  const run = (cmd) => spawnSync('bash', [path.join(REPO, '.claude/hooks/issue-parent-gate.sh')], {
    input: JSON.stringify({ tool_input: { command: cmd } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
  })

  it('does not answer an unreadable body file with the parent rule', () => {
    const r = run(`${CREATE} --title x --body-file nowhere-at-all.md`)
    expect(r.status).toBe(2)
    expect(r.stderr, 'the misdiagnosis this change exists for').not.toMatch(/names no parent/i)
    expect(r.stderr, 'and it says which path it opened').toContain(path.join(REPO, 'nowhere-at-all.md'))
  })

  it('still answers a parentless body with the parent rule', () => {
    const r = run(`${CREATE} --title x --body "a bug"`)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/names no parent/i)
    expect(r.stderr).toMatch(/Parent: #607/)
  })
})
