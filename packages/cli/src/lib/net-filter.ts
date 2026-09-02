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

/** How long a read-only probe of this Mac may take before it is treated as unanswerable. Generous
 *  against a loaded machine, short against `doctor`'s promise to answer. */
const PROBE_TIMEOUT_MS = 10_000

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
      // A read that hangs hangs `tapflow doctor ios` with it, and the command's whole job is to answer
      // quickly about a machine that may be in a bad state. The throw lands in the `catch` below, so a
      // hang reports the same "cannot tell" as a failure — which is what it is.
      timeout: PROBE_TIMEOUT_MS,
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
  return shippedArtifact('TapflowNetFilter.app')
}

/**
 * The injected library — the offline toggle's **second** layer, and the one nothing reported on.
 *
 * It is not a second copy of the filter's problem. The filter is installed onto the Mac and can be
 * absent, stale or unapproved; this one only ever lives inside the package, so it is either there or
 * the install is damaged. What made it worth a check is the failure it produces when it is not:
 * `DYLD_INSERT_LIBRARIES` naming a path that does not exist is **ignored silently** by dyld, the app
 * launches with no hooks, and no verdict is ever written — so the control asks the tester to launch
 * an app through tapflow, forever, while the app they launched is running in front of them.
 */
export function shippedHookPath(): string | null {
  return shippedArtifact('libtapflow-nethook.dylib')
}

function shippedArtifact(name: string): string | null {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require.resolve('@tapflowio/ios-agent/package.json')
    const p = join(dirname(pkg), 'bin', name)
    return existsSync(p) ? p : null
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
    out = execFileSync('/usr/bin/systemextensionsctl', ['list'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT_MS,
    })
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
export function isNewer(candidate: string, than: string): boolean {
  const a = Number(candidate)
  const b = Number(than)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true
  return a > b
}

/**
 * Nothing to install: the app on disk and the extension macOS is running are both this build.
 *
 * Exported because `setup ios` asks before each install and must not ask about one that would do
 * nothing — and a second copy of this comparison in the caller is how the prompt and the installer
 * would come to disagree about whether there was anything to consent to.
 */
export function isNetFilterCurrent(s: NetFilterState): boolean {
  return s.shipped !== null && s.installed === s.shipped && s.activated === s.shipped
}

export function readNetFilterState(): NetFilterState {
  const shipped = shippedAppPath()
  return {
    shipped: shipped ? bundleVersion(shipped) : null,
    installed: bundleVersion(NET_FILTER_APP),
    activated: activatedVersion(),
  }
}

/**
 * Where the provider publishes what it is enforcing, most likely first.
 *
 * Read rather than asked. Asking means running the host binary, and a stale one turns a flag it does
 * not know into a rule write — measured on 2026-09-02, `--confirm` against an older build erased the
 * rule and answered 0. A file read cannot change the Mac.
 */
const FILTER_STATE_FILES = [
  '/Library/Application Support/tapflow/tapflow-netfilter-state.json',
  '/tmp/tapflow-netfilter-state.json',
]

/**
 * Is a provider actually enforcing right now?
 *
 * **Not the question `activatedVersion()` answers, and conflating them is what this exists to stop.**
 * `systemextensionsctl` reports the *system extension*; `NEFilterManager.isEnabled` is a separate
 * preference, and a filter switched off leaves the extension listed `[activated enabled]` exactly as
 * before. So a Mac whose filter was disabled and never turned back on reads as fully current, and
 * `installNetFilter` returned `already-current` without running the step that would restore it —
 * network control dead, `doctor ios` all green, and nothing anywhere saying why.
 *
 * That state is not hypothetical: the disable-before-replace sequence below creates it whenever it is
 * interrupted after `--off` and before `--install`.
 *
 * Stale counts as stopped, on the agent's own rule — three missed pulses, with `pulseSeconds` taken
 * from the file rather than assumed, because the provider slows its pulse while nothing is offline.
 */
export function isFilterEnforcing(now = Date.now()): boolean {
  for (const path of FILTER_STATE_FILES) {
    if (!existsSync(path)) continue
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { at?: unknown; pulseSeconds?: unknown }
      if (typeof raw.at !== 'number') continue
      const pulse = typeof raw.pulseSeconds === 'number' ? raw.pulseSeconds : 5
      // **A stale file is a reason to keep looking, not an answer.** The second path is where the
      // provider writes when it cannot write the first, so a Mac that failed over leaves an old file
      // at the first one and a live heartbeat at the second. Returning here read that Mac as stopped
      // and made every run pay the disable/enable cycle this module exists to make rare.
      if (Math.floor(now / 1000) - raw.at <= 3 * Math.max(pulse, 1)) return true
      continue
    } catch {
      // Unreadable is not "enforcing". Keep looking; the second path is the fallback the provider
      // uses when it cannot write the first.
      continue
    }
  }
  return false
}

