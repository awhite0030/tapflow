// Which packages a published workspace package can reach through its PRODUCTION dependencies,
// read from `pnpm-lock.yaml` alone.
//
// From the lockfile, not from `pnpm why`, because the only caller that matters runs in the CI
// `changeset` job — which checks out and runs node, and never installs. There is no `node_modules`
// there and no dependency this file could take: it has to parse the lockfile itself.
//
// Why anyone wants this: root `package.json` is `private` with zero `dependencies`, so its only
// route to a shipped artifact is `pnpm.overrides`. An override that moves a package inside the
// relay image's production tree changes what ships, and the changeset gate classified root files
// by path and so never asked (#472).

/**
 * Sections of a pnpm lockfile, by their two-space top-level key.
 *
 * A hand-rolled reader rather than a YAML dependency — see the note above. It understands exactly
 * the shape pnpm writes: two-space nesting, values either inline after `:` or nested beneath, and
 * keys quoted only when they need to be. Anything else is ignored rather than guessed at.
 */
function section(lock, name) {
  const lines = (lock ?? '').split('\n')
  const start = lines.findIndex((l) => l === `${name}:`)
  if (start === -1) return []
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '') continue
    if (!l.startsWith(' ')) break // next top-level section
    out.push(l)
  }
  return out
}

