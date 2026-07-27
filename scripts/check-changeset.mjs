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
/**
 * PR number of a merge commit, from its subject. `null` for anything else (a hand-made merge,
 * a squash). Exported for the tests.
 */
export function prNumberOf(subject) {
  const m = /^Merge pull request #(\d+) /.exec(subject)
  return m ? Number(m[1]) : null
}

/**
 * PR numbers a changeset declares it is writing release notes for, from a `Backfills: #1, #2`
 * line. Exported for the tests.
 *
 * Why this exists: the audit judges each merge on its own, so a changeset added by a LATER PR to
 * cover an earlier one never clears it. During the v0.17.0 cycle four merges were reported as
 * gaps for a week after they had in fact been covered, and the only way to know was to match
 * them up by hand on every run. A backfill now says which merges it answers for.
 */
export function parseBackfills(body) {
  const out = []
  // Frontmatter skipped: `Backfills:` there is a YAML key, not a claim. Fences and indented
  // blocks skipped for the same reason `extractReason` skips them — the audit's own failure
  // message prints `Backfills: #413` indented, and CONTRIBUTING, AGENTS and /release all carry
  // it verbatim, so a changeset that documents the convention must not clear whatever it names.
  for (const { line } of proseLines(body, { skipFrontmatter: true })) {
    const m = /^Backfills:\s*(.+?)\s*$/i.exec(line)
    if (!m) continue
    for (const ref of m[1].matchAll(/#(\d+)/g)) out.push(Number(ref[1]))
  }
  return out
}

/**
 * Is this the branch `pnpm changeset version` produces? It consumes (deletes) the changesets it
 * folds into the changelogs, so a gate looking for ADDED ones fails the release PR — which, with
 * the check required, blocks the release itself. Both halves are needed: deleting a changeset
 * you decided against is not a release. Exported for the tests.
 */
export function isReleaseBranch(consumedChangesets, changedFiles) {
  if (consumedChangesets.length === 0) return false
  return changedFiles.some((f) => /(^|\/)CHANGELOG\.md$/.test(f))
}

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
/**
 * The lines of a markdown body that are actually prose: no fenced block, no indented block, and
 * — with `skipFrontmatter` — nothing inside the leading `---` delimiters.
 *
 * Shared on purpose. Both markers below are switches that turn a gate OFF, so a body that merely
 * QUOTES one must not trip it; every doc in this repo prints both verbatim. `extractReason` had
 * this guard and `parseBackfills` was written without it, which is exactly the kind of drift a
 * second copy invites.
 */
function* proseLines(body, { skipFrontmatter = false } = {}) {
  const lines = body.split(/\r?\n/)
  let i = 0
  if (skipFrontmatter && lines[0]?.trim() === '---') {
    i = 1
    while (i < lines.length && lines[i].trim() !== '---') i++
    i++                                            // step past the closing delimiter
  }
  let fenced = false
  for (; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    if (/^ {4,}|^\t/.test(raw)) continue           // indented code block
    yield { raw, line }
  }
}

export function extractReason(body) {
  for (const { line } of proseLines(body)) {
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

    let mergeLog
    try {
      // stderr silenced so git's own "ambiguous argument" dump does not precede our message.
      mergeLog = execFileSync('git', ['log', `${since}..HEAD`, '--merges', '--format=%H %s'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      // Exit 2, not 1: a typo'd revision must not look like a finding.
      console.error(`Not a revision in this repository: ${since}`)
      process.exit(2)
    }
    const merges = mergeLog.split('\n').filter(Boolean)
    const isChangeset = (f) => /^\.changeset\/.+\.md$/.test(f) && !/^\.changeset\/README\.md$/i.test(f)

    // First pass: which merges does a later changeset claim to cover? Each changeset is read at
    // the merge that ADDED it — by release time they have been consumed and are gone from HEAD.
    // A claim is (pr → index of the merge that made it). Index 0 is the newest merge, so a claim
    // at index i may only clear merges at a LARGER index — ones that landed before it. Without
    // that a claim written today pre-clears a merge that arrives tomorrow.
    // stderr silenced: `cat-file -e` is a question, not a failure, and git answers "no" by
    // printing `fatal: path does not exist` straight to the console.
    const liveAtHead = (f) => {
      try {
        execFileSync('git', ['cat-file', '-e', `HEAD:${f}`], { stdio: 'ignore' })
        return true
      } catch { return false }
    }

    // Pass 1 — what each merge touched. No judgement yet: whether a claim counts depends on
    // whether its changeset survived, and a release merge later in the list is what legitimately
    // removes one, so nothing can be decided in a single sweep.
    const perMerge = merges.map((line, index) => {
      const [sha, ...rest] = line.split(' ')
      const changed = (filter) =>
        git('diff', '--name-only', `--diff-filter=${filter}`, `${sha}^1`, sha)
          .split('\n').filter(Boolean)
      // Every status, deletions included. Narrowing this dropped removals from `shipped`, so a
      // merge that DELETED a shipped file — the highest-consequence change there is — audited
      // clean. The narrowing belongs on `touched`, not here.
      const files = git('diff', '--name-only', `${sha}^1`, sha).split('\n').filter(Boolean)
      // Added, amended or renamed — never deleted. A release merge lists the changesets it
      // consumed and reading those at that commit fails, they are gone by then. Amendments count:
      // a PR extending an existing entry is still writing release notes, which is what #420 did.
      return {
        sha, index, files,
        subject: rest.join(' '),
        touched: changed('AMR').filter(isChangeset),
        consumed: changed('D').filter(isChangeset),
      }
    })

    // A changeset removed by the release merge was consumed, not abandoned.
    const consumedByRelease = new Set(
      perMerge.filter((m) => isReleaseBranch(m.consumed, m.files)).flatMap((m) => m.consumed),
    )

    // Pass 2 — coverage claims. Keyed pr → index of the claiming merge. Index 0 is the newest, so
    // a claim at index i may only clear merges at a LARGER index: ones that landed before it.
    // Otherwise a claim written today silently pre-clears a merge that arrives tomorrow.
    const claims = new Map()
    for (const { sha, index, touched } of perMerge) {
      for (const f of touched) {
        // The claim holds only while its changeset is still going to reach a changelog. Written
        // and then dropped in a follow-up, nothing gets a release note and the audit must say so
        // again — being consumed by a release is the one legitimate way for it to disappear.
        if (!liveAtHead(f) && !consumedByRelease.has(f)) continue
        for (const pr of parseBackfills(git('show', `${sha}:${f}`))) {
          if (!claims.has(pr)) claims.set(pr, index)
        }
      }
    }

    const gaps = []
    for (const { subject, files, touched, consumed, index } of perMerge) {
      // Same exemption the CI job makes. Without it the audit reports a bot's dependency bump as
      // a permanent gap: the gate never asked for that changeset, so nobody can ever close it.
      if (/dependabot|renovate/i.test(subject)) continue
      // A release merge bumps every package.json while consuming changesets rather than adding
      // any. Recognised by that signature, so a release whose changesets were consumed in an
      // earlier commit already on main still reports — narrower than the name suggests.
      if (isReleaseBranch(consumed, files)) continue
      const pr = prNumberOf(subject)
      const claimedAt = pr === null ? undefined : claims.get(pr)
      if (claimedAt !== undefined && claimedAt < index) continue
      const shipped = files.filter((f) => shipsToUsers(f))
      if (shipped.length > 0 && touched.length === 0) gaps.push({ subject, shipped })
    }

    // stdout carries the verdict, stderr the diagnosis — so `2>/dev/null` leaves a caller with
    // the answer and nothing else. The guidance block below broke that by staying on stdout.
    console.error(`Merges since ${since}: ${merges.length}`)
    if (gaps.length === 0) {
      console.log('Every merge that changed published source carries a changeset.')
      process.exit(0)
    }
    console.error(`\n  ${gaps.length} merge(s) changed published source with no changeset:\n`)
    for (const { subject, shipped } of gaps) {
      console.error(`    ${subject}`)
      for (const f of shipped.slice(0, 5)) console.error(`      ${f}`)
      if (shipped.length > 5) console.error(`      …and ${shipped.length - 5} more`)
    }
    console.error(`
    These will be missing from the changelog. Either confirm the change is not worth a
    release note, or backfill one — and name what it covers, so a later run stops
    reporting a gap that has already been filled:

        Backfills: #413
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

  // A `changeset version` branch bumps every `packages/*/package.json` and DELETES the
  // changesets it consumed, so it trips a gate that only looks for added ones — with the check
  // required, that blocks the release PR permanently. Recognise it by its signature: changesets
  // removed plus changelogs written. Verified against a real `pnpm changeset version` run.
  const consumed = git('diff', '--name-only', '--diff-filter=D', `${mergeBase}...HEAD`)
    .split('\n')
    .filter((f) => /^\.changeset\/.+\.md$/.test(f))
  if (isReleaseBranch(consumed, changed)) {
    console.log(`Release branch: ${consumed.length} changeset(s) consumed into a changelog.`)
    process.exit(0)
  }

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
