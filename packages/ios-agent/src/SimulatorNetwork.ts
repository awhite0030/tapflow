import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { promisify } from 'util'
import type { NetworkStatePayload } from '@tapflowio/agent-core'

const execFileAsync = promisify(execFile)

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
}

const DEFAULT_HOST_BINARY = '/Applications/TapflowNetFilter.app/Contents/MacOS/TapflowNetFilter'

interface StatusBarSetter {
  setStatusBarOffline(udid: string, offline: boolean): Promise<void>
}

export class SimulatorNetwork {
  private readonly hostBinary: string
  private readonly conditionDir: string
  private readonly verdictDir: string
  /** Every simulator currently offline. The filter takes the whole set on each call — it has no
   *  add/remove — so this is the authority for what the rule should say, not a cache of it. */
  private readonly offline = new Set<string>()

  constructor(
    private readonly simctl: StatusBarSetter,
    opts: SimulatorNetworkOptions = {},
  ) {
    this.hostBinary = opts.filterHostBinary ?? DEFAULT_HOST_BINARY
    this.conditionDir = opts.conditionDir ?? '/tmp'
    this.verdictDir = opts.verdictDir ?? '/tmp'
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
    if (offline) this.offline.add(udid)
    else this.offline.delete(udid)

    const applied = await this.applyFilterRule()
    if (!applied) {
      // The rule did not land, so the device's traffic is whatever it already was. Reporting the
      // request back as if it had taken is how a tester ends up filing bugs against an app that was
      // never offline.
      this.offline.delete(udid)
      return { offline: false, available: false, reason: 'not-armed' }
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

    if (verdict === 'missing') return { offline, available: false, reason: 'not-armed' }
    if (verdict === 'failed') return { offline, available: false, reason: 'hooks-not-installed' }
    return { offline, available: true }
  }

  /** Called when a device goes away, so a shutdown simulator does not keep a rule alive that names
   *  it — the filter would carry the udid for the rest of the host's uptime. */
  async forget(udid: string): Promise<void> {
    if (!this.offline.delete(udid)) {
      this.setCondition(udid, false)
      return
    }
    await this.applyFilterRule()
    this.setCondition(udid, false)
  }

  // ── layer 1 ────────────────────────────────────────────────────────────────

  /**
   * The container app writes the rule and exits.
   *
   * **Its exit is not the confirmation.** The process returns before the save completes — measured at
   * 0.05s against 0.08s for the rule actually landing — so the exit code says the launch worked and
   * nothing more. What this checks is that it launched at all; whether the rule took is answered by
   * `state()`, from evidence the dylib wrote.
   */
  private async applyFilterRule(): Promise<boolean> {
    if (!existsSync(this.hostBinary)) return false
    try {
      await execFileAsync(this.hostBinary, ['--offline', [...this.offline].join(',')])
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
   * Missing means no app has run under the injection on this device — the fix is to launch one, or to
   * reboot so the boot re-arms it. Failed means the dylib ran and proved by trying that its hooks did
   * not take, which no amount of relaunching will change.
   */
  private readVerdict(udid: string): 'ok' | 'failed' | 'missing' {
    const path = `${this.verdictDir}/tapflow-nethook-${udid}.json`
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
