import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import type { NetworkStatePayload } from '@tapflowio/agent-core'

const execFileAsync = promisify(execFile)
const NETHOOK_DYLIB = join(import.meta.dirname, '..', 'bin', 'libtapflow-nethook.dylib')

/**
 * Take one simulator off the network, or put it back (#607).
 *
 * A simulator has no NIC to switch off — it is host processes sharing the Mac's network stack — so
 * "offline" is assembled from three mechanisms, and the whole point of this class is that they are
 * never applied separately:
 *
 *  1. **the host content filter** (`ios-netfilter`) drops the simulator's flows at the kernel
 *  2. **the injected dylib** tells the app its path is unsatisfied, and cuts the connections it is
 *     already holding
 *  3. **the status bar** stops showing service
 *
 * Each alone produces a false result a tester would sign off on. Layer 1 alone leaves the app
 * believing it is online — measured: traffic dead, `NWPathMonitor` reporting satisfied for the life
 * of the process — and leaves a pooled connection working. Layer 2 alone blocks nothing: faking
 * `nw_path_get_status` does not stop `URLSession`, which reads the kernel's real path. Layer 3 alone
 * is pixels.
 */
export interface SimulatorNetworkOptions {
  /** The container app that owns the system extension. Absent or not installed means layer 1 cannot
   *  be applied, which this class reports rather than works around. */
  filterHostBinary?: string
  /** Where the dylib looks for its per-simulator flag. The host's `/tmp` is visible at the same path
   *  inside every simulator on the Mac, which is why the file name carries the udid. */
  conditionDir?: string
  /** Where the dylib writes what its self-check found. */
  verdictDir?: string
  /** The injected library. Overridable so a test never arms a real simulator. */
  nethookDylib?: string
}

const DEFAULT_HOST_BINARY = '/Applications/TapflowNetFilter.app/Contents/MacOS/TapflowNetFilter'

/** How long the filter host gets. It activates a system extension, which is a few hundred ms when
 *  nothing is wrong and unbounded when a user is being asked to approve something. */
const FILTER_HOST_TIMEOUT_MS = 15_000

/** The simctl calls this needs. Narrower than `SimctlWrapper` so a test can stand in for it. */
interface SimctlForNetwork {
  setStatusBarOffline(udid: string, offline: boolean): Promise<void>
  setSimulatorEnv(udid: string, name: string, value: string): Promise<void>
}