const unquote = (s) => s.replace(/^['"]|['"]$/g, '')

/** Indentation width, in spaces. */
const indent = (l) => l.length - l.trimStart().length

/**
 * `{ 'packages/relay': { 'better-sqlite3': '12.11.1', … } }` — production dependencies only.
 *
 * `devDependencies` is deliberately skipped: a devDependency of a published package is not
 * installed by anyone who depends on it, which is the whole distinction this file exists to draw.
 */
export function importerProdDeps(lock) {
  const out = {}
  let importer = null
  let inProd = false
  let dep = null

  for (const l of section(lock, 'importers')) {
    const w = indent(l)
    const text = l.trim()

    if (w === 2 && text.endsWith(':')) {
      importer = unquote(text.slice(0, -1))
      out[importer] = {}
      inProd = false
      dep = null
    } else if (w === 4 && text.endsWith(':')) {
      // `dependencies:` is production. `optionalDependencies` installs by default, so it counts too.
      const key = text.slice(0, -1)
      inProd = key === 'dependencies' || key === 'optionalDependencies'
      dep = null
    } else if (w === 6 && inProd && text.endsWith(':')) {
      dep = unquote(text.slice(0, -1))
    } else if (w === 8 && inProd && dep && text.startsWith('version:')) {
      out[importer][dep] = text.slice('version:'.length).trim()
      dep = null
    }
  }
  return out
}

/** `{ 'better-sqlite3@12.11.1': { bindings: '1.5.0', … } }` */
export function snapshotDeps(lock) {
  const out = {}
  let pkg = null
  let inDeps = false
  let optional = false
  let peerNames = new Set()

  for (const l of section(lock, 'snapshots')) {
    const w = indent(l)
    const text = l.trim()

    // `pkg@1.0.0: {}` — a package with no dependencies of its own writes an inline empty map and
    // so does NOT end in `:`. Missing that branch dropped every leaf package from the key set,
    // which `prodReachableNames` survives (a leaf has no further edges anyway) and
    // `prodResolvedVersions` does not, because it enumerates keys.
    if (w === 2 && (text.endsWith(':') || text.endsWith(': {}'))) {
      pkg = unquote(text.replace(/:(\s*\{\})?$/, ''))
      out[pkg] = {}
      inDeps = false
      optional = false
      // pnpm records a RESOLVED PEER under `optionalDependencies`, and names it again in the key's
      // suffix. `'@radix-ui/react-slot@1.3.3(@types/react@19.2.17)(react@19.2.8)'` lists
      // `@types/react` there — counting it as a production edge made fifteen `@types/*` packages
      // production-reachable, so a routine dashboard type bump demanded a changeset.
      peerNames = new Set([...pkg.matchAll(/\(((?:@[^/()]+\/)?[^()@]+)@/g)].map((m) => m[1]))
    } else if (w === 4 && text.endsWith(':')) {
      const key = text.slice(0, -1)
      inDeps = key === 'dependencies' || key === 'optionalDependencies'
      optional = key === 'optionalDependencies'
    } else if (w === 6 && inDeps && pkg) {
      // `name: version`, where the name may be quoted and the version may carry a peer suffix.
      const at = text.indexOf(':')
      if (at < 1) continue
      const name = unquote(text.slice(0, at))
      // Only under `optionalDependencies`. The same name under `dependencies` is a genuine runtime
      // edge — `@hono/node-server` really does depend on the `hono` its key also names as a peer.
      if (optional && peerNames.has(name)) continue
      out[pkg][name] = text.slice(at + 1).trim()
    }
  }
  return out
}

/** The snapshot key for a dependency edge — `name@version`, peer suffix included. */
const snapshotKey = (name, version) => `${name}@${version}`

/**
 * `name@version` with the peer suffix removed but `(patch_hash=…)` kept.
 *
 * The patch hash is part of what ships: re-patching a production dependency changes the installed
 * code while the version string stays put.
 */
const bareKey = (name, version) =>
  `${name}@${version.replace(/\((?!patch_hash)[^)]*\)/g, '')}`

/**
 * Every package name reachable through production edges from `importers`.
 *
 * `link:` versions are workspace edges: they are followed into that importer rather than looked up
 * as a snapshot, which is how a transitive dependency of `@tapflowio/agent-core` counts as
 * reachable from `@tapflowio/relay`.
 */
export function prodReachableNames(lock, importers) {
  return new Set([...prodReachableKeys(lock, importers)].map((k) => k.slice(0, k.lastIndexOf('@'))))
}

/**
 * Every `name@version` reachable through production edges — peer suffix stripped, patch kept.
 *
 * Version-aware on purpose. A name-only answer said `ajv` was production-reachable and then let
 * `prodResolvedVersions` collect EVERY `ajv` in the lockfile, including the 6.15.0 that only
 * eslint pulls. Bumping that dev copy was reported as a production change.
 */
export function prodReachableKeys(lock, importers) {
  const imp = importerProdDeps(lock)
  const snaps = snapshotDeps(lock)
  const keys = new Set()
  const seen = new Set()

  const walkImporter = (path) => {
    if (seen.has(`i:${path}`)) return
    seen.add(`i:${path}`)
    for (const [name, version] of Object.entries(imp[path] ?? {})) {
      if (version.startsWith('link:')) {
        // `link:../agent-core` from `packages/relay` → `packages/agent-core`
        const target = new URL(version.slice('link:'.length), `file:///${path}/`).pathname.slice(1)
        walkImporter(target)
      } else {
        keys.add(bareKey(name, version))
        walkSnapshot(snapshotKey(name, version))
      }
    }
  }

  const walkSnapshot = (key) => {
    if (seen.has(key)) return
    seen.add(key)
    for (const [name, version] of Object.entries(snaps[key] ?? {})) {
      keys.add(bareKey(name, version))
      walkSnapshot(snapshotKey(name, version))
    }
  }

  for (const path of importers) walkImporter(path)
  return keys
}

/**
 * Root-manifest dependency directives whose value or presence differs between two manifests.
 *
 * `patchedDependencies` alongside `overrides`: patching a production dependency changes the code
 * that ships without moving any version, so neither path would otherwise see it.
 */
export function changedOverrideKeys(beforeJson, afterJson) {
  const read = (raw) => {
    try {
      const p = JSON.parse(raw ?? '{}').pnpm ?? {}
      return { ...(p.overrides ?? {}), ...(p.patchedDependencies ?? {}) }
    } catch { return {} }
  }
  const [a, b] = [read(beforeJson), read(afterJson)]
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((k) => a[k] !== b[k])
}

/**
 * The package an override key targets — `"fast-uri@>=3.0.0 <3.1.5"` → `fast-uri`.
 *
 * pnpm also accepts a parent selector, `parent>child` and `parent@1.0.0>child`, where the package
 * being overridden is the CHILD. Returning the parent there would look up reachability for the
 * wrong package and miss a production override.
 */
export function overrideKeyName(key) {
  // `>` only separates a selector when it is not part of a `>=` range.
  const sel = key.replace(/>=/g, '\u0000').lastIndexOf('>')
  const target = sel === -1 ? key : key.slice(sel + 1)
  const at = target.lastIndexOf('@')
  return at < 1 ? target : target.slice(0, at)
}

/**
 * Resolved versions of every production-reachable package: `{ hono: ['4.13.0'], … }`.
 *
 * The companion to `prodReachableNames`, for the case where no override changed but the lockfile
 * moved anyway. `AGENTS.md` now tells people to reach for `pnpm update` before an override — which
 * would relocate the blind spot rather than close it if only override edits were examined.
 */
export function prodResolvedVersions(lock, importers) {
  const out = {}
  for (const key of prodReachableKeys(lock, importers)) {
    const at = key.lastIndexOf('@')
    if (at < 1) continue
    ;(out[key.slice(0, at)] ??= new Set()).add(key.slice(at + 1))
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]))
}

/** Production-reachable packages whose resolved version set differs between two lockfiles. */
export function prodVersionChanges(lockBefore, lockAfter, importers) {
  const [a, b] = [
    prodResolvedVersions(lockBefore, importers),
    prodResolvedVersions(lockAfter, importers),
  ]
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (n) => (a[n] ?? []).join() !== (b[n] ?? []).join(),
  )
}
