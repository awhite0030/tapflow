import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * The iOS network filter — the one layer of the offline toggle that lives on the Mac rather than in
 * the simulator, and the only one a user has to install.
 *
 * **Three versions, not two, and the third is the one that matters.** The app the package ships, the
 * app in `/Applications`, and the extension macOS has *activated*. A design review found this the
 * hard way: on the ordinary upgrade path `--install` answers exit 5 (needs a reboot), which leaves
 * the first two matching while the kernel goes on running the old provider — so a check that compares
 * the files reports everything healthy while the dashboard says the Mac is not set up. The agent
 * confirms enforcement over XPC, and an older extension has no listener to answer it.
 *
 * So this module reads the activated version, and everything that installs goes through one routine
 * (`installNetFilter`) rather than being written twice.
 */

/** Where macOS expects the container app. Anywhere else and activation answers `code=3`. */
export const NET_FILTER_APP = '/Applications/TapflowNetFilter.app'
const EXT_BUNDLE_ID = 'dev.tapflow.netfilter.ext'

export interface NetFilterState {
  /** The version this CLI's `@tapflowio/ios-agent` carries, or null when the package has no app. */
  shipped: string | null
  /** The version in `/Applications`, or null when nothing is installed there. */
  installed: string | null
  /** The version macOS reports as `[activated enabled]`, or null when none is. */
  activated: string | null
}

/** Read `CFBundleVersion` from an app bundle. `null` for absent or unreadable — a bundle that cannot
 *  be read is not a version, and guessing one here would be the claim this whole feature avoids. */
