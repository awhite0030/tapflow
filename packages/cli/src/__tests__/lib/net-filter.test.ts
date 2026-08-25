import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process')
vi.mock('node:fs')
vi.mock('node:net')

import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { installNetFilter, readNetFilterState, NET_FILTER_APP } from '../../lib/net-filter.js'
import { runDoctorChecks } from '../../lib/doctor.js'
import { runSetupIos } from '../../lib/setup.js'

const mockExecFileSync = vi.mocked(execFileSync)
const mockSpawnSync = vi.mocked(spawnSync)
const mockExistsSync = vi.mocked(existsSync)
const mockChmodSync = vi.mocked(chmodSync)
const mockReaddirSync = vi.mocked(readdirSync)
const mockStatSync = vi.mocked(statSync)

/** A bundle shaped like the real one: an executable under `Contents/MacOS`, and one more inside the
 *  nested system extension. */
function bundleOnDisk() {
  const tree: Record<string, string[]> = {
    [NET_FILTER_APP]: ['Contents'],
    [`${NET_FILTER_APP}/Contents`]: ['MacOS', 'Library', 'Info.plist'],
    [`${NET_FILTER_APP}/Contents/MacOS`]: ['TapflowNetFilter'],
    [`${NET_FILTER_APP}/Contents/Library`]: ['SystemExtensions'],
    [`${NET_FILTER_APP}/Contents/Library/SystemExtensions`]: ['dev.tapflow.netfilter.ext.systemextension'],
    [`${NET_FILTER_APP}/Contents/Library/SystemExtensions/dev.tapflow.netfilter.ext.systemextension`]: ['Contents'],
    [`${NET_FILTER_APP}/Contents/Library/SystemExtensions/dev.tapflow.netfilter.ext.systemextension/Contents`]: ['MacOS'],
    [`${NET_FILTER_APP}/Contents/Library/SystemExtensions/dev.tapflow.netfilter.ext.systemextension/Contents/MacOS`]: ['dev.tapflow.netfilter.ext'],
  }
  mockReaddirSync.mockImplementation((d) => (tree[String(d)] ?? []) as never)
  mockStatSync.mockImplementation((p) => ({ isDirectory: () => String(p) in tree }) as never)
}
const mockCreateServer = vi.mocked(createServer)

/** `runDoctorChecks` also probes port 4000; that is not this file's subject. */
function portIsFree() {
  mockCreateServer.mockReturnValue({
    once(ev: string, cb: () => void) { if (ev === 'listening') setImmediate(cb); return this },
    listen() { return this },
    close(cb?: () => void) { cb?.(); return this },
  } as never)
}

const netFilterChecks = async () => {
  portIsFree()
  const r = await runDoctorChecks('ios')
  return (r.ios ?? []).filter((c) => c.label.startsWith('Network filter'))
}

const SHIPPED = '1787675754'
const OLDER = '1787500000'
const NEWER = '1787999999'
/** Deliberately shorter. Same-length numeric strings compare identically as strings and as numbers,
 *  so a fixture set that is all the same width cannot tell `Number(a) > Number(b)` from `a > b`. */
const SHORT_BUT_NEWER = '9999999999'

/**
 * **Both the install routine and the doctor's iOS section are gated on `process.platform`, and CI runs
 * on Linux.** Without this every assertion in this file passes on the author's Mac and fourteen of
 * them fail the moment they run anywhere else — which is the only place they were going to run.
 */
function onMac() {
  const real = process.platform
  beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }) })
  afterEach(() => { Object.defineProperty(process, 'platform', { value: real, configurable: true }) })
}

/** What `systemextensionsctl list` prints. The `[activated enabled]` marker is the whole signal — a
 *  replaced extension sits in the same list as `terminated waiting to uninstall on reboot`. */
const listing = (version: string | null, state = '[activated enabled]') =>
  version === null
    ? '1 extension(s)\n--- com.apple.system_extension.network_extension\n'
    : `1 extension(s)\n--- com.apple.system_extension.network_extension\n`
      + `enabled\tactive\tteamID\tbundleID (version)\tname\t[state]\n`
      + `*\t*\t6FBS3QP893\tdev.tapflow.netfilter.ext (1.0/${version})\tdev.tapflow.netfilter.ext\t${state}\n`