/**
 * The oldest host build known to understand `--off`.
 *
 * `--off` arrived on 2026-08-24 (`07a32ff0`) and the first app ever committed is `1787677954`, which
 * is later — so every released build has it, and **what sits below this line is a hand build**.
 *
 * The line matters because a build predating the flag does not refuse it. Every unrecognised argument
 * used to fall through to `.configure`, which writes `isEnabled = true`. So asking such a binary to
 * turn the filter *off* turns it *on*, and exits 0 — and the caller then replaces the extension
 * believing the filter is detached, which is the outage this whole sequence exists to prevent.
 */
const FIRST_SHIPPED_HOST_VERSION = 1787677954

/** Does the build in `/Applications` understand `--off`? Unreadable answers no: the cost of assuming
 *  yes is the outage, and the cost of assuming no is a slower upgrade that says so. */
function understandsOff(installedVersion: string | null): boolean {
  if (installedVersion === null) return false
  const v = Number(installedVersion)
  return Number.isFinite(v) && v >= FIRST_SHIPPED_HOST_VERSION
}

/**
 * What would be interrupted by a replace, in words a person can act on. Empty means nothing would.
 *
 * **All three, because the filter is host-wide.** It is `filterSockets`, so every new flow on the Mac
 * goes through the provider — an Android emulator's traffic included, even though nothing here can
 * take one offline. And a relay serving on :4000 means somebody may be testing through a browser from
 * another machine, which no device list can show.
 *
 * Best-effort by construction: a probe that cannot run reports nothing rather than blocking the
 * install. A missed device costs the interruption this refusal exists to avoid; a probe that throws
 * and stops the upgrade costs an upgrade nobody can perform.
 */
export function busyDevices(): string[] {
  const busy: string[] = []
  for (const name of bootedSimulators()) busy.push(`simulator ${name}`)
  for (const serial of attachedEmulators()) busy.push(`emulator ${serial}`)
  if (relayIsServing()) busy.push('a relay serving on :4000')
  return busy
}

function bootedSimulators(): string[] {
  try {
    const raw = execFileSync('/usr/bin/xcrun', ['simctl', 'list', 'devices', '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROBE_TIMEOUT_MS,
    })
    const data = JSON.parse(raw) as { devices: Record<string, Array<{ name: string; state: string }>> }
    return Object.values(data.devices).flat().filter((d) => d.state === 'Booted').map((d) => d.name)
  } catch {
    return []
  }
}

function attachedEmulators(): string[] {
  try {
    // From `PATH`, unlike the absolute paths above: `adb` ships with the Android SDK and has no fixed
    // location. Absent is the common case on an iOS-only Mac and lands in the `catch`.
    const raw = execFileSync('adb', ['devices'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROBE_TIMEOUT_MS,
    })
    return raw.split('\n').slice(1)
      .map((l) => l.trim()).filter((l) => l.endsWith('device'))
      .map((l) => l.split(/\s+/)[0]).filter(Boolean)
  } catch {
    return []
  }
}