export function bundleVersion(appPath: string): string | null {
  const plist = join(appPath, 'Contents', 'Info.plist')
  if (!existsSync(plist)) return null
  try {
    const out = execFileSync('/usr/bin/defaults', ['read', plist, 'CFBundleVersion'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() || null
  } catch {
    return null
  }
}

/**
 * The app this CLI would install, found through the agent package rather than a relative path.
 *
 * `createRequire` resolution rather than `join(import.meta.dirname, '../..')`: the CLI is installed
 * as a dependency, run from a pnpm store with its own layout, and executed from a bin shim — the only
 * thing that holds across those is asking node where the package is.
 *
 * It resolves the **manifest**, which is why `@tapflowio/ios-agent` exports `./package.json`. Without
 * that entry the map's `.` is the only path out of the package and node answers
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`; resolving the main entry and walking up a directory would work
 * today and encode where the entry happens to sit.
 */
export function shippedAppPath(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require.resolve('@tapflowio/ios-agent/package.json')
    const app = join(dirname(pkg), 'bin', 'TapflowNetFilter.app')
    return existsSync(app) ? app : null
  } catch {
    return null
  }
}

/**
 * What macOS has *activated*, from `systemextensionsctl list`.
 *
 * The line looks like `*   *   TEAMID   dev.tapflow.netfilter.ext (1.0/1787585990)   name  [activated enabled]`.
 * Only a line that is both activated **and** enabled counts; a replaced extension sits in that list
 * as `terminated waiting to uninstall on reboot` and is exactly the state this exists to catch.
 */
export function activatedVersion(): string | null {
  // `execFileSync`, not `spawnSync`, and the distinction is this codebase's: reads go through the exec
  // family and `spawnSync` is what changes the machine. A setup run on a fully configured Mac asserts
  // that nothing was spawned, and asking macOS what it has activated must not break that.
  let out: string
  try {
    out = execFileSync('/usr/bin/systemextensionsctl', ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
  // Absent output is "cannot tell", which is what `null` means here — inventing a version would be
  // the claim this whole module exists to avoid.
  if (!out) return null
  for (const line of out.split('\n')) {
    if (!line.includes(EXT_BUNDLE_ID)) continue
    if (!line.includes('[activated enabled]')) continue
    const m = line.match(/\(([^)]*)\)/)
    if (!m) continue
    // `1.0/1787585990` — short version before the slash, build version after. The build version is
    // what `build.sh` makes unique per build, so it is the one that identifies a binary.
    //
    // **No slash means we cannot tell which half we are looking at**, and answering with the short
    // version puts an uncomparable `1.0` into a comparison against an epoch. That produced advice with
    // no exit: doctor says the versions differ, migrate installs, macOS skips the replace because the
    // bundle version did not change, and doctor says the same thing again.
    const parts = m[1].split('/')
    if (parts.length < 2) return null
    return parts[1].trim() || null
  }
  return null
}

/**
 * Is `candidate` a later build than `than`?
 *
 * **Anything that does not parse answers yes**, so an unreadable version refuses the install rather
 * than performing it. `Number('a') > Number('b')` is a NaN comparison and therefore `false`, which
 * would have made the downgrade guard fail *open* the day these stop being epoch seconds — the one
 * direction a guard must never fail in.
 */
function isNewer(candidate: string, than: string): boolean {
  const a = Number(candidate)
  const b = Number(than)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true
  return a > b
}

export function readNetFilterState(): NetFilterState {
  const shipped = shippedAppPath()
  return {
    shipped: shipped ? bundleVersion(shipped) : null,
    installed: bundleVersion(NET_FILTER_APP),
    activated: activatedVersion(),
  }
}

export type InstallOutcome =
  | { status: 'installed' }
  | { status: 'already-current' }
  | { status: 'needs-approval' }
  | { status: 'needs-reboot' }
  | { status: 'not-macos' }
  | { status: 'no-artifact' }
  | { status: 'refused-downgrade'; installed: string; shipped: string }
  | { status: 'failed'; code: number; detail: string }

/** What the host binary's exit codes mean. The table lives in `ios-netfilter/README.md`; these are the
 *  three that are not failures. */
const EXIT_APPROVAL_TIMEOUT = 4
const EXIT_NEEDS_REBOOT = 5

/**
 * Put the shipped app in `/Applications` and activate it. **The one routine both `setup ios` and
 * `migrate net-filter` call** — they exist for different people (first run vs an upgrade that
 * introduced the feature) and must not drift into two answers for one question.
 *
 * No `sudo`: `/Applications` is writable by an admin user, and `ditto` preserves the signature, which
 * a plain copy does not. Measured.
 */
export function installNetFilter(): InstallOutcome {
  if (process.platform !== 'darwin') return { status: 'not-macos' }
  const shipped = shippedAppPath()
  if (!shipped) return { status: 'no-artifact' }

  const shippedVersion = bundleVersion(shipped)
  const installedVersion = bundleVersion(NET_FILTER_APP)
  const activated = activatedVersion()
  if (shippedVersion) {
    if (installedVersion === shippedVersion && activated === shippedVersion) {
      return { status: 'already-current' }
    }
    // **A downgrade is refused rather than performed.** `/Applications` holds one copy for the whole
    // Mac while the version each checkout judges it by comes from its own `node_modules`, so an older
    // checkout running this would replace the app a newer agent depends on and break it.
    //
    // **What is protected is what the Mac is running, not the file on disk.** Reading the app alone
    // left the guard skipped entirely whenever it was absent — and an app deleted from
    // `/Applications` leaves the extension activated and enforcing, which is exactly when an older
    // checkout would walk in and replace it.
    const current = installedVersion ?? activated
    if (current && isNewer(current, shippedVersion)) {
      return { status: 'refused-downgrade', installed: current, shipped: shippedVersion }
    }
  }

  const copy = spawnSync('/usr/bin/ditto', [shipped, NET_FILTER_APP], { encoding: 'utf8' })
  if (!copy || copy.status !== 0) {
    return { status: 'failed', code: copy?.status ?? -1, detail: (copy?.stderr || 'ditto failed').trim() }
  }

  restoreExecutableBits(NET_FILTER_APP)

  const run = spawnSync(join(NET_FILTER_APP, 'Contents', 'MacOS', 'TapflowNetFilter'), ['--install'], {
    encoding: 'utf8',
  })
  if (!run) return { status: 'failed', code: -1, detail: 'the filter host did not run' }
  switch (run.status) {
    case 0: return { status: 'installed' }
    case EXIT_APPROVAL_TIMEOUT: return { status: 'needs-approval' }
    case EXIT_NEEDS_REBOOT: return { status: 'needs-reboot' }
    default:
      return {
        status: 'failed',
        code: run.status ?? -1,
        detail: hostLogTail() || (run.stderr || '').trim() || `exit ${run.status}`,
      }
  }
}

/** The host binary logs its own exit reason; a bare code says which preference failed but not what the
 *  framework said about it. Best-effort — the log is not load-bearing. */
function hostLogTail(): string {
  try {
    const lines = readFileSync('/tmp/tapflow-netfilter-host.log', 'utf8').trim().split('\n')
    return lines.slice(-1)[0] ?? ''
  } catch {
    return ''
  }
}

/**
 * Put the executable bit back on everything under a `Contents/MacOS` inside the bundle.
 *
 * **Measured, not defensive.** A tarball does not have to carry file modes, and pnpm's does not: the
 * app arrives from the registry with its binaries at `rw-r--r--`, and `ditto` faithfully copies that
 * into `/Applications`, where `--install` then fails to execute. The package's `postinstall` chmods
 * `bin/` one level deep, which for a bundle sets the mode of the *directory* and never reaches
 * `Contents/MacOS/` — so the five flat helpers beside it are covered and this is not.
 *
 * Done here rather than only in `postinstall` because that script does not always run: `--ignore-scripts`
 * is a normal thing for a CI install to pass.
 *
 * Changing the mode does not disturb the signature: code signing seals contents, and `codesign
 * --verify --deep --strict` and `stapler validate` both still pass afterwards (measured).
 */
function restoreExecutableBits(appPath: string): void {
  const walk = (dir: string, inMacOS: boolean): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    // A listing that is not a listing — an unreadable directory, or a stubbed `fs` — is nothing to
    // walk. Trusting the shape here turns a missing directory into a TypeError three frames away.
    if (!Array.isArray(entries)) return
    for (const name of entries) {
      const p = join(dir, name)
      let isDir: boolean
      try {
        isDir = statSync(p).isDirectory()
      } catch {
        continue
      }
      if (isDir) walk(p, inMacOS || name === 'MacOS')
      else if (inMacOS) {
        try {
          chmodSync(p, 0o755)
        } catch {
          // Best effort. A file we cannot chmod is one `--install` will report on with a real code.
        }
      }
    }
  }
  walk(appPath, false)
}