/**
 * A Mac in a named state. `shipped` is the version the package carries; pass `null` for "the package
 * has no app at all".
 */
function machine(opts: { shipped?: string | null; installed?: string | null; activated?: string | null; activatedState?: string }) {
  const { shipped = SHIPPED, installed = SHIPPED, activated = SHIPPED, activatedState } = opts
  mockExistsSync.mockImplementation((p) => {
    const s = String(p)
    if (s.startsWith(NET_FILTER_APP)) return installed !== null
    if (s.includes('TapflowNetFilter.app')) return shipped !== null
    // Xcode present, so the doctor's **normal** path runs. Without it every doctor assertion below
    // exercised the no-Xcode early return instead, and the splice on the main path was never reached.
    if (s === '/Applications/Xcode.app') return true
    return false
  })
  mockExecFileSync.mockImplementation((cmd, args) => {
    if (String(cmd).endsWith('/systemextensionsctl')) return listing(activated, activatedState) as never
    if (String(cmd).endsWith('/defaults')) {
      const path = String((args as string[])[1] ?? '')
      const v = path.startsWith(NET_FILTER_APP) ? installed : shipped
      if (v === null) throw new Error('no such plist')
      return `${v}\n` as never
    }
    return '' as never
  })
}

/** The host binary answering `--install`. */
const hostExits = (code: number) => {
  mockSpawnSync.mockImplementation((cmd) => {
    if (String(cmd) === '/usr/bin/ditto') return { status: 0, stdout: '', stderr: '' } as never
    return { status: code, stdout: '', stderr: '' } as never
  })
}

const dittoCalls = () =>
  mockSpawnSync.mock.calls.filter((c) => String(c[0]) === '/usr/bin/ditto')

