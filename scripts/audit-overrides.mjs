#!/usr/bin/env node
// Judges every entry in root `pnpm.overrides`: is it still needed, is it correct, does it reach
// production.
//
// Why: the block is hand-maintained, security-critical, and nothing validates it (#472). Measured
// on 2026-08-06, all fourteen entries were inert — removing the whole block and resolving cold
// produced a byte-identical tree — and six were also wrong. Nobody had asked, because there was no
// way to ask.
//
// The keys go wrong for one repeatable reason. Both #469 and #471 derived a key from the Dependabot
// ALERT, which reports only the range matching the version you happen to have installed. `fast-uri`
// had three affected ranges patched within fourteen minutes of each other; the alert showed one,
// and the key that came out of it left the current major line unguarded. So this reads the
// advisory's full affected set instead, which is the whole point of the correctness check.
//
// Usage: pnpm overrides:audit [--json]
//
// This script REWRITES `package.json` and `pnpm-lock.yaml` while it works and restores them from
// git. It refuses to start unless both are clean, so a crash can never lose uncommitted work and
// recovery is `git checkout --` rather than a backup file it might fail to write.
import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { pathToFileURL } from 'url'

const MANAGED = ['package.json', 'pnpm-lock.yaml']

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

const RECOVER = `git checkout -- ${MANAGED.join(' ')}`

// ── pure helpers, exported for the tests ──────────────────────────────────────

/**
 * `"fast-uri@>=3.0.0 <3.1.5"` → `{ name: 'fast-uri', range: '>=3.0.0 <3.1.5' }`
 *
 * A key with no range at all — `"esbuild": ">=0.28.1"` — is pnpm's documented default form, and
 * splitting on the last `@` turned it into `{ name: 'esbuil', range: 'esbuild' }`: a mangled name
 * that then looked up an advisory, got no results, and reported as successfully checked.
 */
export function parseKey(key) {
  const at = key.lastIndexOf('@')
  if (at < 1) return { name: key, range: '' }
  return { name: key.slice(0, at), range: key.slice(at + 1) }
}

// String() because a caller that passes a number — the shape this took before lines
// replaced majors — would otherwise crash inside a comparison rather than compare wrongly.
const parts = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0)

