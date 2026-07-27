#!/usr/bin/env node
// Fails a PR that changes published source without adding a changeset.
//
// Why: between v0.16.0 and v0.17.0 four PRs (#410–#413) changed shipped code with no changeset
// between them, and the omission only surfaced while preparing the release. The rule was written
// down in CONTRIBUTING.md and nothing enforced it, so the release notes would have announced the
// clipboard bridge and stayed silent on the four fixes underneath it.
//
// Usage: node scripts/check-changeset.mjs <base-ref>   (default: origin/main)
//
// Opting out: put `<!-- no-changeset: reason -->` in the PR body, or pass --reason "…" locally.
// A comment-only or test-only change is a legitimate skip; the point is that skipping is a
// decision someone writes down, not something that happens by forgetting.
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'
import { realpathSync } from 'fs'

// Inverted on purpose: everything under `packages/` ships unless named here. Listing what
// ships instead left a NEW published package invisible to the gate — the case that most needs
// a release note — while the comment below claimed the opposite. `dashboard` is deliberately
// absent from this list: it is `private`, but it is built into the relay's `public/` and
// shipped inside that package, and it is tapflow's primary user surface.
const NOT_SHIPPED_PACKAGES = ['docs', 'playground']

// Deny by default. An earlier version listed what ships — `src/**` with a TypeScript extension —
// and so ignored `.sql` migrations, `bin/`, `proto/`, `schema/`, `xctest-runner/`, the dashboard
// entirely, and every `package.json`. Listing the EXCEPTIONS instead means a new shipped
// directory errs toward asking for a changeset, which is the harmless direction to be wrong in.
const EXEMPT = [
  /(^|\/)__tests__\//,
  /(^|\/)__fixtures__\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /Test\.swift$/,                                  // the XCUITest runner's own test target
  /(^|\/)dist\//,
  /(^|\/)\.(gitignore|env[^/]*)$/,
  /(^|\/)(README|LICENSE|CHANGELOG|AGENTS|CLAUDE|DESIGN)(\.md)?$/i,
  /(^|\/)(tsconfig[^/]*\.json|vitest\.config\.[^/]+|eslint\.config\.[^/]+|\.npmignore)$/,
]

const PACKAGE_FILE = /^packages\/([^/]+)\//
/** Would a user of a released tapflow notice this file changing? Exported for the tests. */
export function shipsToUsers(f) {
  const pkg = f.match(PACKAGE_FILE)?.[1]
  if (!pkg || NOT_SHIPPED_PACKAGES.includes(pkg)) return false
  return !EXEMPT.some((re) => re.test(f))
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

/**
 * Pull `<!-- no-changeset: reason -->` out of a PR body.
 *
 * Two rules, both learned the hard way: the marker must be the WHOLE line, and it must not be
 * inside a fenced code block. Otherwise any PR that merely quotes the syntax — a PR explaining
 * the rule, or the PR that introduced it, both of which paste the snippet from CONTRIBUTING.md —
 * silently switches the gate off.
 *
 * Exported for the tests.
 */
export function extractReason(body) {
  let fenced = false
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    if (/^ {4,}|^\t/.test(raw)) continue          // indented code block
    const m = line.match(/^<!--\s*no-changeset:\s*(.*?)\s*-->$/)
    if (m && m[1]) return m[1]
  }
  return ''
}

