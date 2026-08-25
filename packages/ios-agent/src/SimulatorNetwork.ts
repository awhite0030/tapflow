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
  /** Where the provider's state file may be, most likely first. Overridable so a test can point at a
   *  file it writes rather than at whatever the Mac's real filter is doing. */
  filterStateFiles?: string[]
  /** Called when a device that was offline stops being enforced. The agent turns this into an
   *  unsolicited `network:state`; nothing here knows about the wire. */
  onEnforcementLost?: (udid: string) => void
  /** How often liveness is checked. Overridable so a test does not have to spend seconds of wall
   *  clock proving that a stale file is noticed; the threshold itself comes from the file. */
  livenessIntervalMs?: number
}

const DEFAULT_HOST_BINARY = '/Applications/TapflowNetFilter.app/Contents/MacOS/TapflowNetFilter'

/** How long the filter host gets. It activates a system extension, which is a few hundred ms when
 *  nothing is wrong and unbounded when a user is being asked to approve something. */
const FILTER_HOST_TIMEOUT_MS = 15_000

/**
 * How long a confirmation gets. **This is the mechanism, not a backstop.**
 *
 * A confirmation made while the provider is dead does not fail — it *blocks*. Measured 3/3: the call
 * ran to the caller's own deadline with neither the invalidation nor the interruption handler firing,
 * because launchd holds the mach name while the process is away. So this number is what decides
 * `filter-unavailable` in the commonest failure there is, and the window it has to decide inside is
 * not rare: a provider killed and restarted by launchd is gone for about 5.8 seconds (measured; one
 * run in five took 21.3).
 *
 * One second: about thirty times the measured worst case of a healthy round trip (host binary launch
 * 34ms, XPC 0.26–0.74ms, propagation under 55ms), and an eighth of the dashboard's 8s request
 * deadline, so a refusal arrives as a refusal rather than as a request that timed out.
 *
 * It is also how long the operation queue is held when things go wrong, which is the cost side: a
 * second device's toggle waits behind it. That is accepted rather than overlooked, and the
 * alternative was tried and reviewed out — confirming outside the queue lets the write and its
 * confirmation belong to different rules, which produced two ways of applying layers 2 and 3 over a
 * kernel that was not enforcing. `serialize` has the sequences.
 */
const FILTER_CONFIRM_TIMEOUT_MS = 1_000

/** Where the provider writes what it is enforcing. Both are tried: the first is where it lands on a
 *  healthy Mac, the second is the fallback it uses when that directory cannot be written. */
const FILTER_STATE_FILES = [
  '/Library/Application Support/tapflow/tapflow-netfilter-state.json',
  '/tmp/tapflow-netfilter-state.json',
]

/** How often liveness is checked while anything is offline. Matches the provider's fast pulse — it
 *  writes every second while its rule is non-empty — so a stopped heartbeat is noticed in about the
 *  time it takes for three of them to go missing. */
const LIVENESS_INTERVAL_MS = 1_000

/** What the provider pulses at **while it is enforcing something** (`Provider.swift`, `pulseSeconds`).
 *  Held here as well because a file written before the rule changed declares the *idle* rate, so the
 *  rate to expect next cannot always be read out of the file. Change one and change the other. */
const ENFORCING_PULSE_SECONDS = 1

/** What the provider's state file says. `pulseSeconds` is read rather than assumed: the provider
 *  changes its own rate (1s while enforcing, 5s idle) and publishes the one in force, so a threshold
 *  derived from this stays right when that changes. */
interface FilterStateFile {
  at: number
  pulseSeconds: number
  rule: string[]
}

/**
 * What layer 1 was last found to be doing for a device, when it was not simply working.
 *
 * Absent is the healthy case. The two members exist because `state()` is synchronous — every
 * re-join, every `device:ready`, every MCP `networkState()` goes through it, and none of them can
 * make an XPC call. Without remembering, one re-join would repaint a device that cannot be steered
 * as a healthy one, and the toast a tester was shown would be the only trace left of it.
 */
