// The parsers are unit-tested next door. This drives the actual CLI against a throwaway git
// repository, because the part that broke twice was the wiring, not the parsing: reading
// changesets at a merge that had already deleted them, and counting only ADDED ones so a PR that
// amended an existing entry was reported as a gap.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-changeset.mjs')

let repo
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

/** Commit `files` on a branch and merge it with a GitHub-shaped merge subject. */
function mergePr(number, branch, files) {
  git('checkout', '-q', '-b', branch)
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(repo, dirname(path)), { recursive: true })
    writeFileSync(join(repo, path), body)
  }
  git('add', '-A')
  git('commit', '-q', '-m', `work for #${number}`)
  git('checkout', '-q', 'main')
  git('merge', '--no-ff', '-q', branch, '-m', `Merge pull request #${number} from me/${branch}`)
}

/** Runs the audit; returns {code, out} rather than throwing, since a gap exits 1. */
function audit(since = 'v0') {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, '--audit', since], { cwd: repo, encoding: 'utf8' }) }
  } catch (e) {
    return { code: e.status, out: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'tapflow-audit-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 'T')
  git('config', 'commit.gpgsign', 'false')
  mkdirSync(join(repo, '.changeset'), { recursive: true })
  writeFileSync(join(repo, '.changeset', 'README.md'), 'changesets')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  git('tag', 'v0')
})

afterEach(() => rmSync(repo, { recursive: true, force: true }))

const CHANGESET = (body) => `---\n"@tapflowio/relay": patch\n---\n\n${body}\n`

describe('audit --audit against real git history', () => {
  it('reports a merge that shipped code without a changeset', () => {
    mergePr(101, 'fix-a', { 'packages/relay/src/a.ts': 'export const a = 1\n' })
    const { code, out } = audit()
    expect(code).toBe(1)
    expect(out).toContain('#101')
  })

  it('stays quiet when the same merge carries its changeset', () => {
    mergePr(101, 'fix-a', {
      'packages/relay/src/a.ts': 'export const a = 1\n',
      '.changeset/fix-a.md': CHANGESET('Fixes a.'),
    })
    expect(audit().code).toBe(0)
  })

  // The reason this feature exists. Without it the gap is reported for the whole release cycle,
  // and confirming it is a false alarm means matching changesets to merges by hand every run.
  it('clears an earlier merge when a later changeset declares it backfills it', () => {
    mergePr(101, 'fix-a', { 'packages/relay/src/a.ts': 'export const a = 1\n' })
    mergePr(102, 'backfill', { '.changeset/late.md': CHANGESET('Fixes a.\n\nBackfills: #101') })
    const { code, out } = audit()
    expect(code).toBe(0)
    expect(out).toContain('Every merge')
  })

  it('does not clear a merge the backfill did not name', () => {
    mergePr(101, 'fix-a', { 'packages/relay/src/a.ts': 'export const a = 1\n' })
    mergePr(103, 'fix-b', { 'packages/relay/src/b.ts': 'export const b = 1\n' })
    mergePr(102, 'backfill', { '.changeset/late.md': CHANGESET('Fixes a.\n\nBackfills: #101') })
    const { code, out } = audit()
    expect(code).toBe(1)
    expect(out).toContain('#103')
    expect(out).not.toContain('#101')
  })

  // A PR that extends an existing entry is still writing release notes. Counting only ADDED
  // changesets reported #420 as a gap when it had amended the clipboard entry.
  it('accepts an amended changeset, not just a new one', () => {
    mergePr(101, 'first', {
      'packages/relay/src/a.ts': 'export const a = 1\n',
      '.changeset/entry.md': CHANGESET('Fixes a.'),
    })
    mergePr(102, 'follow-up', {
      'packages/relay/src/a.ts': 'export const a = 2\n',
      '.changeset/entry.md': CHANGESET('Fixes a, and b as well.'),
    })
    expect(audit().code).toBe(0)
  })

  // `changeset version` consumes changesets and bumps every package.json. Reading them at that
  // merge fails outright — they no longer exist there.
  it('does not choke on the release merge, which deletes changesets', () => {
    mergePr(101, 'fix-a', {
      'packages/relay/src/a.ts': 'export const a = 1\n',
      '.changeset/entry.md': CHANGESET('Fixes a.'),
    })
    git('checkout', '-q', '-b', 'release')
    rmSync(join(repo, '.changeset', 'entry.md'))
    writeFileSync(join(repo, 'packages/relay/package.json'), '{"version":"0.2.0"}\n')
    writeFileSync(join(repo, 'packages/relay/CHANGELOG.md'), '## 0.2.0\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'release')
    git('checkout', '-q', 'main')
    git('merge', '--no-ff', '-q', 'release', '-m', 'Merge pull request #199 from me/release')

    const { code, out } = audit()
    expect(code).toBe(0)
    expect(out).not.toMatch(/fatal|does not exist/)
  })

  it('ignores a bot merge, which can never carry a changeset', () => {
    mergePr(104, 'dependabot/npm/foo', { 'packages/relay/package.json': '{"a":1}\n' })
    expect(audit().code).toBe(0)
  })
})