function main() {
  // `--audit [since]` walks merges instead of the current branch: the PR gate cannot help with
  // anything already on main, and that is exactly how #410–#413 slipped through. Run at release
  // time, from /release step 1.
  if (process.argv.includes('--audit')) {
    const i = process.argv.indexOf('--audit')
    const after = process.argv[i + 1]
    let since = after && !after.startsWith('-') ? after : null
    if (!since) {
      try {
        since = git('describe', '--tags', '--abbrev=0')
      } catch {
        console.error('No tags here — pass an explicit revision: pnpm changeset:audit <ref>')
        process.exit(2)
      }
    }

    const merges = git('log', `${since}..HEAD`, '--merges', '--format=%H %s').split('\n').filter(Boolean)
    const gaps = []
    for (const line of merges) {
      const [sha, ...rest] = line.split(' ')
      const subject = rest.join(' ')
      const files = git('diff', '--name-only', `${sha}^1`, sha).split('\n').filter(Boolean)
      const shipped = files.filter((f) => shipsToUsers(f))
      const cs = files.filter((f) => /^\.changeset\/.+\.md$/.test(f) && !/^\.changeset\/README\.md$/i.test(f))
      // Same exemption the CI job makes. Without it the audit reports a bot's dependency bump as
      // a permanent gap: the gate never asked for that changeset, so nobody can ever close it.
      if (/dependabot|renovate/i.test(subject)) continue
      if (shipped.length > 0 && cs.length === 0) gaps.push({ subject, shipped })
    }

    console.log(`Merges since ${since}: ${merges.length}`)
    if (gaps.length === 0) {
      console.log('Every merge that changed published source carries a changeset.')
      process.exit(0)
    }
    console.log(`\n  ${gaps.length} merge(s) changed published source with no changeset:\n`)
    for (const { subject, shipped } of gaps) {
      console.log(`    ${subject}`)
      for (const f of shipped.slice(0, 5)) console.log(`      ${f}`)
      if (shipped.length > 5) console.log(`      …and ${shipped.length - 5} more`)
    }
    console.log(`
    These will be missing from the changelog. Either backfill a changeset for each, or
    confirm the change is genuinely not worth a release note.
  `)
    process.exit(1)
  }

  // Parse rather than index. Reading `argv[2]` blindly handed `--reason` itself to
  // `git merge-base`; skipping only dash-prefixed words then handed it the reason TEXT.
  const argv = process.argv.slice(2)
  const positional = []
  let reasonArg = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reason') { reasonArg = argv[++i] ?? ''; continue }
    if (argv[i] === '--audit') { i++; continue }        // its value is read in the audit branch
    if (!argv[i].startsWith('-')) positional.push(argv[i])
  }
  const base = positional[0] ?? 'origin/main'
  const reason = reasonArg !== null ? reasonArg.trim() : extractReason(process.env.PR_BODY ?? '')

  let mergeBase
  try {
    mergeBase = git('merge-base', base, 'HEAD')
  } catch {
    console.error(`Could not find a merge base with ${base}. Fetch it first:  git fetch origin main`)
    process.exit(2)
  }

  const changed = git('diff', '--name-only', `${mergeBase}...HEAD`).split('\n').filter(Boolean)
  const shipped = changed.filter((f) => shipsToUsers(f))

  if (shipped.length === 0) {
    console.log('No published source changed — no changeset required.')
    process.exit(0)
  }

  // Added, not merely present: `.changeset/` always has entries waiting for the next release, so
  // "a changeset exists" is true on every branch and would never fail.
  const added = git('diff', '--name-only', '--diff-filter=A', `${mergeBase}...HEAD`)
    .split('\n')
    .filter((f) => /^\.changeset\/.+\.md$/.test(f) && !/^\.changeset\/README\.md$/i.test(f))

  if (added.length > 0) {
    console.log(`Published source changed and ${added.length} changeset(s) added:`)
    for (const f of added) console.log(`  + ${f}`)
    process.exit(0)
  }

  if (reason) {
    console.log(`Published source changed with no changeset, skipped on purpose:\n  ${reason}`)
    process.exit(0)
  }

  console.error('\n  This branch changes published source but adds no changeset.\n')
  for (const f of shipped.slice(0, 20)) console.error(`    ${f}`)
  if (shipped.length > 20) console.error(`    …and ${shipped.length - 20} more`)
  console.error(`
    Add one:

        pnpm changeset

    Write it for someone reading the release notes: what was wrong, what they get now.

    If this genuinely needs no release note — a comment, a rename with no behaviour change —
    say so in the PR body:

        <!-- no-changeset: comment-only follow-up to #123 -->
  `)
  process.exit(1)
}

// Only when run directly: the tests import `extractReason` from here.
// `realpathSync`: `import.meta.url` is already resolved, `argv[1]` is not, so invoking
// through a symlink skipped `main()` entirely and the gate reported success having done nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()