function relayIsServing(): boolean {
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', '-iTCP:4000', '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROBE_TIMEOUT_MS,
    })
    return out.trim().length > 0
  } catch {
    // `lsof` exits non-zero when nothing holds the port, which is the common case and not an error.
    return false
  }
}

export interface InstallOptions {
  /** Replace even though devices are in use. The refusal exists because a replace interrupts every
   *  new connection on the Mac; this is the caller saying they know and want it anyway. */
  ignoreRunningDevices?: boolean
}

export type InstallOutcome =
  | { status: 'installed'; disabledFirst: boolean }
  | { status: 'already-current' }
  | { status: 'needs-approval'; filterLeftDisabled: boolean }
  | { status: 'needs-reboot' }
  | { status: 'not-macos' }
  | { status: 'no-artifact' }
  | { status: 'refused-downgrade'; installed: string; shipped: string }
  | { status: 'refused-devices-busy'; busy: string[] }
  | { status: 'failed'; code: number; detail: string; filterLeftDisabled: boolean }

/** What the host binary's exit codes mean. The table lives in `ios-netfilter/README.md`; these are the
 *  three that are not failures. */
const EXIT_APPROVAL_TIMEOUT = 4
const EXIT_NEEDS_REBOOT = 5

/** How long `--off` gets. It is one `NEFilterManager` save and was measured at 31ms; this is a bound
 *  on a wedged run, not a budget. */
const OFF_TIMEOUT_MS = 15_000

/** How long the copy gets. `ditto` moves a few megabytes off local disk, so this bounds a wedged run
 *  rather than a slow one — and after the disable above, a copy that never returns is what leaves the
 *  filter off with nothing said. */
const COPY_TIMEOUT_MS = 60_000

/** How long `--install` gets. Generous because it can be waiting on a macOS approval dialog — the
 *  host has its own approval and stall deadlines (exit 4 and 6) and this is only the backstop for a
 *  run that reaches neither. Without it the CLI waits forever on a completion handler that never
 *  fires, which is how an interrupted sequence leaves the filter off. */
const INSTALL_TIMEOUT_MS = 180_000

/**
 * Put the shipped app in `/Applications` and activate it. **The one routine both `setup ios` and
 * `migrate net-filter` call** — they exist for different people (first run vs an upgrade that
 * introduced the feature) and must not drift into two answers for one question.
 *
 * No `sudo`: `/Applications` is writable by an admin user, and `ditto` preserves the signature, which
 * a plain copy does not. Measured.
 */
