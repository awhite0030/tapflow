import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * What ties the committed network-filter `.app` to the sources it was built from.
 *
 * The extension is signed and notarized on a maintainer's Mac and committed as a binary, because
 * ad-hoc signing does not load and the signing key deliberately does not live in CI. That leaves one
 * failure this repo can actually catch: **someone edits the Swift and forgets to rebuild**, and a
 * release ships a binary that does not match its own sources.
 *
 * **Recording the source hash alone would not catch it.** The person who forgets the rebuild forgets
 * the hash too, both values stay consistent with each other, and the check passes — it would only
 * catch someone who updated the record deliberately, which is the person who did not forget. So the
 * record carries the artifact's hash as well, and `build.sh` writes both in the same step that
 * produces the artifact.
 *
 * What it does **not** claim, and the list is worth reading before trusting this:
 *
 * - that the committed binary was built from the committed sources — nothing here can say that;
 * - anything about **how it was signed**. A Developer-ID-signed, notarized bundle and an ad-hoc one
 *   satisfy this identically, and ad-hoc is the thing that does not load. Recording the signing
 *   authority would need `codesign`, which is macOS-only while this runs on the CI's Linux.
 *
 * It says the two trees were recorded together and that neither has changed since. `project.pbxproj`
 * is deliberately not an input: `xcodegen` rewrites it on every build with fresh identifiers, so
 * hashing it would report a change for every build and nothing else.
 */
export const NETFILTER_DIR = 'packages/ios-agent/ios-netfilter'
export const SHIPPED_APP = 'packages/ios-agent/bin/TapflowNetFilter.app'
export const RECORD = `${NETFILTER_DIR}/shipped.json`

/**
 * Everything whose change means the artifact should be rebuilt.
 *
 * `build.sh` and the entitlements are in here for a reason the first draft missed: they change what is
 * produced without touching a line of Swift — signing flags, the hardened-runtime entitlements, the
 * notarization step.
 */
const SOURCE_GLOBS = [
  ['Extension'], ['Host'], ['Shared'],
]
const SOURCE_FILES = ['project.yml', 'build.sh']

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out

  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.isFile()) out.push(p)
  }
  return out
}

/** Path + bytes, in a stable order. Path is hashed too: moving a file changes the build. */
function hashFiles(root, files) {
  const h = createHash('sha256')
  for (const f of files) {
    h.update(path.relative(root, f).split(path.sep).join('/'))
    h.update('\0')
    h.update(fs.readFileSync(f))
    h.update('\0')
  }
  return h.digest('hex')
}

/**
 * **A declared input that is not there is an error, not an empty set.**
 *
 * Both halves of this used to shrug: a missing directory returned nothing and a missing file was
 * skipped. Renaming `build.sh` — the file whose comment above says it is watched *because* it changes
 * the artifact without touching Swift — would have dropped it from the hash silently, and the
 * file-count floor cannot see it: one aggregate number stays comfortably above the floor while a
 * whole directory goes unwatched.
 */
export function collectSources(repo) {
  const base = path.join(repo, NETFILTER_DIR)
  const files = []
  for (const [dir] of SOURCE_GLOBS) {
    const d = path.join(base, dir)
    if (!fs.existsSync(d)) throw new Error(`netfilter guard: declared source directory is missing: ${path.relative(repo, d)}`)
    const found = walk(d)
    if (found.length === 0) throw new Error(`netfilter guard: declared source directory is empty: ${path.relative(repo, d)}`)
    files.push(...found)
  }
  for (const f of SOURCE_FILES) {
    const p = path.join(base, f)
    if (!fs.existsSync(p)) throw new Error(`netfilter guard: declared source file is missing: ${path.relative(repo, p)}`)
    files.push(p)
  }
  return files.sort()
}

export function collectAppFiles(repo) {
  return walk(path.join(repo, SHIPPED_APP)).sort()
}

export function computeRecord(repo) {
  const sources = collectSources(repo)
  const appFiles = collectAppFiles(repo)
  const plist = path.join(repo, SHIPPED_APP, 'Contents', 'Info.plist')
  let bundleVersion = null
  if (fs.existsSync(plist)) {
    const m = fs.readFileSync(plist, 'utf8').match(/<key>CFBundleVersion<\/key>\s*<string>([^<]*)<\/string>/)
    bundleVersion = m ? m[1] : null
  }
  return {
    sources: hashFiles(path.join(repo, NETFILTER_DIR), sources),
    sourceFileCount: sources.length,
    app: hashFiles(path.join(repo, SHIPPED_APP), appFiles),
    appFileCount: appFiles.length,
    bundleVersion,
  }
}

export function readRecord(repo) {
  const p = path.join(repo, RECORD)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}