/** Semver compare, enough for `x.y.z` release versions. Prereleases are not used by this block. */
export function cmp(a, b) {
  const [pa, pb] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

export const major = (v) => parts(v)[0]

/**
 * The compatibility line a version belongs to. For 0.x that is `0.<minor>`, not `0`.
 *
 * Under semver a 0.x minor is a breaking boundary, and the block already relies on that — the
 * esbuild comment says so. Bucketing every 0.x into one line made `guarded` always contain the
 * key's own line, so `uncovered-line` could not fire for a 0.x package at all, and made every 0.x
 * advisory look like the one a key targeted.
 */
export const line = (v) => (major(v) === 0 ? `0.${parts(v)[1]}` : String(major(v)))

/**
 * Faults in one override entry, judged against the advisories that entry actually targets.
 *
 * `affected` is `[{ ghsa, range, patched }]` — one element per patched line, several lines per
 * advisory. Which advisory an override was written for is not recorded anywhere, so it is inferred:
 * the ones whose affected range shares a major with the key's own range.
 *
 * That inference is what keeps the check quiet. Judging against every advisory a package has ever
 * had asks a key pinned to 7.x to also cover 5.x and 6.x lines that nothing in the tree could
 * resolve — `protobufjs` alone produced seven such reports, all noise. The signal worth keeping is
 * narrower: for the advisory this key targets, is another of ITS lines left unguarded?
 */
export function judgeKey({ key, replacement }, affected, resolvedLine, siblings = []) {
  const { name, range } = parseKey(key)
  const faults = []
  const notes = []

  const lower = range.match(/>=\s*([\d.]+)/)?.[1]
  const upper = range.match(/<=?\s*([\d.]+)/)?.[1]
  const replLower = replacement.match(/(?:>=|\^|~)\s*([\d.]+)/)?.[1]
  const replUpper = replacement.match(/<\s*([\d.]+)/)?.[1]
  const keyLine = line(lower ?? upper ?? '0')

  // A key with no lower bound intersects every major below it — pnpm matches by range
  // intersection, not containment — so the replacement would force a cross-major jump on a
  // consumer that declared one. Fixed for undici in #469 and fast-uri/hono in #471.
  // An exact version (`shell-quote@1.8.4`) intersects only itself; a key with no range at all
  // matches every version there is, which is worse than a bare bound and gets its own fault.
  const exactKey = /^\d/.test(range.trim())
  if (!range) {
    faults.push({ kind: 'rangeless-key', detail: `\`${key}\` has no range — it matches every version` })
  } else if (!lower && !exactKey) {
    faults.push({ kind: 'unbounded-key-lower', detail: `\`${key}\` reaches every major below` })
  }

  // Every replacement in this block caps except one. esbuild is 0.x, where each minor is breaking.
  if (!replUpper && !/^\^|^~|^\d/.test(replacement.trim())) {
    faults.push({ kind: 'unbounded-replacement', detail: `\`${replacement}\` has no upper bound` })
  }

  const patched = affected.filter((a) => a.patched)

  // Which advisory an override targets is inferred from RANGE OVERLAP, not from the line the patch
  // lands on. For a 0.x package those differ by construction — `esbuild@>=0.27.3 <0.28.1` is
  // remediated by 0.28.1, a different line — so matching on the patch line found nothing at all.
  const overlapsKey = (a) => {
    const aLower = a.range.match(/>=\s*([\d.]+)/)?.[1]
    const aUpper = a.range.match(/<=?\s*([\d.]+)/)?.[1]
    if (aLower && upper && cmp(aLower, upper) > 0) return false
    if (aUpper && lower && cmp(aUpper, lower) < 0) return false
    return true
  }
  const targeted = new Set(patched.filter(overlapsKey).map((a) => a.ghsa))

  // The failure that produced #471: one advisory patches several lines the same day — fast-uri
  // shipped 4.1.2, 3.1.5 and 2.4.4 within fourteen minutes — and the key covers only the line the
  // Dependabot alert happened to show, because an alert reports the installed version's range.
  //
  // A NOTE, not a fault, and the distinction is the difference between a tool people read and one
  // they mute. Whether an uncovered line is worth a key depends on whether anything could ever
  // declare that range, which this cannot know: nothing in the tree declares `undici@^8`, so
  // demanding a key for the twelve advisories that also patch 8.x is noise. The faults below are
  // the unambiguous ones. This is for a human to judge.
  // Which lines this package already has cover for. Read from each entry's REPLACEMENT, not its
  // key: a key guards the line its replacement moves you onto, and for 0.x those differ —
  // `>=0.27.3 <0.28.1` is a key on line 0.27 that guards line 0.28.
  //
  // Judged per package, not per key: `fast-uri` carries three entries covering 2.x, 3.x and 4.x,
  // and judging each alone had all three reporting the other two as unguarded.
  const guarded = new Set(
    [{ key, replacement }, ...siblings].map((e) => {
      const fromRepl = e.replacement?.match(/(?:>=|\^|~)\s*([\d.]+)/)?.[1]
      const r = parseKey(e.key).range
      const fromKey = r.match(/>=\s*([\d.]+)/)?.[1] ?? r.match(/<=?\s*([\d.]+)/)?.[1]
      return line(fromRepl ?? fromKey ?? '0')
    }),
  )

  const uncovered = new Map()
  // Compared as LINES, not majors. `major(a.patched) < major(floorV)` is `0 < 0` for every 0.x
  // package, so this filter could not fire for exactly the packages `line()` was introduced for:
  // with the tree on esbuild 0.29, an advisory patching 0.21 was still reported as uncovered.
  const floorLine = resolvedLine ?? line(lower ?? upper ?? '0')
  for (const a of patched) {
    if (!targeted.has(a.ghsa)) continue
    const l = line(a.patched)
    if (guarded.has(l) || cmp(l, floorLine) < 0) continue
    // One entry per line, highest patch wins — a dozen advisories on one line say one thing.
    const prev = uncovered.get(l)
    if (!prev || cmp(a.patched, prev.patched) > 0) uncovered.set(l, a)
  }
  for (const [l, a] of [...uncovered].sort((x, y) => cmp(x[1].patched, y[1].patched))) {
    notes.push({
      kind: 'uncovered-line',
      detail: `${l}.x is affected too (${a.ghsa} patches it at ${a.patched}) and no key covers that line`,
    })
  }

  // A later advisory landing on the same line leaves the replacement floor below the safe floor.
  // shell-quote's `^1.8.4` permits 1.8.4, which a HIGH advisory later covered.
  if (replLower) {
    for (const a of patched) {
      if (line(a.patched) !== line(replLower)) continue
      if (cmp(replLower, a.patched) < 0) {
        faults.push({
          kind: 'stale-replacement-floor',
          detail: `replacement floor ${replLower} is below ${a.patched} (${a.ghsa}, affected ${a.range})`,
        })
      }
    }
  }

  const unrescuable = affected.filter((a) => !a.patched).map((a) => a.range)
  return { name, key, replacement, faults, notes, unrescuable }
}

/**
 * Highest advisory floor per compatibility LINE, per package.
 *
 * Keyed by `line()`, not `major()`. Keying by major collapsed 0.21.x, 0.27.x and 0.29.x into one
 * bucket, so esbuild's whole 0.x history shared a single floor — the newest patch anywhere in 0.x
 * was applied to every 0.x version present, and this feeds `belowFloor` and so the KEEP/RETIRE
 * verdict.
 */
export function floorsByPackage(advisories) {
  const out = {}
  for (const [name, affected] of Object.entries(advisories)) {
    for (const a of affected) {
      if (!a.patched) continue
      const l = line(a.patched)
      out[name] ??= {}
      if (!out[name][l] || cmp(a.patched, out[name][l]) > 0) out[name][l] = a.patched
    }
  }
  return out
}

/** Versions in `resolved` that sit below the floor for their own compatibility line. */
export function belowFloor(resolved, floorsForPackage) {
  if (!floorsForPackage) return []
  return resolved.filter((v) => {
    const floor = floorsForPackage[line(v)]
    return floor && cmp(v, floor) < 0
  })
}

/**
 * Every version pnpm resolved for `name`, from the lockfile's package list.
 *
 * Sliced by the name's own length, never by the last `@`: a peer-suffixed key such as
 * `'@hono/node-server@2.0.12(hono@4.13.0)'` puts the PEER's `@` last, so that read reported hono's
 * 4.13.0 as node-server's version — and the same for `axios@1.18.1(debug@4.4.3)`. Wrong versions
 * here feed the KEEP/RETIRE verdict directly.
 */
export function resolvedVersions(lockfile, name) {
  if (!name) return []
  return [
    ...new Set(
      lockfile
        .split('\n')
        .map((l) => l.trimEnd().replace(/^ {2}'?/, ''))
        .filter((l) => l.startsWith(`${name}@`))
        .map((l) => l.slice(name.length + 1).match(/^[\d.]+/)?.[0])
        .filter(Boolean),
    ),
  ]
}

/**
 * Does this entry make the tree safer? Differential, not absolute.
 *
 * `esbuild` leaves 0.21.5 and 0.25.12 below their floor whether the entry is there or not — its
 * key does not match them. Judging `without` against the floor alone called that KEEP. An entry
 * earns KEEP only by preventing something the tree would otherwise resolve.
 */
export function neededVerdict(resolvedWith, resolvedWithout, floorsForPackage) {
  const lowWith = belowFloor(resolvedWith, floorsForPackage)
  const newlyLow = belowFloor(resolvedWithout, floorsForPackage).filter((v) => !lowWith.includes(v))
  return { verdict: newlyLow.length ? 'KEEP' : 'RETIRE', newlyLow }
}

/**
 * Workspace packages in `whyOutput` that actually publish.
 *
 * `pnpm why --prod` lists private packages too, and counting `@tapflowio/playground` would mark a
 * dev-only override as reaching users.
 */
export function publishedReachers(whyOutput, publishedNames) {
  const published = new Set(publishedNames)
  return [
    ...new Set(
      whyOutput
        .split('\n')
        .filter((l) => /^(@tapflowio\/|tapflow@)/.test(l))
        .map((l) => l.split('@').slice(0, l.startsWith('@') ? 2 : 1).join('@'))
        .filter((n) => published.has(n)),
    ),
  ]
}

/** Workspace manifests that publish, from `pnpm ls -r --depth -1 --json`. */
export function publishedWorkspaceNames(lsJson) {
  return (
    lsJson
      .trim()
      .split('\n')
      .join('')
      .replace(/\]\[/g, ',')
      .match(/\{[^{}]*"name"[^{}]*\}/g)
      ?.map((x) => JSON.parse(x))
      .filter((x) => !x.private)
      .map((x) => x.name) ?? []
  )
}

// ── effectful parts ───────────────────────────────────────────────────────────

function assertClean() {
  const dirty = git('status', '--porcelain', '--', ...MANAGED)
  if (dirty) {
    console.error('Refusing to run: this script rewrites and restores these files from git.\n')
    console.error(dirty)
    // Deliberately not "commit or stash". If a previous run was interrupted these files are
    // mid-rewrite with `pnpm.overrides` deleted, and committing that would land the deletion of
    // the whole security block. Say how to undo before saying how to keep.
    console.error(`\nIf a previous run was interrupted, undo it with:\n  ${RECOVER}`)
    console.error('Otherwise commit or stash these changes first.')
    process.exit(2)
  }
}

const restore = () => git('checkout', '--', ...MANAGED)

/** Restoring is not something to trust — check it, and be loud when it did not work. */
function verifyRestored() {
  const dirty = git('status', '--porcelain', '--', ...MANAGED)
  if (!dirty) return true
  console.error(`\nFATAL: the working tree was left rewritten:\n${dirty}`)
  console.error(`Recover with:\n  ${RECOVER}`)
  return false
}

// `finally` does not run for a signal, and the window it guards contains a `pnpm install` — the
// command a user is most likely to interrupt when the registry stalls. Interrupted without this,
// the repo is left with `pnpm.overrides` deleted and nothing says so.
let mutating = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (mutating) {
      try { restore() } catch { /* verifyRestored reports it */ }
      verifyRestored()
    }
    process.exit(130)
  })
}