describe('net filter — reading what the Mac has', () => {
  onMac()
  beforeEach(() => { vi.resetAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('reads the activated version, not the app on disk', () => {
    // **The distinction this module exists for.** On the ordinary upgrade path the two disagree:
    // `--install` answers "needs a reboot" and leaves the new app in /Applications while the kernel
    // keeps running the old provider. Comparing files would call that healthy.
    machine({ installed: SHIPPED, activated: OLDER })
    expect(readNetFilterState()).toEqual({ shipped: SHIPPED, installed: SHIPPED, activated: OLDER })
  })

  it('does not count an extension that is listed but not activated', () => {
    // A replaced extension stays in the list as `terminated waiting to uninstall on reboot`, which is
    // exactly the state a check that only grepped for the bundle id would read as healthy.
    machine({ activated: OLDER, activatedState: '[terminated waiting to uninstall on reboot]' })
    expect(readNetFilterState().activated).toBeNull()
  })

  it('says nothing rather than guessing when the command cannot run', () => {
    machine({})
    mockExecFileSync.mockImplementation((cmd) => {
      if (String(cmd) === 'systemextensionsctl') throw new Error('not found')
      return `${SHIPPED}\n` as never
    })
    expect(readNetFilterState().activated).toBeNull()
  })
})

describe('net filter — installing', () => {
  onMac()
  beforeEach(() => { vi.resetAllMocks(); hostExits(0) })
  afterEach(() => { vi.restoreAllMocks() })

  it('puts the executable bit back on what the tarball flattened', () => {
    // **Measured, not hypothetical.** The app arrives from a pnpm-packed tarball at `rw-r--r--`, and
    // `ditto` copies that faithfully into /Applications, where `--install` cannot then run. The
    // package's `postinstall` chmods `bin/` one level deep, which for a bundle sets the mode of the
    // directory and never reaches `Contents/MacOS`.
    machine({ installed: null, activated: null })
    bundleOnDisk()
    installNetFilter()
    const chmodded = mockChmodSync.mock.calls.map((c) => String(c[0]))
    // **The mode, not only the path.** Asserting the call alone leaves `chmodSync(p, 0o400)` green —
    // which reintroduces exactly the unrunnable binary this function exists to prevent.
    for (const call of mockChmodSync.mock.calls) expect(call[1]).toBe(0o755)
    expect(chmodded).toContain(`${NET_FILTER_APP}/Contents/MacOS/TapflowNetFilter`)
    expect(chmodded, 'the nested system extension is an executable too').toContain(
      `${NET_FILTER_APP}/Contents/Library/SystemExtensions/dev.tapflow.netfilter.ext.systemextension/Contents/MacOS/dev.tapflow.netfilter.ext`,
    )
    expect(chmodded, 'files outside Contents/MacOS are not executables').not.toContain(`${NET_FILTER_APP}/Contents/Info.plist`)
  })

  it('copies and activates when nothing is installed', () => {
    machine({ installed: null, activated: null })
    expect(installNetFilter()).toEqual({ status: 'installed' })
    // The positive control the "does not touch /Applications" assertions below need: this is what the
    // same spy sees when the work does happen.
    expect(dittoCalls()).toHaveLength(1)
    expect(String(dittoCalls()[0][1]?.[1])).toBe(NET_FILTER_APP)
  })

  it('does nothing when the activated version is already the shipped one', () => {
    machine({})
    expect(installNetFilter()).toEqual({ status: 'already-current' })
    expect(dittoCalls(), 'it reinstalled something that was already current').toHaveLength(0)
  })

  it('installs when the files match but the activated version is behind', () => {
    // The reboot-pending Mac. Files agree, so a file comparison would skip the work; the kernel is
    // still running the old provider and the dashboard still says the Mac is not set up.
    machine({ installed: SHIPPED, activated: OLDER })
    expect(installNetFilter()).toEqual({ status: 'installed' })
    expect(dittoCalls()).toHaveLength(1)
  })

  it('compares versions as numbers, not as strings', () => {
    // `'9999999999' > '1787675754'` is true either way; a *shorter* newer version is what separates
    // them. Every other fixture here is the same width, so without this a string comparison passes.
    machine({ installed: SHORT_BUT_NEWER, activated: SHORT_BUT_NEWER })
    expect(installNetFilter()).toMatchObject({ status: 'refused-downgrade' })

    machine({ shipped: SHORT_BUT_NEWER, installed: OLDER, activated: OLDER })
    expect(installNetFilter(), 'a genuinely newer package was refused').toMatchObject({ status: 'installed' })
  })

  it('protects what the Mac is running even when the app is gone from /Applications', () => {
    // macOS keeps an activated extension when its container app is deleted. Reading the app alone
    // skipped the guard entirely there, and an older checkout would walk in and replace a filter that
    // was working.
    machine({ installed: null, activated: NEWER })
    expect(installNetFilter()).toMatchObject({ status: 'refused-downgrade', installed: NEWER })
    expect(dittoCalls()).toHaveLength(0)
  })

  it('refuses to replace a newer filter, and does not touch /Applications', () => {
    // `/Applications` holds one copy for the whole Mac while each checkout judges it by its own
    // node_modules — so an older checkout running this would break the newer agent.
    machine({ installed: NEWER, activated: NEWER })
    expect(installNetFilter()).toEqual({ status: 'refused-downgrade', installed: NEWER, shipped: SHIPPED })
    expect(dittoCalls()).toHaveLength(0)
  })

  it('reports a package with no filter app, and does not touch /Applications', () => {
    machine({ shipped: null, installed: null, activated: null })
    expect(installNetFilter()).toEqual({ status: 'no-artifact' })
    expect(dittoCalls()).toHaveLength(0)
  })

  it('separates approval and reboot from failure', () => {
    for (const [code, status] of [[4, 'needs-approval'], [5, 'needs-reboot']] as const) {
      vi.resetAllMocks()
      machine({ installed: null, activated: null })
      hostExits(code)
      expect(installNetFilter(), `exit ${code}`).toEqual({ status })
    }
  })

  it('reports every other exit code as a failure, carrying the code', () => {
    for (const code of [1, 2, 3, 6, 7]) {
      vi.resetAllMocks()
      machine({ installed: null, activated: null })
      hostExits(code)
      expect(installNetFilter(), `exit ${code}`).toMatchObject({ status: 'failed', code })
    }
  })
})

describe('doctor — what it says about the filter', () => {
  onMac()
  beforeEach(() => { vi.resetAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('warns rather than fails when nothing is installed, and names both commands', async () => {
    // `warn`, not `fail`: a session works without the filter. Only iOS network control does not.
    machine({ installed: null, activated: null })
    const [check, ...rest] = await netFilterChecks()
    expect(rest).toHaveLength(0)
    expect(check).toMatchObject({ ok: false, warn: true })
    expect(check.detail).toMatch(/setup ios/)
    expect(check.detail, 'an existing install never runs setup again').toMatch(/migrate net-filter/)
  })

  it('says it is installed but unapproved, and where to approve it', async () => {
    machine({ activated: null })
    const [check] = await netFilterChecks()
    expect(check).toMatchObject({ ok: false, warn: true })
    expect(check.detail).toMatch(/System Settings/)
  })

  it('asks for a restart when the files agree and the running one does not', async () => {
    // The state a file comparison calls healthy, and the reason the version check reads
    // `systemextensionsctl` instead.
    machine({ installed: SHIPPED, activated: OLDER })
    const [, version] = await netFilterChecks()
    expect(version).toMatchObject({ label: 'Network filter version', ok: false, warn: true })
    expect(version.detail).toMatch(/[Rr]estart/)
  })

  it('sends an out-of-date Mac to migrate', async () => {
    machine({ installed: OLDER, activated: OLDER })
    const [, version] = await netFilterChecks()
    expect(version.detail).toMatch(/migrate net-filter/)
  })

  it('tells a stale checkout to upgrade itself rather than reinstall the filter', async () => {
    // One Mac, several tapflows. Reinstalling here would downgrade the filter the newer agent needs.
    machine({ installed: NEWER, activated: NEWER })
    const [, version] = await netFilterChecks()
    expect(version.detail).toMatch(/newer tapflow/)
  })

  it('is quiet when the running filter is the one this tapflow carries', async () => {
    // The positive control. Without it every assertion above passes on a build that always warns.
    machine({})
    expect(await netFilterChecks()).toEqual([
      { label: 'Network filter', ok: true },
      { label: 'Network filter version', ok: true },
    ])
  })
})

describe('setup and migrate share one install', () => {
  beforeEach(() => { vi.resetAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('marks the step skipped on a host that cannot have it', async () => {
    // **Asserted as a present marker, not as an absence.** "It skips and says so" passes on a build
    // where the step was never written; a step that exists and reports itself skipped cannot.
    const real = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      machine({})
      mockExecSyncForIos()
      const step = (await runSetupIos()).find((r) => r.label === 'Network filter')
      expect(step, 'the step is missing entirely, so nothing reported the skip').toBeDefined()
      expect(step).toMatchObject({ ok: true, warn: true })
      expect(step?.detail).toMatch(/macOS only/)
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true })
    }
  })

  it('keeps the install in one place — neither command spawns anything itself', async () => {
    // The real `fs`: this reads the sources under test, and the mocked one returns nothing at all —
    // which would make every assertion below pass on an empty string.
    const { readFileSync: realRead } = await vi.importActual<typeof import('node:fs')>('node:fs')
    // The drift guard. The compiler already forces both surfaces to handle every `InstallOutcome`
    // member, because neither switch has a default; what it cannot see is one of them growing its own
    // copy of the copy-and-activate. `cmdMigrateDataDir` set the precedent: commands present, `lib/`
    // decides.
    const here = new URL('.', import.meta.url).pathname
    for (const file of ['setup.ts', 'migrate.ts']) {
      const src = realRead(join(here, '..', '..', 'commands', file), 'utf8')
      expect(src, `${file} runs its own process`).not.toMatch(/spawnSync|execFileSync|ditto/)
    }
    const lib = realRead(join(here, '..', '..', 'lib', 'net-filter.ts'), 'utf8')
    expect(lib, 'the shared routine no longer copies anything').toMatch(/ditto/)
  })
})

/** iOS setup also probes brew/Xcode/simctl; none of that is this file's subject. */
function mockExecSyncForIos() {
  vi.mocked(execSync).mockImplementation((cmd) => {
    const c = String(cmd)
    if (c === 'which brew') return '/opt/homebrew/bin/brew\n' as never
    if (c === 'xcode-select -p') return '/Applications/Xcode.app/Contents/Developer\n' as never
    if (c === 'xcodebuild -version') return 'Xcode 26.5\n' as never
    if (c.includes('simctl list devices')) return JSON.stringify({ devices: { 'iOS-18': [{ udid: 'A', name: 'iPhone', state: 'Booted' }] } }) as never
    return '' as never
  })
}