export function installNetFilter(opts: InstallOptions = {}): InstallOutcome {
  if (process.platform !== 'darwin') return { status: 'not-macos' }
  const shipped = shippedAppPath()
  if (!shipped) return { status: 'no-artifact' }

  const shippedVersion = bundleVersion(shipped)
  const installedVersion = bundleVersion(NET_FILTER_APP)
  const activated = activatedVersion()
  // **An unreadable version refuses too.** Under `if (shippedVersion)` the whole guard below was
  // skipped whenever the shipped app would not say what it was, so the one artifact no comparison can
  // judge was the one that installed unconditionally — over a newer filter that was working.
  if (!shippedVersion) return { status: 'no-artifact' }
  // **Current *and* running.** The version check alone answers a different question than the one the
  // caller is asking, and the gap between them is a state this function creates: interrupt the
  // sequence below between `--off` and `--install` and the Mac has the right app, the right activated
  // extension, and no filter. Returning `already-current` there makes the condition permanent, because
  // the only thing that would turn it back on is the run that just declined to do anything.
  if (isNetFilterCurrent({ shipped: shippedVersion, installed: installedVersion, activated })
      && isFilterEnforcing()) {
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

  // **Refused rather than forced, and it belongs here rather than in either command.** Both `setup
  // ios` and `migrate net-filter` reach this function, so a gate on one of them protects half the
  // callers — and the destructive part is here, not there.
  //
  // Refusing rather than shutting the devices down is the other half of the decision. `/Applications`
  // holds one filter for the whole Mac, which is already this module's reason for the downgrade
  // guard: the people affected by a replace are not necessarily the person running the command.
  const busy = opts.ignoreRunningDevices ? [] : busyDevices()
  if (busy.length > 0) return { status: 'refused-devices-busy', busy }

  // **Take the filter out of the flow path before replacing what enforces it.**
  //
  // A content filter is `filterSockets`, so every new flow on the Mac waits for a verdict from the
  // provider. Replacing the extension kills that provider while the configuration stays enabled, and
  // new connections then wait for a verdict nobody will give: measured 2026-09-02, the Mac's own
  // traffic timed out and only a restart brought it back.
  //
  // Disabling first means the dangerous state — an established filter whose provider is gone — never
  // exists. What is left is the window while the filter comes back up, and that one was measured on
  // the same day across ~300 probes: about four seconds of raised latency (10-30ms to 200-400ms) and
  // **no failures**, because the kernel passes traffic a provider has not applied settings for yet.
  //
  // `--install` turns it back on by itself: with no `--add`/`--remove` it takes `clearAll`, and
  // `configureFilter` ends with `isEnabled = true`. So there is no re-enable step to forget.
  const disabledFirst = understandsOff(installedVersion)
  if (disabledFirst) {
    const off = spawnSync(join(NET_FILTER_APP, 'Contents', 'MacOS', 'TapflowNetFilter'), ['--off'], {
      encoding: 'utf8', timeout: OFF_TIMEOUT_MS,
    })
    // **Stop rather than continue.** A disable that did not take leaves the filter enabled, which is
    // exactly the state the replace must not meet. Nothing has been changed yet at this point, so
    // stopping costs an upgrade and continuing costs the Mac's network.
    if (!off || off.status !== 0) {
      return {
        status: 'failed',
        code: off?.status ?? -1,
        detail: hostLogTail() || (off?.stderr || '').trim()
          || 'could not switch the filter off before replacing it',
        filterLeftDisabled: false,
      }
    }
  }

  const copy = spawnSync('/usr/bin/ditto', [shipped, NET_FILTER_APP], {
    encoding: 'utf8', timeout: COPY_TIMEOUT_MS,
  })
  if (!copy || copy.status !== 0) {
    return {
      status: 'failed',
      code: copy?.status ?? -1,
      detail: (copy?.stderr || 'ditto failed').trim(),
      filterLeftDisabled: disabledFirst,
    }
  }

  restoreExecutableBits(NET_FILTER_APP)

  const run = spawnSync(join(NET_FILTER_APP, 'Contents', 'MacOS', 'TapflowNetFilter'), ['--install'], {
    encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS,
  })
  if (!run) {
    return { status: 'failed', code: -1, detail: 'the filter host did not run', filterLeftDisabled: disabledFirst }
  }
  switch (run.status) {
    case 0: return { status: 'installed', disabledFirst }
    // **Approval and reboot differ in whether the filter came back**, which is why only one of them
    // carries the flag. The approval path dies before `configureFilter` runs, so the filter is still
    // off; the reboot path runs it — deliberately, since this binary is the only way a device is put
    // back online — so the filter is on and the *old* provider is enforcing until the restart.
    case EXIT_APPROVAL_TIMEOUT: return { status: 'needs-approval', filterLeftDisabled: disabledFirst }
    case EXIT_NEEDS_REBOOT: return { status: 'needs-reboot' }
    default:
      return {
        status: 'failed',
        code: run.status ?? -1,
        detail: hostLogTail() || (run.stderr || '').trim() || `exit ${run.status}`,
        filterLeftDisabled: disabledFirst,
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