/** Resolve the workspace with `overrides` replaced, and hand back the resulting lockfile. */
function resolveWith(overrides) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  if (overrides === null) delete pkg.pnpm.overrides
  else pkg.pnpm.overrides = overrides
  mutating = true
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
  // Cold on purpose. Against the existing lockfile pnpm keeps any resolution that still satisfies
  // the range, so an override could look load-bearing purely because the lockfile is sticky —
  // which is the very confusion this audit exists to remove.
  // Bounded: without it a stalled registry leaves the tree rewritten for as long as the user waits.
  execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], {
    stdio: 'pipe',
    timeout: 10 * 60_000,
  })
  return readFileSync('pnpm-lock.yaml', 'utf8')
}

/** Full affected set per package, from the advisory database rather than from an alert. */
function fetchAdvisories(names) {
  const out = {}
  for (const name of names) {
    try {
      const all = []
      let after = null
      // Paginated, because a single page silently truncates: axios has 73 advisories and undici
      // 67, both past the 100-item ceiling this API allows in one request. A missed page reads as
      // "no such advisory", which is the direction that hides a stale floor.
      for (;;) {
        const cursor = after ? `, after:"${after}"` : ''
        const query = `{securityVulnerabilities(ecosystem:NPM, package:"${name}", first:100${cursor}){pageInfo{hasNextPage endCursor} nodes{advisory{ghsaId severity} vulnerableVersionRange firstPatchedVersion{identifier}}}}`
        const raw = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const page = JSON.parse(raw).data.securityVulnerabilities
        all.push(
          ...page.nodes.map((n) => ({
            ghsa: n.advisory.ghsaId,
            severity: n.advisory.severity,
            range: n.vulnerableVersionRange,
            patched: n.firstPatchedVersion?.identifier ?? null,
          })),
        )
        if (!page.pageInfo.hasNextPage) break
        after = page.pageInfo.endCursor
      }
      out[name] = all
    } catch {
      out[name] = null // distinct from []: unknown, not "no advisories"
    }
  }
  return out
}