export class SimulatorNetwork {
  private readonly hostBinary: string
  private readonly conditionDir: string
  private readonly verdictDir: string
  private readonly dylib: string
  /** Every simulator currently offline. The filter takes the whole set on each call — it has no
   *  add/remove — so this is the authority for what the rule should say, not a cache of it. */
  private readonly offline = new Set<string>()
  /** Devices whose injection is actually in place. Separates "nothing was delivered" from "delivered,
   *  no app has run under it yet" — two states with different remedies, and a reason each. */
  private readonly armed = new Set<string>()
  /** Serialises the host runs. See `applyFilterRule`. */
  private filterQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly simctl: SimctlForNetwork,
    opts: SimulatorNetworkOptions = {},
  ) {
    this.hostBinary = opts.filterHostBinary ?? DEFAULT_HOST_BINARY
    this.conditionDir = opts.conditionDir ?? '/tmp'
    this.verdictDir = opts.verdictDir ?? '/tmp'
    this.dylib = opts.nethookDylib ?? NETHOOK_DYLIB
  }

  /**
   * Put the injection in place for a device that has just booted.
   *
   * **Clearing comes first, and it is not tidiness.** The condition file and the verdict both outlive
   * the simulator that wrote them — they are on the host, keyed only by udid — so a device that boots
   * into a leftover condition file is offline before anyone asked, and a leftover verdict answers for
   * hooks that belong to a process which no longer exists.
   *
   * The library is armed here and the target app is not, because the target is not known yet. Until
   * `target()` names one the dylib loads into every process in the simulator and hooks none of them,
   * which is its designed default.
   */
  async arm(udid: string): Promise<void> {
    this.offline.delete(udid)
    this.armed.delete(udid)
    this.setCondition(udid, false)
    rmSync(this.verdictPath(udid), { force: true })

    // **The rule is rewritten, not merely forgotten.** Clearing the in-memory set and the condition
    // file used to be the whole of this, which left the one layer that actually stops traffic still
    // naming the device: a simulator toggled offline, shut down and booted again came up with its
    // traffic dead while this class reported it online and steerable, and nothing recovered it short
    // of toggling twice.
    //
    // Unconditional rather than only when this device was in the set, because the set is this
    // process's memory and the rule is the host's. An agent that restarted knows of no offline
    // device, and writing what it knows is what clears a rule left behind by the process before it.
    await this.applyFilterRule()

    // Recorded only after the call returns. A device whose environment could not be set has had
    // nothing delivered, and saying otherwise would report it as merely waiting for an app — a state
    // whose remedy is to launch one, which would never help.
    await this.simctl.setSimulatorEnv(udid, 'DYLD_INSERT_LIBRARIES', this.dylib)
    this.armed.add(udid)
  }

  /**
   * Name the app the hooks may touch.
   *
   * **Must be called before the app is launched.** dyld reads the environment when a process starts,
   * so naming the target afterwards arms the *next* launch and leaves the running one unhooked —
   * reporting `available: true` for an app that would never see a path update.
   *
   * **The previous app's verdict goes with it.** A verdict is one process's report that its own hooks
   * took, and that process has exited by the time a second app is launched. Leaving the file behind
   * answered for the new app on the old one's evidence: `available: true` before the new process had
   * written anything, and — if its hooks fail — for as long as it runs. The gap where `state()`
   * answers `awaiting-app` for a launch already in flight is the correct reading of that moment;
   * inheriting a stale `ok` is not.
   */
  async target(udid: string, bundleId: string): Promise<void> {
    rmSync(this.verdictPath(udid), { force: true })
    await this.simctl.setSimulatorEnv(udid, 'TAPFLOW_TARGET_BUNDLE', bundleId)
  }

  /**
   * **Layer 1 leads in both directions, and the order is measured rather than chosen.**
   *
   * Going offline, the dylib cuts the app's open sockets the moment the flag file appears. If the
   * filter were not already dropping new flows at that instant, the app would simply reconnect —
   * reproduced exactly that way while stepping the layers separately, and the reconnected socket then
   * survived the rest of the session.
   *
   * Coming back, the filter has to stop dropping before the app is told the path is satisfied, or the
   * first thing it does with the good news is fail.
   *
   * The status bar goes last either way: it reports, so it should not claim a state before the state
   * is true.
   */
  async setOffline(udid: string, offline: boolean): Promise<NetworkStatePayload> {
    const was = this.offline.has(udid)
    if (offline) this.offline.add(udid)
    else this.offline.delete(udid)

    const applied = await this.applyFilterRule()
    if (!applied) {
      // The rule did not land, so the device is wherever it already was — **which is not necessarily
      // online.** This used to delete unconditionally and answer `offline: false`, so a device that
      // was already offline came back as online here and from every later `state()` call, with the
      // rule and the condition file still saying otherwise. The comment below was already the
      // argument against it and the code broke it in the other direction.
      //
      // Reporting the request back as if it had taken is how a tester ends up filing bugs against an
      // app that was never offline; reporting it as online when it is offline sends them to file
      // against one that cannot reach anything.
      if (was) this.offline.add(udid)
      else this.offline.delete(udid)
      // **And the restored set is written back**, because the run that failed was not necessarily the
      // only writer. The host reads `this.offline` when it *runs*, not when it was queued — correct,
      // since the set is the authority — so with two toggles in flight an earlier run can already have
      // committed a later one's set. Restoring in memory alone then leaves this device named offline
      // here and absent from the kernel rule: traffic alive, and this class saying it is not, which is
      // the direction the paragraph above calls filing bugs against an app that was never offline.
      //
      // Best-effort by definition — the write that just failed may fail again — and that is still
      // strictly better than not trying, because the alternative is a divergence nothing revisits
      // until the device is rebooted.
      await this.applyFilterRule()
      return { offline: was, available: false, reason: 'not-armed' }
    }

    this.setCondition(udid, offline)
    await this.simctl.setStatusBarOffline(udid, offline)

    return this.state(udid)
  }

  /**
   * What the device is doing and whether tapflow can still steer it.
   *
   * `offline` describes the **device**, not the last request: a simulator taken offline and then left
   * unsteerable is still offline, and saying otherwise would draw "online" over an app that can reach
   * nothing.
   */
  state(udid: string): NetworkStatePayload {
    const offline = this.offline.has(udid)
    const verdict = this.readVerdict(udid)

    // The three answers differ by what the tester has to do, which is what the reason set is for.
    // An absent verdict means two different things and they were reported as one: nothing was
    // delivered (reboot), or it was delivered and no app has exercised it yet (launch one). The
    // second is what every iOS session looks like before its app starts, so folding it into
    // `not-armed` put the wrong remedy on the common case.
    if (verdict === 'missing') {
      return this.armed.has(udid)
        ? { offline, available: false, reason: 'awaiting-app' }
        : { offline, available: false, reason: 'not-armed' }
    }
    if (verdict === 'failed') return { offline, available: false, reason: 'hooks-not-installed' }
    return { offline, available: true }
  }

  /** Called when a device goes away, so a shutdown simulator does not keep a rule alive that names
   *  it — the filter would carry the udid for the rest of the host's uptime. */
  async forget(udid: string): Promise<void> {
    this.armed.delete(udid)
    // Unconditional, for the reason `arm()` gives at length: the set is this process's memory and the
    // rule is the host's. An agent that restarted knows of no offline device, so `delete` answers
    // false and the write was skipped — leaving the udid named in the rule for the rest of the Mac's
    // uptime, which is the exact outcome this method's doc block says it exists to prevent.
    this.offline.delete(udid)
    await this.applyFilterRule()
    this.setCondition(udid, false)
    // **The status bar is part of what has to come back.** It was set by `setOffline` and had no
    // other caller, so a device retired while offline kept showing no service for as long as it
    // stayed booted — a relay disconnect was enough. That is the pixels-only false result this class
    // exists to prevent, pointed the other way.
    //
    // Swallowed, and only here: a device being retired is often already gone, and `status_bar clear`
    // against a shut-down simulator fails. Failing this call would abandon the rest of the cleanup
    // for a layer that only reports.
    await this.simctl.setStatusBarOffline(udid, false).catch(() => { /* device may already be gone */ })
  }

  // ── layer 1 ────────────────────────────────────────────────────────────────

  /**
   * **Serialised, and bounded in time.**
   *
   * The host takes the whole offline set on each run and the last writer wins, so two of these in
   * flight at once decide the rule by which subprocess happens to finish last rather than by which
   * request came last. Two devices toggled in the same second is enough — and the set each one reads
   * is correct, which is what makes the wrong outcome hard to see afterwards: both runs are internally
   * consistent and one of them is stale.
   *
   * The timeout covers a host that never returns. It waits on `OSSystemExtensionRequest`, and one of
   * its outcomes is a System Settings dialog nobody is standing in front of; the binary now exits
   * itself on that path, but a timeout here is what keeps a wedge from taking the queue with it —
   * everything after it is waiting on this chain.
   */
  private async applyFilterRule(): Promise<boolean> {
    const run = this.filterQueue.then(() => this.runFilterHost())
    // Keep the chain alive whatever this run did: a rejection left on it would fail every later call.
    this.filterQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * The container app writes the rule and exits.
   *
   * **Its exit is not the confirmation.** Zero means the container app launched and the framework
   * accepted the save — the whole run is 27ms, measured — and the running provider is handed the new
   * configuration afterwards, with nothing coming back to say it has it. So this answers "nothing
   * refused"; whether the device is actually offline is answered by `state()`, from evidence the
   * dylib wrote inside the simulator.
   */
  private async runFilterHost(): Promise<boolean> {
    if (!existsSync(this.hostBinary)) return false
    try {
      await execFileAsync(this.hostBinary, ['--offline', [...this.offline].join(',')], {
        timeout: FILTER_HOST_TIMEOUT_MS,
      })
      return true
    } catch {
      return false
    }
  }

  // ── layer 2 ────────────────────────────────────────────────────────────────

  private conditionPath(udid: string): string {
    return `${this.conditionDir}/tapflow-offline-${udid}`
  }

  private setCondition(udid: string, offline: boolean): void {
    const path = this.conditionPath(udid)
    if (!offline) {
      rmSync(path, { force: true })
      return
    }
    mkdirSync(this.conditionDir, { recursive: true })
    writeFileSync(path, '')
  }

  /**
   * `missing` and `failed` are different answers and a tester needs both.
   *
   * Missing is not by itself an answer — it is the same file being absent whether the injection was
   * never delivered or is simply waiting for its first app, which is why `state` reads it against
   * `armed` rather than reporting it directly. Failed means the dylib ran and proved by trying that
   * its hooks did not take, which no amount of relaunching will change.
   */
  private verdictPath(udid: string): string {
    return `${this.verdictDir}/tapflow-nethook-${udid}.json`
  }

  private readVerdict(udid: string): 'ok' | 'failed' | 'missing' {
    const path = this.verdictPath(udid)
    if (!existsSync(path)) return 'missing'
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { installed?: unknown }
      return raw.installed === true ? 'ok' : 'failed'
    } catch {
      // A half-written or malformed verdict is not evidence that the hooks took.
      return 'failed'
    }
  }
}
