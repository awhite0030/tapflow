// The Stop gate that asks for `a11y-lens check --pending` when a pre-commit check was skipped (#827).
//
// **The pending files are made by the installed CLI, not written here.** The gate counts files in a
// layout a11y-lens documents; a fixture typed by hand would keep passing after an upgrade moved that
// layout, with the gate silently off. So each case stages a UI file in a throwaway repo and lets the
// real `a11y-lens check --staged` time out against a fake agent — the same way a timeout records
// files in a real commit.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '../..')
const HOOK = path.join(REPO, '.claude/hooks/a11y-lens-pending-gate.sh')
const CLI = path.join(
  path.dirname(createRequire(import.meta.url).resolve('@a11y-lens/cli/package.json')),
  'bin/a11y-lens.mjs',
)

/** A transcript line carrying one Bash call, stamped like the runtime stamps it (now, by default). */
const bash = (command, timestamp = new Date().toISOString()) =>
  JSON.stringify({ timestamp, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })

let dir, repo, tx

function runGate(lines, { stopHookActive = false, projectDir = repo } = {}) {
  writeFileSync(tx, lines.join('\n') + '\n')
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ transcript_path: tx, stop_hook_active: stopHookActive }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout.trim()
}
const blocked = (lines, opts) => {
  const out = runGate(lines, opts)
  return out !== '' && JSON.parse(out).decision === 'block'
}
const pendingCount = () => {
  try {
    return readdirSync(path.join(repo, '.git/a11y-lens/pending')).filter((n) => n.endsWith('.json')).length
  } catch {
    return 0
  }
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'a11y-pending-'))
  repo = path.join(dir, 'repo')
  tx = path.join(dir, 'transcript.jsonl')
  const bin = path.join(dir, 'bin')
  mkdirSync(repo)
  mkdirSync(bin)
  // An agent that never answers in time.
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\ncat >/dev/null\nsleep 5\necho "[]"\n')
  chmodSync(path.join(bin, 'claude'), 0o755)
  const git = (...a) => execFileSync('git', a, { cwd: repo })
  git('init', '-q')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  mkdirSync(path.join(repo, 'src'))
  writeFileSync(path.join(repo, 'src/A.tsx'), 'export const A = () => <button>Go</button>\n')
  git('add', 'src/A.tsx')
  const r = spawnSync(process.execPath, [CLI, 'check', '--staged'], {
    cwd: repo,
    encoding: 'utf8',
    env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, A11Y_LENS_AGENT: 'claude', A11Y_LENS_TIMEOUT_MS: '300' },
  })
  expect(r.status, r.stderr).toBe(0)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('a skipped check the session has not followed up', () => {
  it('was recorded by the installed CLI', () => {
    // The floor under every case below: without a recorded file, "passes" would be vacuous.
    expect(pendingCount()).toBe(1)
  })

  it('blocks finishing and names the command', () => {
    const out = runGate([bash('git commit -m x')])
    expect(JSON.parse(out).decision).toBe('block')
    expect(JSON.parse(out).reason).toContain('a11y-lens check --pending')
  })

  it('passes on the second stop', () => {
    expect(blocked([], { stopHookActive: true })).toBe(false)
  })

  it('passes once --pending has run in this session, even if files are still recorded', () => {
    expect(blocked([bash('pnpm exec a11y-lens check --pending')])).toBe(false)
    expect(blocked([bash('A11Y_LENS_TIMEOUT_MS=600000 pnpm exec a11y-lens check --strict --pending')])).toBe(false)
  })

  it('is satisfied by a call split across lines', () => {
    expect(blocked([bash('pnpm exec a11y-lens check \\\n  --pending')])).toBe(false)
  })

  it('blocks again for a skip recorded after the session ran --pending', () => {
    // The record was written in beforeAll; a --pending call stamped before it did not see it.
    expect(blocked([bash('pnpm exec a11y-lens check --pending', '2000-01-01T00:00:00.000Z')])).toBe(true)
  })

  it('is not satisfied by a different a11y-lens command', () => {
    expect(blocked([bash('pnpm exec a11y-lens check --staged')])).toBe(true)
  })

  it('still blocks without a readable transcript', () => {
    writeFileSync(tx, '')
    const r = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ transcript_path: path.join(dir, 'missing.jsonl') }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    })
    expect(JSON.parse(r.stdout).decision).toBe('block')
  })
})

describe('nothing to follow up', () => {
  it('passes in a repository with nothing recorded', () => {
    const clean = mkdtempSync(path.join(tmpdir(), 'a11y-clean-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: clean })
      expect(blocked([], { projectDir: clean })).toBe(false)
    } finally {
      rmSync(clean, { recursive: true, force: true })
    }
  })

  it('passes outside a git repository', () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'a11y-plain-'))
    try {
      expect(blocked([], { projectDir: plain })).toBe(false)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('passes on a payload it cannot parse', () => {
    const r = spawnSync('bash', [HOOK], { input: 'not json', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo } })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('')
  })
})
