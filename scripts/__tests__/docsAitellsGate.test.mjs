// The Stop gate that asks for an ai-tells pass when the session edited prose under `docs/`.
//
// **It had no test, and it was seeing 6 of 34 docs edits.** The transcript matcher required
// `file_path` to be the first key of the tool input, with a comment saying it is. That is true of
// `Write` and false of `Edit`, which serialises `{"replace_all": false, "file_path": …}` — measured
// across this project's transcripts, 1102 `Edit` records and not one of them adjacent. Editing an
// existing document is what `Edit` is for, so the gate was blind to the common case while reporting
// nothing wrong.
//
// The shapes below are copied from real transcript records rather than invented, because the bug was
// entirely in the gap between the shape assumed and the shape written.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '../..')
const HOOK = path.join(REPO, '.claude/hooks/docs-aitells-gate.sh')

/** A transcript line carrying one tool call, in the field order the runtime actually writes. */
const record = (name, input) => JSON.stringify({ message: { content: [{ type: 'tool_use', name, input }] } })

const EDIT = (file) => record('Edit', { replace_all: false, file_path: file, old_string: 'a', new_string: 'b' })
const WRITE = (file) => record('Write', { file_path: file, content: 'x' })
const AI_TELLS = record('Skill', { skill: 'ai-tells', args: 'en detect' })

/** Run the gate over a transcript built from `lines`. Returns its stdout (a JSON verdict, or ''). */
function run(lines, { stopHookActive = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aitells-'))
  const tx = path.join(dir, 'transcript.jsonl')
  writeFileSync(tx, lines.join('\n') + '\n')
  try {
    const r = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ transcript_path: tx, stop_hook_active: stopHookActive }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
    })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const blocked = (lines, opts) => {
  const out = run(lines, opts)
  return out !== '' && JSON.parse(out).decision === 'block'
}

describe('which docs edits the gate can see', () => {
  it('sees one made with Edit, where file_path is not the first key', () => {
    // The regression this file exists for. `Edit` is how an existing document is changed.
    expect(blocked([EDIT('/repo/docs/guide/agent.md')])).toBe(true)
  })

  it('sees one made with Write', () => {
    expect(blocked([WRITE('/repo/docs/guide/agent.md')])).toBe(true)
  })

  it('sees a translated doc under docs/ko', () => {
    expect(blocked([EDIT('/repo/docs/ko/guide/agent.md')])).toBe(true)
  })

  it('does not fire on an edit outside docs/', () => {
    expect(blocked([EDIT('/repo/packages/relay/src/server.ts'), WRITE('/repo/AGENTS.md')])).toBe(false)
  })

  it('does not fire on a docs path that is only mentioned in the replaced text', () => {
    // `[^}]*` keeps the match inside the same `input` object, so a source edit whose old_string
    // quotes a docs path is not a docs edit. Scoping to the whole line would have counted it.
    const line = record('Edit', {
      replace_all: false,
      file_path: '/repo/packages/relay/src/server.ts',
      old_string: 'see docs/guide/agent.md',
      new_string: 'see the guide',
    })
    expect(blocked([line])).toBe(false)
  })
})

describe('what satisfies it', () => {
  it('an ai-tells run in the same session', () => {
    expect(blocked([EDIT('/repo/docs/guide/agent.md'), AI_TELLS])).toBe(false)
  })

  it('but not the reminder text that merely names the skill', () => {
    // The reminder is injected into the transcript and says "run /ai-tells detect". Matching on the
    // prose rather than the invocation key would let the gate satisfy itself.
    const reminder = JSON.stringify({ message: { content: [{ type: 'text', text: 'Run /ai-tells detect before finishing.' }] } })
    expect(blocked([EDIT('/repo/docs/guide/agent.md'), reminder])).toBe(true)
  })
})

describe('it fails open where it must', () => {
  it('passes when re-entered after its own block', () => {
    // Without this a scripting error blocks the session forever.
    expect(blocked([EDIT('/repo/docs/guide/agent.md')], { stopHookActive: true })).toBe(false)
  })

  it('passes when the transcript is missing', () => {
    const r = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ transcript_path: '/nowhere/at/all.jsonl' }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('')
  })

  it('passes on a payload it cannot parse', () => {
    const r = spawnSync('bash', [HOOK], { input: 'not json', encoding: 'utf8', env: { ...process.env } })
    expect(r.status, 'a Stop hook that dies would block every session').toBe(0)
  })
})

describe('the message reaches a contributor who does not read Korean', () => {
  // `.claude/` is committed, so these hooks fire for anyone working in the repo with Claude Code —
  // #698 arrived from a first-time contributor carrying a `.work/reviews/` record, which exists only
  // because a hook demanded one. A block written in Korean is unreadable to exactly the people
  // AGENTS.md says to write English for.
  it('blocks in English', () => {
    const out = run([EDIT('/repo/docs/guide/agent.md')])
    expect(JSON.parse(out).reason).not.toMatch(/[가-힣]/)
  })
})