type FilterVerdict = 'unavailable' | 'lost'

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
  /** Serialises **whole operations**, not just the host run. See `serialize`. */
  private filterQueue: Promise<unknown> = Promise.resolve()
  /** Set while a liveness check is queued, so a slow toggle does not let ticks pile up behind it. */
  private livenessQueued = false
  /** What layer 1 was last found doing, per device. See `FilterVerdict` for why it is remembered. */
  private readonly filterVerdict = new Map<string, FilterVerdict>()
  /** When each device's offline rule was confirmed, in whole seconds. Read by `checkLiveness` to tell
   *  a file that disagrees from one that is simply older than the write. */
  private readonly offlineSince = new Map<string, number>()
  /** Runs only while something is offline. See `updateLiveness`. */
  private liveness: ReturnType<typeof setInterval> | undefined
  /** Set by `dispose`. Without it, work that was already in flight puts the interval back: both
   *  `setOffline` and `checkLiveness` call `updateLiveness()` *after* their awaits, so a dispose
   *  landing in between was undone by whichever of them resumed next.
   *
   *  **No test reaches this flag, and one that appeared to was deleted rather than kept.** The
   *  scenario it needs — a dispose landing mid-operation, then a state file that makes the watcher
   *  report on its next tick — did not report even with the flag removed *and* `clearInterval` taken
   *  out of `dispose`, so the assertion was green against every mutation of the thing it named.
   *  Observing the watcher stop needs a seam this class does not have (#664). The flag stays because
   *  it is correct and costs one comparison; what it does not have is coverage, and saying so here is
   *  cheaper than a test that says otherwise. */
  private disposed = false
  private readonly stateFiles: string[]
  private enforcementLost: (udid: string) => void
  private readonly livenessIntervalMs: number

  constructor(
    private readonly simctl: SimctlForNetwork,
    opts: SimulatorNetworkOptions = {},
  ) {
    this.hostBinary = opts.filterHostBinary ?? DEFAULT_HOST_BINARY
    this.conditionDir = opts.conditionDir ?? '/tmp'
    this.verdictDir = opts.verdictDir ?? '/tmp'
    this.dylib = opts.nethookDylib ?? NETHOOK_DYLIB
    this.stateFiles = opts.filterStateFiles ?? FILTER_STATE_FILES
    this.enforcementLost = opts.onEnforcementLost ?? (() => { /* nobody listening */ })
    this.livenessIntervalMs = opts.livenessIntervalMs ?? LIVENESS_INTERVAL_MS
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
    return this.serialize(() => this.armLocked(udid))
  }

  private async armLocked(udid: string): Promise<void> {
    this.offline.delete(udid)
    this.armed.delete(udid)
    // **Layer 1's remembered judgment goes too, and leaving it out was a defect two reviewers found
    // independently.** `state()` reads it before every other piece of evidence, and nothing else ever
    // clears it: a `'lost'` set by `checkLiveness` survives the provider coming back, because the
    // device has left `this.offline` and liveness never looks at it again. So a simulator whose
    // enforcement was lost, then rebooted, answered `enforcement-lost` from `device:ready` and from
    // every re-join afterwards — and the dashboard interrupts on that reason rather than re-colouring,
    // so a new tester was told to re-check work belonging to a session that had already ended.
    //
    // This block's own doc says a leftover verdict answers for a process that no longer exists. That
    // was true of the dylib's file and not of this, which is exactly how it was missed.
    this.filterVerdict.delete(udid)
    this.offlineSince.delete(udid)
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
    await this.runFilterHost()
    // Arm can empty the offline set, and the watcher has to stop with it or tick forever on nothing.
    this.updateLiveness()

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
    return this.serialize(() => this.setOfflineLocked(udid, offline))
  }

  /** The body of `setOffline`, running with the queue held. Calls `runFilterHost` directly: going
   *  through `serialize` again from in here would wait on a slot this call already owns. */
  private async setOfflineLocked(udid: string, offline: boolean): Promise<NetworkStatePayload> {
    const was = this.offline.has(udid)
    if (offline) this.offline.add(udid)
    else this.offline.delete(udid)

    const enforced = await this.applyAndConfirm(udid, offline)
    if (!enforced) {
      // **Layer 1 is not enforcing, so layers 2 and 3 do not get applied.** Two of the three work
      // without it and neither blocks traffic: the app would be told its path is unsatisfied and its
      // sockets would be cut, while every request it makes afterwards succeeds. That is a tester
      // signing off offline behaviour they never saw — the exact failure this feature exists to
      // prevent, produced by the feature itself.
      //
      // **Both directions, including coming back online.** A draft carried the online request out
      // anyway, reasoning that a device nothing is enforcing is reachable already and refusing would
      // strand an app believing it is offline. That reasoning was wrong and a test caught it: not
      // being able to *change* the rule is not the same as nothing enforcing it. The provider is a
      // separate process holding the rule it was last given, so a container app that cannot run
      // leaves a device exactly as offline as it was — and taking layers 2 and 3 down there would tell
      // the app it is online while the kernel goes on dropping its traffic.
      //
      // Enforcement that has genuinely stopped is a different signal with a different remedy, and it
      // has one: `checkLiveness` takes the layers down and reports `enforcement-lost`.
      //
      // The device is wherever it already was — **which is not necessarily online.** This used to
      // delete unconditionally and answer `offline: false`, so a device that was already offline came
      // back as online here and from every later `state()` call, with the rule and the condition file
      // still saying otherwise. Reporting the request back as if it had taken is how a tester ends up
      // filing bugs against an app that was never offline; reporting it as online when it is offline
      // sends them to file against one that cannot reach anything.
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
      await this.runFilterHost()
      this.filterVerdict.set(udid, 'unavailable')
      this.updateLiveness()
      return { offline: was, available: false, reason: 'filter-unavailable' }
    }

    this.filterVerdict.delete(udid)
    if (offline) this.offlineSince.set(udid, Math.floor(Date.now() / 1000))
    else this.offlineSince.delete(udid)
    this.setCondition(udid, offline)
    await this.simctl.setStatusBarOffline(udid, offline)
    this.updateLiveness()

    return this.state(udid)
  }

  /**
   * Write the rule and **ask the provider whether it is holding it.**
   *
   * The write's exit code cannot answer that. The container app exits when the framework accepts the
   * save — 27ms for the whole run — and the running provider is handed the configuration afterwards
   * with nothing coming back. Measured propagation is under 55ms and a probe measured the ask itself
   * at 0.26–0.74ms, which is what makes asking cheaper than the six-second wait an earlier draft
   * proposed in place of it.
   *
   * **The predicate is per-device membership, not set equality.** The filter is host-wide and this
   * agent is not guaranteed to be its only writer; comparing whole sets would report every device as
   * unenforced the moment somebody else's device appeared in the rule.
   *
   * **`wanted` is the value the caller asked for, and it is a parameter for that reason.** Reading it
   * back off `this.offline` here compares the provider's answer against whatever the set says *now*,
   * which is not necessarily what this call wrote — so a second toggle landing in between made a
   * confirmation agree with a rule its own request had not asked for, and the success path then
   * applied layers 2 and 3 for the wrong direction.
   *
   * A mismatch is logged **with what was actually read**. Two agents writing the same rule cannot be
   * told apart afterwards from a log that only records what each one expected — each is internally
   * consistent and one of them is stale.
   */
  private async applyAndConfirm(udid: string, wanted: boolean): Promise<boolean> {
    if (!await this.runFilterHost()) return false
    const seen = await this.confirmEnforcement()
    if (!seen) return false
    if (!seen.enforcing) return false
    if (seen.rule.includes(udid) !== wanted) {
      console.warn(
        `[network] filter rule disagrees for ${udid}: wanted ${wanted ? 'offline' : 'online'}, ` +
        `provider ${seen.pid} holds [${seen.rule.join(',')}]`,
      )
      return false
    }
    return true
  }

  /** Ask the running provider what it is enforcing. `undefined` for every way of not finding out —
   *  the remedy is the same whether the filter is absent, disabled, or restarting. */
  private async confirmEnforcement(): Promise<{ enforcing: boolean; rule: string[]; pid: number } | undefined> {
    if (!existsSync(this.hostBinary)) return undefined
    try {
      const { stdout } = await execFileAsync(this.hostBinary, ['--confirm'], {
        timeout: FILTER_CONFIRM_TIMEOUT_MS,
      })
      const parsed = JSON.parse(stdout) as { enforcing?: unknown; rule?: unknown; pid?: unknown }
      if (typeof parsed.enforcing !== 'boolean' || !Array.isArray(parsed.rule)) return undefined
      return {
        enforcing: parsed.enforcing,
        rule: parsed.rule.filter((r): r is string => typeof r === 'string'),
        pid: typeof parsed.pid === 'number' ? parsed.pid : -1,
      }
    } catch {
      // A timeout lands here as well as a refusal, and they are the same answer: not confirmed.
      return undefined
    }
  }

  /** Layers 2 and 3, taken down together. Layer 3 is swallowed for the reason `forget` gives: it only
   *  reports, and failing it would abandon the cleanup that matters. */
  private async takeDownLayers(udid: string): Promise<void> {
    this.setCondition(udid, false)
    await this.simctl.setStatusBarOffline(udid, false).catch(() => { /* device may already be gone */ })
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

    // **Layer 1 is answered first, and from memory.** This method is synchronous — `device:ready`, a
    // viewer's re-join and MCP's `networkState()` all arrive here — so it cannot ask the provider
    // anything. Deriving layer 1's health from the dylib's verdict instead would repaint a Mac that
    // cannot take devices offline as a healthy one on the next re-join, and the tester's toast would
    // be the only evidence it ever said otherwise.
    const filter = this.filterVerdict.get(udid)
    if (filter === 'lost') return { offline, available: false, reason: 'enforcement-lost' }
    if (filter === 'unavailable') return { offline, available: false, reason: 'filter-unavailable' }

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
    return this.serialize(() => this.forgetLocked(udid))
  }

  private async forgetLocked(udid: string): Promise<void> {
    this.armed.delete(udid)
    // The judgment was about a device that is going away. Keeping it would answer for whatever is
    // booted into the same udid next.
    this.filterVerdict.delete(udid)
    this.offlineSince.delete(udid)
    // Unconditional, for the reason `arm()` gives at length: the set is this process's memory and the
    // rule is the host's. An agent that restarted knows of no offline device, so `delete` answers
    // false and the write was skipped — leaving the udid named in the rule for the rest of the Mac's
    // uptime, which is the exact outcome this method's doc block says it exists to prevent.
    this.offline.delete(udid)
    await this.runFilterHost()
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
    this.updateLiveness()
  }

  /**
   * Point the report somewhere after construction.
   *
   * **The constructor option alone left this untestable, which a review found by mutating the wiring
   * away and watching the whole suite stay green.** `IOSAgent` builds its own `SimulatorNetwork` only
   * when one was not injected, and every test injects one — so the handler was attached on exactly the
   * path no test takes. The one channel that tells a tester their finished check was invalidated had
   * no coverage at all, while the refusal path beside it had five tests.
   */
  setEnforcementLostHandler(fn: (udid: string) => void): void {
    this.enforcementLost = fn
  }

  /**
   * Stop watching. **Nothing else clears the interval**, so an agent that shuts down while a device
   * is offline would otherwise keep a timer alive for the life of the process — which is what
   * happened, because for a while this had no caller outside the tests at all. `IOSAgent.disconnect`
   * owns it, beside the resources timer and the tree reader it already stops.
   */
  dispose(): void {
    this.disposed = true
    if (this.liveness) clearInterval(this.liveness)
    this.liveness = undefined
  }

  // ── liveness: enforcement that stops after the fact ────────────────────────

  /**
   * Watch only while something is offline, because that is the only time there is anything to lose.
   *
   * The interval is `unref`'d: this must not be the reason a process stays alive.
   */
  private updateLiveness(): void {
    const wanted = !this.disposed && this.offline.size > 0
    if (wanted && !this.liveness) {
      this.liveness = setInterval(() => { void this.checkLiveness() }, this.livenessIntervalMs)
      this.liveness.unref?.()
    } else if (!wanted && this.liveness) {
      clearInterval(this.liveness)
      this.liveness = undefined
    }
  }

  /**
   * Notice that a device stopped being enforced, and say so.
   *
   * **Why this exists at all, given the confirmation on the write.** The confirmation answers the
   * moment of the request; enforcement can stop at any point afterwards, and when it does the tester
   * is looking at a control that still says offline. Measured on the reference Mac: killing the
   * provider leaves the kernel passing that simulator's traffic for about 5.8 seconds before launchd
   * has it back, and 23 to 27 requests got through each time. The tester's sign-off covers requests
   * that succeeded.
   *
   * **The threshold comes out of the file.** Three pulses, at whatever rate the provider says it is
   * pulsing — 1s while it is enforcing, so about three seconds. Hard-coding fifteen (three of the old
   * five-second pulses) is what made the outage above arithmetically invisible: the gap closes before
   * the threshold expires and nothing is ever reported.
   *
   * **A timestamp in the future is not freshness, it is a file that cannot be trusted.** Clocks move
   * backwards — NTP corrections, a sleeping Mac — and treating `at > now` as "very fresh" would make
   * a stale file look perfect for as long as the skew lasted.
   */
  private async checkLiveness(): Promise<void> {
    // Queued like every other mutation. It edits `this.offline`, rewrites the rule and takes layers
    // down, so running it beside a toggle is the race described on `serialize` — and the tick is the
    // half that used to run outside the boundary.
    if (this.livenessQueued) return
    this.livenessQueued = true
    try {
      await this.serialize(() => this.checkLivenessLocked())
    } finally {
      this.livenessQueued = false
    }
  }

  /**
   * **Three questions per device, and each one is a different piece of evidence.** A single "is the
   * file stale" test read against the whole set could not answer them, and the gap it left is
   * measured: the provider publishes its pulse rate *as of the rule it held when it wrote*, so the
   * last write before a device went offline says `pulseSeconds: 5`. A provider dying in the second
   * after a toggle therefore leaves a file that is not stale by its own declared rate for fifteen
   * seconds, and does not name the device either — both predicates false, nothing reported, and the
   * kernel passing that simulator's traffic for the whole of it.
   */
  private async checkLivenessLocked(): Promise<void> {
    if (this.offline.size === 0) return
    const file = this.readFilterState()
    const now = Math.floor(Date.now() / 1000)

    const lost = [...this.offline].filter((udid) => {
      // No file at all, or a timestamp from the future — a clock that moved backwards must not read
      // as very fresh, or a frozen file looks perfect for as long as the skew lasts.
      if (!file || file.at > now) return true
      const since = this.offlineSince.get(udid) ?? now
      // Named in the rule: only the file going stale can lose it, at whatever rate the file declares.
      // Per device rather than by set equality — the filter is host-wide, and somebody else's device
      // appearing in the rule must not make this one look unenforced.
      if (file.rule.includes(udid)) return now - file.at > 3 * Math.max(file.pulseSeconds, 1)
      // Not named, and the file was written before this device's rule was confirmed: the provider has
      // simply not published since. That is the ordinary state for about a second after every toggle,
      // and reading it as a disagreement fires on every one of them. It stops being ordinary once the
      // provider has had three of its enforcing pulses to say something.
      if (file.at <= since) return now - since > 3 * ENFORCING_PULSE_SECONDS
      // Not named, and published *after* the confirmation. The provider has spoken and this device is
      // not in what it said.
      return true
    })
    if (lost.length === 0) return

    for (const udid of lost) {
      this.offline.delete(udid)
      this.offlineSince.delete(udid)
      this.filterVerdict.set(udid, 'lost')
    }
    // Best-effort, and the same reason `setOffline` rewrites after a failure: leaving this agent's
    // idea of the rule and the host's apart is a divergence nothing revisits.
    await this.runFilterHost()
    for (const udid of lost) {
      // **Telling the tester is the remedy; taking the layers down is the tidying up.** The device is
      // already reachable — that is what was detected — so leaving the app believing otherwise would
      // add a second false state on top of the one being reported.
      await this.takeDownLayers(udid)
      this.enforcementLost(udid)
    }
    this.updateLiveness()
  }

  /** The first candidate that parses wins. A file that is present but unreadable is not evidence of
   *  anything, so it is treated as absent rather than as a reason to stop looking. */
  private readFilterState(): FilterStateFile | undefined {
    for (const path of this.stateFiles) {
      if (!existsSync(path)) continue
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FilterStateFile>
        if (typeof raw.at !== 'number' || !Array.isArray(raw.rule)) continue
        return {
          at: raw.at,
          pulseSeconds: typeof raw.pulseSeconds === 'number' ? raw.pulseSeconds : 5,
          rule: raw.rule.filter((r): r is string => typeof r === 'string'),
        }
      } catch {
        continue
      }
    }
    return undefined
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
   * **What is serialised is the whole operation, and an earlier version serialised only the host
   * run.** That version released the queue the moment the rule was written, so the confirmation that
   * follows ran outside it — and a review found two ways that breaks. A liveness tick landing between
   * a device joining the offline set and its confirmation declared that device's enforcement lost,
   * rewrote the rule without it, took layers 2 and 3 down, and told every session; the confirmation
   * then came back, compared against a set the tick had already edited, agreed with itself, and put
   * layers 2 and 3 **back on** over a kernel rule that no longer named the device. Two toggles of the
   * same device overlapping produced the mirror image: a fully healthy-looking offline control with
   * layer 2 taken down under it. Both end in the state this class exists to prevent — the app told it
   * is offline while its requests succeed — so the boundary has to contain the confirmation, and
   * every reader and writer of `offline` has to be inside it.
   *
   * The timeout covers a host that never returns. It waits on `OSSystemExtensionRequest`, and one of
   * its outcomes is a System Settings dialog nobody is standing in front of; the binary now exits
   * itself on that path, but a timeout here is what keeps a wedge from taking the queue with it —
   * everything after it is waiting on this chain.
   */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.filterQueue.then(work)
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