/**
 * Which of these packages is reachable from a **published** package's production tree.
 *
 * Private packages are excluded: `@tapflowio/playground` shows up in `pnpm why --prod` output and
 * ships nothing, so counting it would mark a dev-only override as reaching users.
 */
function prodReachable(names) {
  const publishedNames = publishedWorkspaceNames(
    execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  )

  const out = {}
  for (const name of names) {
    try {
      const raw = execFileSync('pnpm', ['why', name, '-r', '--prod'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      out[name] = publishedReachers(raw, publishedNames)
    } catch {
      out[name] = []
    }
  }
  return out
}

async function main() {
  const asJson = process.argv.includes('--json')
  // Every path here is relative and git pathspecs resolve against cwd, so a run from a package
  // directory would inspect — and could rewrite — the wrong manifest.
  process.chdir(git('rev-parse', '--show-toplevel'))
  assertClean()

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const overrides = pkg.pnpm?.overrides ?? {}
  const entries = Object.entries(overrides).map(([key, replacement]) => ({ key, replacement }))
  if (!entries.length) {
    console.log('No overrides to audit.')
    return
  }

  const names = [...new Set(entries.map((e) => parseKey(e.key).name))]
  const advisories = fetchAdvisories(names)
  const reachable = prodReachable(names)

  // Resolution as it stands, before anything is touched — the comparison baseline.
  const withBlock = readFileSync('pnpm-lock.yaml', 'utf8')

  let withoutBlock
  try {
    withoutBlock = resolveWith(null)
  } finally {
    restore()
    mutating = false
  }

  const floors = floorsByPackage(
    Object.fromEntries(Object.entries(advisories).filter(([, v]) => v !== null)),
  )

  const results = entries.map((e) => {
    const { name } = parseKey(e.key)
    const affected = advisories[name]
    const resolved = resolvedVersions(withoutBlock, name)
    // The line of the highest resolved version — `'4'`, or `'0.29'` for a 0.x package.
    const resolvedLine = resolved.length
      ? line(resolved.reduce((a, b) => (cmp(a, b) >= 0 ? a : b)))
      : undefined
    const siblings = entries.filter((o) => o !== e && parseKey(o.key).name === name)
    const judged = affected
      ? judgeKey(e, affected, resolvedLine, siblings)
      : { ...e, name, faults: [], notes: [], unrescuable: [] }

    const { verdict, newlyLow } = neededVerdict(
      resolvedVersions(withBlock, name),
      resolved,
      floors[name],
    )
    return {
      ...judged,
      advisoriesKnown: affected !== null,
      neededVerdict: verdict,
      stillLow: newlyLow,
      prodReachableFrom: reachable[name] ?? [],
    }
  })

  if (!verifyRestored()) process.exit(3)

  if (asJson) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    report(results)
  }
  process.exitCode = results.some((r) => r.faults.length) ? 1 : 0
}

function report(results) {
  const retire = results.filter((r) => r.neededVerdict === 'RETIRE')
  const faulty = results.filter((r) => r.faults.length)
  const unknown = results.filter((r) => !r.advisoriesKnown)

  console.log('\npnpm.overrides audit\n')
  for (const r of results) {
    const tags = [
      r.neededVerdict,
      r.prodReachableFrom.length ? 'PROD' : 'dev-only',
      r.faults.length ? `${r.faults.length} fault(s)` : null,
      r.notes.length ? `${r.notes.length} note(s)` : null,
    ].filter(Boolean)
    console.log(`  ${r.key}`)
    console.log(`    ${tags.join('  ·  ')}`)
    if (r.prodReachableFrom.length) console.log(`    reaches: ${r.prodReachableFrom.join(', ')}`)
    if (r.neededVerdict === 'KEEP') console.log(`    without it: ${r.stillLow.join(', ')} below floor`)
    for (const f of r.faults) console.log(`    ! ${f.kind}: ${f.detail}`)
    for (const n of r.notes) console.log(`    - ${n.kind}: ${n.detail}`)
    if (r.unrescuable.length) {
      console.log(`    note: no patch exists for ${r.unrescuable.join(', ')} — an override cannot rescue that line`)
    }
    console.log()
  }

  if (unknown.length) {
    // Never silent. Deriving keys from the advisory rather than from an alert is the reason this
    // script exists, so a lookup that did not happen has to be visible.
    console.log(`Advisory lookup unavailable for ${unknown.length} package(s) — correctness NOT checked:`)
    console.log(`  ${[...new Set(unknown.map((r) => r.name))].join(', ')}`)
    console.log('  (needs `gh` authenticated with network access)\n')
  }
  console.log(`${retire.length}/${results.length} entries change nothing and can be retired.`)
  if (faulty.length) console.log(`${faulty.length} entr(ies) have faults — see above.`)
  console.log(
    '\nPrefer `pnpm update <pkg>` over adding an override: it leaves no permanent entry to maintain.',
  )
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // The original failure first: with `stdio: 'pipe'`, pnpm's reason lives in `err.stderr` and is
    // otherwise never seen. Then restore, then say plainly whether that worked — a tree left
    // rewritten has to be louder than a failed audit.
    console.error(err.message)
    if (err.stderr) console.error(String(err.stderr))
    try { restore() } catch (e) { console.error(`restore failed: ${e.message}`) }
    process.exit(verifyRestored() ? 1 : 3)
  })
}
