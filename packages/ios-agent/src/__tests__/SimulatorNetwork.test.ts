import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimulatorNetwork } from '../SimulatorNetwork.js'

const UDID = 'AAAAAAAA-1111-2222-3333-444444444444'
const OTHER = 'BBBBBBBB-5555-6666-7777-888888888888'

/**
 * A stand-in for the container app.
 *
 * It records **how many condition files existed at the moment it ran**, which is what makes the
 * layer ordering assertable at all: the files are written by this process, so their order relative to
 * the rule is invisible unless something observes it from the outside.
 */
function fakeHostBinary(dir: string, log: string, sleepMs = 0, failNth = 0): string {
  const path = join(dir, `fake-filter-host${sleepMs}-${failNth}`)
  // `--offline` may be empty, which is how the rule is cleared; `${2-}` keeps that from failing.
  // Exits non-zero while a sentinel file exists, so a test can take the container app away between
  // one toggle and the next — which is the only way to reach the failure path from a device that is
  // already offline, and that starting state is where the bug was.
  //
  // `enter:` is logged on the way IN and the rule on the way out, so a test can see two runs
  // overlapping. Without both marks, concurrent runs and serialised ones leave the same log.
  // `failNth` fails one specific invocation and lets the rest through, which is what a *transient*
  // failure looks like. A permanently broken app (the `BREAK` sentinel) cannot show the divergence
  // this exists for, because the recovery write fails too.
  // It also stands in for the **provider**, because the class now asks one. `--confirm` answers from
  // the rule this script last wrote, and a state file is refreshed beside it — the two artefacts a
  // real provider produces. A fake that only recorded the write would let every confirmation fail and
  // turn each of these tests green for the wrong reason.
  //
  // `--confirm` is answered before the failure counters, so `failNth` still counts rule writes only.
  // `BREAK` comes first and takes the confirmation down with it: a container app that cannot run
  // cannot answer either.
  const ruleToJson = `awk -F, '{o="";for(i=1;i<=NF;i++){if($i!=""){o=o (o==""?"":",") "\\"" $i "\\""}} print "[" o "]"}'`
  writeFileSync(
    path,
    `#!/bin/sh\n`
    + `[ -e "${dir}/BREAK" ] && exit 1\n`
    + `if [ "$1" = "--confirm" ]; then\n`
    // Three sentinels, one per way a confirmation fails, because they are not the same code path in
    // the class: no answer at all, an answer saying nothing is being enforced, and a call that hangs
    // — which is what a dead provider actually does (measured 3/3, it blocks to the caller's
    // deadline rather than erroring).
    + `  [ -e "${dir}/NO_CONFIRM" ] && exit 7\n`
    + `  [ -e "${dir}/CONFIRM_HANG" ] && sleep 5\n`
    + `  if [ -e "${dir}/NOT_ENFORCING" ]; then printf '{"enforcing":false,"rule":[],"pid":1}\\n'; exit 0; fi\n`
    + `  R=$(cat "${dir}/rule" 2>/dev/null || echo "")\n`
    + `  printf '{"enforcing":true,"rule":%s,"pid":1}\\n' "$(echo "$R" | ${ruleToJson})"\n`
    + `  exit 0\n`
    + `fi\n`
    + (failNth > 0
      ? `N=$(cat "${dir}/runs" 2>/dev/null || echo 0); N=$((N+1)); echo $N > "${dir}/runs"\n`
        + `[ "$N" = "${failNth}" ] && exit 1\n`
      : '')
    + (sleepMs > 0 ? `printf 'enter:%s\\n' "\${2-}" >> "${log}"\nsleep ${sleepMs / 1000}\n` : '')
    + `printf '%s' "\${2-}" > "${dir}/rule"\n`
    + `printf '{"at":%s,"pulseSeconds":1,"rule":%s}\\n' "$(date +%s)" "$(printf '%s' "\${2-}" | ${ruleToJson})" > "${dir}/state.json"\n`
    + `printf 'rule:%s cond:%s\\n' "\${2-}" "$(ls "${dir}" | grep -c '^tapflow-offline-')" >> "${log}"\n`,
    { mode: 0o755 },
  )
  return path
}

describe('SimulatorNetwork', () => {
  let dir: string
  let log: string
  let statusBar: string[]
  let env: string[]
  let simctl: {
    setStatusBarOffline: (udid: string, offline: boolean) => Promise<void>
    setSimulatorEnv: (udid: string, name: string, value: string) => Promise<void>
  }

  const verdictPath = (udid: string) => join(dir, `tapflow-nethook-${udid}.json`)
  const conditionPath = (udid: string) => join(dir, `tapflow-offline-${udid}`)

  /** Every device this test reported as no longer enforced. */
  let lost: string[]

  const make = (hostBinary?: string) => {
    const n = new SimulatorNetwork(simctl, {
      filterHostBinary: hostBinary ?? fakeHostBinary(dir, log),
      conditionDir: dir,
      verdictDir: dir,
      nethookDylib: '/fake/libtapflow-nethook.dylib',
      // **Pointed at this test's own directory, and that is not only hygiene.** The default is the
      // path the real provider writes on this Mac, so a suite left on the default would read whatever
      // the developer's own filter happens to be enforcing — green or red depending on the machine.
      filterStateFiles: [join(dir, 'state.json')],
      onEnforcementLost: (udid) => { lost.push(udid) },
      livenessIntervalMs: 20,
    })
    made.push(n)
    return n
  }
  /** Disposed in `afterEach`: the liveness watcher is the first thing here that outlives a test. */
  let made: SimulatorNetwork[]

  /** The hooks reported themselves installed — the ordinary case for a device with an app running. */
  const armed = (udid = UDID) => writeFileSync(verdictPath(udid), JSON.stringify({ installed: true }))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tapflow-net-'))
    log = join(dir, 'calls.log')
    statusBar = []
    env = []
    lost = []
    made = []
    simctl = {
      setSimulatorEnv: vi.fn(async (udid: string, name: string, value: string) => {
        env.push(`${udid}:${name}=${value}`)
      }),
      setStatusBarOffline: vi.fn(async (udid: string, offline: boolean) => {
        // Appended to the same log as the filter rule so the ORDER between layers is observable —
        // that ordering is this class's actual contract, not an implementation detail.
        statusBar.push(`${udid}:${offline}`)
        appendFileSync(log, `statusbar:${offline}\n`)
      }),
    }
  })

  afterEach(() => {
    for (const n of made) n.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  function readAll(): string {
    return existsSync(log) ? readFileSync(log, 'utf8') : ''
  }

  /** Just the rule lines, in the order the container app was invoked. */
  function rules(): string[] {
    return readAll().split('\n').filter(l => l.startsWith('rule:'))
  }

  it('reports the device offline and steerable once every layer is applied', async () => {
    armed()
    const net = make()

    await expect(net.setOffline(UDID, true)).resolves.toEqual({ offline: true, available: true })
    expect(existsSync(conditionPath(UDID))).toBe(true)
    expect(statusBar).toEqual([`${UDID}:true`])
  })

  it('applies the filter rule BEFORE the condition file', async () => {
    armed()
    const net = make()
    await net.setOffline(UDID, true)

    // The dylib cuts the app's open sockets the instant the condition file appears. If the filter is
    // not already dropping new flows by then, the app reconnects and the reconnected socket outlives
    // the toggle — reproduced exactly that way while stepping the layers separately.
    expect(rules()).toEqual([`rule:${UDID} cond:0`])
    expect(existsSync(conditionPath(UDID))).toBe(true)
  })

  it('applies the filter rule BEFORE the status bar', async () => {
    armed()
    const net = make()
    await net.setOffline(UDID, true)

    // The status bar reports; it must not claim a state before the state is true.
    const order = readAll()
    expect(order.indexOf('rule:')).toBeLessThan(order.indexOf('statusbar:'))
  })

  it('carries every offline simulator in the rule, because the filter takes the whole set', async () => {
    armed()
    armed(OTHER)
    const net = make()

    await net.setOffline(UDID, true)
    await net.setOffline(OTHER, true)

    expect(rules().at(-1)).toBe(`rule:${UDID},${OTHER} cond:1`)
  })

  it('leaves the other simulator alone when one goes back online', async () => {
    armed()
    armed(OTHER)
    const net = make()
    await net.setOffline(UDID, true)
    await net.setOffline(OTHER, true)

    await net.setOffline(UDID, false)

    expect(rules().at(-1)).toBe(`rule:${OTHER} cond:2`)
    expect(existsSync(conditionPath(UDID))).toBe(false)
    expect(existsSync(conditionPath(OTHER))).toBe(true)
  })

  it('does not report an offline device as online when the rule cannot be written', async () => {
    // The failure path used to delete from the set unconditionally and answer `offline: false`, so a
    // device that was already offline came back as online here **and from every later `state()`** —
    // with the rule and the condition file still saying otherwise. The one test that covered this
    // path started from a device that had never been offline, where deleting is accidentally right,
    // so inverting the line changed nothing.
    armed()
    const net = make()
    await net.setOffline(UDID, true)

    writeFileSync(join(dir, 'BREAK'), '')   // the container app stops working
    const after = await net.setOffline(UDID, false)

    expect(after).toEqual({ offline: true, available: false, reason: 'filter-unavailable' })

    // **The whole payload, and that is the gap #638 closed.** This used to compare `.offline` alone
    // with a comment explaining why it had to: `state()` looked only at the dylib's verdict, so for
    // this device — dylib fine, container app gone — it answered `available: true` in the same second
    // the call above answered `false`, and the reason it could have given (`not-armed`) prescribed a
    // reboot for something no reboot installs. `state()` now remembers what layer 1 was last found
    // doing, which is what makes one assertion cover both.
    expect(net.state(UDID)).toEqual({ offline: true, available: false, reason: 'filter-unavailable' })
  })

  it('does not report an online device as offline when the rule cannot be written', async () => {
    // The other direction of the same restore: a device that was online must not be left in the set
    // by a request that did not land.
    armed()
    const net = make()

    writeFileSync(join(dir, 'BREAK'), '')
    const after = await net.setOffline(UDID, true)

    expect(after).toEqual({ offline: false, available: false, reason: 'filter-unavailable' })
    expect(net.state(UDID).offline).toBe(false)
  })

  it('writes the rule back when a run fails after another has already committed', async () => {
    // **The failure serialising the runs introduced**, and it needs all three of concurrency, the
    // set being read at run time, and a transient failure — which is why the first attempt at this
    // test passed with the fix removed.
    //
    // Run 2 reads `this.offline` when it RUNS, by which point request 3 has already deleted UDID from
    // it — so it commits a set that request 3 asked for and request 2 did not. Request 3 then fails
    // and puts UDID back in memory. Without a further write the kernel rule says `OTHER` while this
    // class says UDID is offline: traffic alive, drawn as offline, which is the direction `setOffline`
    // calls filing bugs against an app that was never offline.
    //
    // Mutation: removing the `applyFilterRule()` from the restore branch fails here.
    armed()
    armed(OTHER)
    const net = make(fakeHostBinary(dir, log, 0, 3))
    await net.setOffline(UDID, true)                       // run 1
    await Promise.all([
      net.setOffline(OTHER, true),                         // run 2 — commits {OTHER}
      net.setOffline(UDID, false),                         // run 3 — fails, restores UDID
    ])

    expect(net.state(UDID).offline, 'the failed request must leave the device where it was').toBe(true)
    expect(rules().at(-1), 'the rule disagrees with the set').toContain(UDID)
  })

  it('drops a retired device from the rule even when this process never put it there', async () => {
    // An agent that restarted knows of no offline device, so `delete` answers false — and the write
    // used to be conditional on it. The rule is the host's, not this process's memory, so skipping it
    // left the udid named for the rest of the Mac's uptime, which is the outcome `forget` exists to
    // prevent.
    //
    // Mutation: restoring `if (this.offline.delete(udid))` fails here.
    const net = make()
    await net.forget(UDID)
    expect(rules(), 'forget wrote no rule at all').not.toEqual([])
  })

  it('does not claim offline when the container app is not installed', async () => {
    armed()
    const net = make(join(dir, 'does-not-exist'))

    await expect(net.setOffline(UDID, true)).resolves.toEqual({
      offline: false, available: false, reason: 'filter-unavailable',
    })
    // Nothing else may be applied on that path: a condition file with no filter behind it is the
    // half-state that tells an app it is offline while its traffic flows.
    expect(existsSync(conditionPath(UDID))).toBe(false)
    expect(statusBar).toEqual([])
  })

  it('says not-armed when nothing was delivered to the device', () => {
    // Never armed: the remedy is a reboot, which is what this reason prescribes.
    const net = make()
    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'not-armed' })
  })

  it('says awaiting-app once the injection is in place but no app has run', async () => {
    // The common case, not an edge one — every iOS session looks like this between the device coming
    // up and its app starting. Reported as `not-armed` it prescribed a reboot, which fixes nothing,
    // and drew a control that does work as one that cannot.
    const net = make()
    await net.arm(UDID)
    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'awaiting-app' })
  })

  it('does not claim the injection is in place when the environment could not be set', async () => {
    simctl.setSimulatorEnv = vi.fn(async () => { throw new Error('simctl spawn failed') })
    const net = make()
    await expect(net.arm(UDID)).rejects.toThrow()
    // Nothing was delivered, so "waiting for an app" would send the tester to launch one forever.
    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'not-armed' })
  })

  it('stops claiming the injection after the device is retired', async () => {
    const net = make()
    await net.arm(UDID)
    await net.forget(UDID)
    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'not-armed' })
  })

  it('says hooks-not-installed when the dylib ran and proved it could not hook', () => {
    writeFileSync(verdictPath(UDID), JSON.stringify({ installed: false }))
    const net = make()
    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'hooks-not-installed' })
  })

  it('treats an unreadable verdict as unconfirmed, never as an install', () => {
    // **The half that does not change: a truncated file is not evidence the hooks took.** Reading it
    // as an install hands a healthy control to a device nobody can vouch for.
    //
    // What changed is which unavailable reason it is. `hooks-not-installed` means the library ran and
    // *proved* its hooks did not take, which a truncated file shows nothing of — it is the library
    // caught mid-write, which it does non-atomically (#653). `state-unconfirmed` says the read could
    // not be confirmed and to look again, which is what actually resolves it.
    writeFileSync(verdictPath(UDID), '{ truncated')
    const net = make()
    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'state-unconfirmed' })
  })

  it('says the same for an unreadable verdict on a device that is armed', async () => {
    // **The case the reason was chosen for.** Resolving an unreadable verdict against `armed` puts it
    // in `awaiting-app` almost every time — the library writes that file *because* an app is running,
    // so `armed` is true — and `awaiting-app` is the one member the dashboard draws with a healthy
    // control and "launch an app". The answer must not depend on `armed` at all.
    const net = make()
    await net.arm(UDID)
    writeFileSync(verdictPath(UDID), '{ truncated')

    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'state-unconfirmed' })
  })

  it('reserves hooks-not-installed for the library actually saying so', () => {
    // `installed !== true` swept up every shape that is not the library's own failure signal and
    // answered "it ran and proved its hooks did not take" about files that show nothing — the same
    // overclaim the branch above exists to remove, one case over.
    for (const body of ['{}', '[]', '123', 'true', '"x"', 'null']) {
      const net = make()
      writeFileSync(verdictPath(UDID), body)
      expect(net.state(UDID), `verdict body ${body}`)
        .toEqual({ offline: false, available: false, reason: 'state-unconfirmed' })
    }
    const net = make()
    writeFileSync(verdictPath(UDID), JSON.stringify({ installed: false }))
    expect(net.state(UDID), 'the one shape that does say so')
      .toEqual({ offline: false, available: false, reason: 'hooks-not-installed' })
  })

  it('swallows a status bar failure going offline, because layer 3 only reports', async () => {
    // Unswallowed, one `status_bar` failure threw out of `setOffline` with layers 1 and 2 already
    // applied: the device really was offline and the caller was told the request failed, which sends a
    // tester to file against an app that was never online.
    armed()
    const net = make()
    vi.mocked(simctl.setStatusBarOffline).mockRejectedValueOnce(new Error('device is gone'))

    await expect(net.setOffline(UDID, true)).resolves.toEqual({ offline: true, available: true })
    expect(existsSync(conditionPath(UDID)), 'the layer that does the work was rolled back').toBe(true)
  })

  it('swallows it on the way back too, and the next toggle writes the bar again', async () => {
    // The mirror, and it fails the other way. Going offline the bar errs quietly — the device is
    // offline and the bar has not caught up. Coming back, every layer is restored and the bar still
    // shows no service on a device whose requests now succeed. Neither is worth failing the call for;
    // what puts the second one right is the next successful toggle writing the bar again.
    armed()
    const net = make()
    await net.setOffline(UDID, true)
    expect(statusBar).toEqual([`${UDID}:true`])

    vi.mocked(simctl.setStatusBarOffline).mockRejectedValueOnce(new Error('device is gone'))
    await expect(net.setOffline(UDID, false)).resolves.toEqual({ offline: false, available: true })
    expect(statusBar, 'the bar is stale here, and that is the accepted cost').toEqual([`${UDID}:true`])

    await net.setOffline(UDID, true)
    await net.setOffline(UDID, false)
    expect(statusBar.at(-1), 'no later toggle caught the bar up').toBe(`${UDID}:false`)
  })

  it('still reports a device offline after it stops being steerable', async () => {
    armed()
    const net = make()
    await net.arm(UDID)
    armed()   // arm() clears what a previous boot left; this is the app running again
    await net.setOffline(UDID, true)

    // The app exits and takes its verdict with it. The injection is still in place, so the remedy is
    // to launch an app again — not to reboot.
    rmSync(verdictPath(UDID))

    // `offline` describes the device, not the request. Reporting false here would draw "online" over
    // an app that can reach nothing.
    expect(net.state(UDID)).toEqual({ offline: true, available: false, reason: 'awaiting-app' })
  })

  describe('arm', () => {
    it('inserts the library and clears what a previous boot left behind', async () => {
      // Both files live on the host and are keyed only by udid, so they outlive the simulator that
      // wrote them: a device booting into a leftover condition file is offline before anyone asked.
      writeFileSync(conditionPath(UDID), '')
      writeFileSync(verdictPath(UDID), JSON.stringify({ installed: true }))
      const net = make()

      await net.arm(UDID)

      expect(existsSync(conditionPath(UDID))).toBe(false)
      expect(existsSync(verdictPath(UDID))).toBe(false)
      expect(env).toEqual([`${UDID}:DYLD_INSERT_LIBRARIES=/fake/libtapflow-nethook.dylib`])
    })

    it('does not name a target app, because none is known yet at boot', async () => {
      const net = make()
      await net.arm(UDID)
      expect(env.some(e => e.includes('TAPFLOW_TARGET_BUNDLE'))).toBe(false)
    })

    it('forgets an offline device it is re-arming, in the rule and not only in memory', async () => {
      armed()
      const net = make()
      await net.setOffline(UDID, true)

      await net.arm(UDID)

      // The device rebooted; whatever it was before, it is online now and **the rule has to agree**.
      // Asserting `state()` alone was what let this through: the in-memory set was cleared and the
      // host rule still named the device, so the simulator came up with its traffic dead while this
      // reported it online and steerable.
      expect(net.state(UDID).offline).toBe(false)
      expect(rules().at(-1)).toBe('rule: cond:0')
    })

    it('clears a rule left behind by a previous process', async () => {
      // An agent that crashed while a device was offline leaves the rule on the host and takes its
      // memory with it. The replacement knows of no offline device, and writing what it knows is
      // what recovers the simulator — so the rule is rewritten unconditionally, not only when this
      // instance happens to remember putting the device in it.
      const net = make()
      await net.arm(UDID)
      expect(rules()).toEqual(['rule: cond:0'])
    })

    it('takes the status bar down when a device is retired', async () => {
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      statusBar.length = 0

      await net.forget(UDID)

      // `setStatusBarOffline` had exactly one caller, so a device retired while offline kept showing
      // no service for as long as it stayed booted — a relay disconnect was enough.
      expect(statusBar).toEqual([`${UDID}:false`])
    })

    it('finishes retiring a device whose status bar can no longer be set', async () => {
      // The usual case: the simulator is already gone, so `status_bar clear` fails. The rule and the
      // condition file still have to come off.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      simctl.setStatusBarOffline = vi.fn(async () => { throw new Error('device shut down') })

      await expect(net.forget(UDID)).resolves.toBeUndefined()

      expect(rules().at(-1)).toBe('rule: cond:1')
      expect(existsSync(conditionPath(UDID))).toBe(false)
    })
  })

  describe('target', () => {
    it('names the app the hooks may touch', async () => {
      const net = make()
      await net.target(UDID, 'com.example.app')
      expect(env).toEqual([`${UDID}:TAPFLOW_TARGET_BUNDLE=com.example.app`])
    })

    it('does not answer for the next app on the previous one\'s evidence', async () => {
      // A verdict is one process's report about its own hooks, and that process is gone by the time a
      // second app is launched. Left behind it said `available: true` before the new app had written
      // anything — and kept saying it for the whole session if the new app's hooks failed.
      //
      // Mutation: dropping the `rmSync` from `target` fails here.
      const net = make()
      await net.arm(UDID)
      armed()
      expect(net.state(UDID)).toEqual({ offline: false, available: true })

      await net.target(UDID, 'com.example.second')
      expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'awaiting-app' })
    })
  })

  it('runs the container app one at a time', async () => {
    // The host takes the whole offline set on each run and the last writer wins, so two in flight
    // decide the rule by which subprocess finishes last rather than by which request came last. Both
    // runs read a correct set, which is what makes the wrong outcome invisible afterwards.
    //
    // The fake host sleeps, so an unserialised implementation interleaves: the assertion is that the
    // LAST line is the last request's set, and that no run started before its predecessor finished.
    //
    // Mutation: awaiting `runFilterHost` directly instead of chaining fails here.
    armed()
    armed(OTHER)
    const net = make(fakeHostBinary(dir, log, 60))
    await Promise.all([net.setOffline(UDID, true), net.setOffline(OTHER, true)])

    const marks = readAll().split('\n').filter(l => l.startsWith('rule:') || l.startsWith('enter:'))
    for (let i = 0; i < marks.length; i += 2) {
      expect(marks[i], `overlapping host runs in ${JSON.stringify(marks)}`).toMatch(/^enter:/)
      expect(marks[i + 1], `overlapping host runs in ${JSON.stringify(marks)}`).toMatch(/^rule:/)
    }
    expect(rules().at(-1)).toContain(OTHER)
    expect(rules().at(-1)).toContain(UDID)
  })

  it('drops a forgotten device out of the rule', async () => {
    armed()
    const net = make()
    await net.setOffline(UDID, true)

    await net.forget(UDID)

    expect(rules().at(-1)).toBe('rule: cond:1')
    expect(existsSync(conditionPath(UDID))).toBe(false)
  })

  it('clears a stale condition file for a device that was never in the set', async () => {
    writeFileSync(conditionPath(UDID), '')
    const net = make()

    await net.forget(UDID)

    expect(existsSync(conditionPath(UDID))).toBe(false)
  })

  // ── the rule is confirmed, not assumed (#639) ───────────────────────────────────────────────
  //
  // The container app exits when the framework *accepts* the save — 27ms for the whole run — and the
  // provider is handed the configuration afterwards with nothing coming back. So every test here is
  // about a write that succeeded and a rule that is not being enforced, which is precisely the state
  // the old code reported as `available: true`.
  describe('confirmation', () => {
    /** Layers 2 and 3 must not have been applied. Asserted together because "refused" means both. */
    const nothingApplied = () => {
      expect(existsSync(conditionPath(UDID)), 'a condition file with no filter behind it').toBe(false)
      expect(statusBar, 'the status bar claimed a state nothing was enforcing').toEqual([])
    }

    it('refuses when the provider does not answer', async () => {
      armed()
      writeFileSync(join(dir, 'NO_CONFIRM'), '')
      const net = make()

      await expect(net.setOffline(UDID, true)).resolves.toEqual({
        offline: false, available: false, reason: 'filter-unavailable',
      })
      nothingApplied()
    })

    it('refuses when the provider answers that it is not enforcing', async () => {
      // `rule: []` alone cannot carry this: an idle provider with no offline device says the same
      // thing. Measured on a `--off` provider — alive, answering in 16ms, holding nothing — which is
      // why `enforcing` is a field of its own rather than something derived from the rule.
      armed()
      writeFileSync(join(dir, 'NOT_ENFORCING'), '')
      const net = make()

      await expect(net.setOffline(UDID, true)).resolves.toEqual({
        offline: false, available: false, reason: 'filter-unavailable',
      })
      nothingApplied()
    })

    it('refuses even when the rule already matches, if nothing is enforcing it', async () => {
      // **The case `enforcing` exists for, and the one membership cannot cover.** Asking a device to
      // come back online while the filter is stopped: the rule is empty and the request wants it
      // empty, so a check comparing only membership calls that a success and reports a healthy control
      // over a Mac that cannot take anything offline.
      //
      // Found by mutation: deleting the `enforcing` branch left the whole suite green, because the
      // test above reaches the refusal through the membership mismatch instead.
      armed()
      writeFileSync(join(dir, 'NOT_ENFORCING'), '')
      const net = make()

      await expect(net.setOffline(UDID, false)).resolves.toEqual({
        offline: false, available: false, reason: 'filter-unavailable',
      })
    })

    it('refuses a confirmation that hangs rather than waiting it out', async () => {
      // **The case the timeout exists for, and it is the common one.** A call made while the provider
      // is dead does not fail — measured 3/3, it blocks to the caller's own deadline, because launchd
      // holds the mach name while the process is away. A provider killed and restarted by launchd is
      // gone for about 5.8s, so this is what a toggle during any restart runs into.
      armed()
      writeFileSync(join(dir, 'CONFIRM_HANG'), '')
      const net = make()

      const began = Date.now()
      await expect(net.setOffline(UDID, true)).resolves.toEqual({
        offline: false, available: false, reason: 'filter-unavailable',
      })
      // The fake sleeps 5s. Anything near that means the timeout did not fire and the dashboard's own
      // 8s deadline would be deciding this instead.
      expect(Date.now() - began, 'the confirmation was waited out instead of cut short').toBeLessThan(3_000)
      nothingApplied()
    })

    it('keeps a device offline when a later request cannot be confirmed', async () => {
      // The direction that matters: reporting `offline: false` here would draw an online control over
      // a device whose app can reach nothing.
      armed()
      const net = make()
      await net.setOffline(UDID, true)

      writeFileSync(join(dir, 'NO_CONFIRM'), '')
      await expect(net.setOffline(UDID, false)).resolves.toEqual({
        offline: true, available: false, reason: 'filter-unavailable',
      })
    })

    it('remembers the refusal, so a re-join does not repaint the control as healthy', async () => {
      // `state()` is synchronous and cannot ask the provider anything, and every re-join, every
      // `device:ready` and MCP's `networkState()` come through it. Deriving layer 1's health from the
      // dylib's verdict — which is fine here — answers `available: true` in the same second the call
      // above answered `false`.
      armed()
      writeFileSync(join(dir, 'NO_CONFIRM'), '')
      const net = make()
      await net.setOffline(UDID, true)

      expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'filter-unavailable' })
    })
  })

  // ── enforcement that stops after the fact (#639) ────────────────────────────────────────────
  describe('liveness', () => {
    const staleState = (rule: string[], atOffsetSeconds: number, pulseSeconds = 1) =>
      writeFileSync(join(dir, 'state.json'), JSON.stringify({
        at: Math.floor(Date.now() / 1000) + atOffsetSeconds, pulseSeconds, rule,
      }))

    it('reports a device whose enforcement stopped and takes the other layers down', async () => {
      // **The measurement this exists for**: killing the provider leaves the kernel passing that
      // simulator's traffic for about 5.8 seconds, and 23–27 requests got through each time. The
      // tester is looking at an offline control for all of it, and the sign-off they give covers
      // requests that succeeded.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      expect(statusBar).toEqual([`${UDID}:true`])

      staleState([UDID], -10)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))

      // Telling the tester is the remedy; the layers coming down is the tidying up. Leaving them
      // would add a second false state on top of the one being reported.
      expect(existsSync(conditionPath(UDID))).toBe(false)
      expect(statusBar.at(-1)).toBe(`${UDID}:false`)
      expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'enforcement-lost' })
    })

    it('still says so on a re-join', async () => {
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      staleState([UDID], -10)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))

      // A second read is what a re-join is. If this repainted healthy, the toast would be the only
      // trace that anything had gone wrong.
      expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'enforcement-lost' })
    })

    it('treats a timestamp in the future as untrustworthy, not as fresh', async () => {
      // Clocks move backwards — an NTP correction, a Mac waking up. Reading `at > now` as very fresh
      // would make a frozen file look perfect for as long as the skew lasted.
      armed()
      const net = make()
      await net.setOffline(UDID, true)

      staleState([UDID], 3_600)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
    })

    it('judges membership per device, not by comparing whole sets', async () => {
      // Per-device membership, never set equality. The filter is host-wide and this agent is not
      // guaranteed to be its only writer; comparing whole sets would report every device as
      // unenforced the moment somebody else's appeared in the rule.
      //
      // **The wait is what puts this on the branch it is about.** `at` has one-second granularity and
      // a file from the same second as the write is not judged at all, so without it both halves below
      // would pass on a build with no membership test in it.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      await new Promise((r) => setTimeout(r, 1_100))

      staleState([UDID, OTHER], 0)
      await new Promise((r) => setTimeout(r, 100))
      expect(lost, 'another simulator in the rule is not this one\'s problem').toEqual([])
      expect(net.state(UDID)).toEqual({ offline: true, available: true })

      // And the same file with this device dropped out of it is the failure being watched for.
      staleState([OTHER], 0)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
    })

    it('does not call a device lost on a file published before the write', async () => {
      // What an idle provider's last publish looks like at the moment a device is toggled offline: a
      // fresh, valid file that does not name it yet, because the provider has not pulsed since. Read
      // as a disagreement it fires on **every** toggle — which is how it was found, by a test about
      // something else whose rule this kept rewriting.
      armed()
      const net = make()
      await net.setOffline(UDID, true)

      staleState([], -1)
      await new Promise((r) => setTimeout(r, 100))

      expect(lost).toEqual([])
      expect(net.state(UDID)).toEqual({ offline: true, available: true })
    })

    it('reads the second candidate path when the first is absent', async () => {
      armed()
      const net = new SimulatorNetwork(simctl, {
        filterHostBinary: fakeHostBinary(dir, log),
        conditionDir: dir,
        verdictDir: dir,
        nethookDylib: '/fake/libtapflow-nethook.dylib',
        filterStateFiles: [join(dir, 'nowhere.json'), join(dir, 'state.json')],
        onEnforcementLost: (udid) => { lost.push(udid) },
        livenessIntervalMs: 20,
      })
      made.push(net)
      await net.setOffline(UDID, true)

      staleState([UDID], -10)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
    })

    it('takes the staleness threshold from the rate the file declares', async () => {
      // The provider changes its own rate — one second while it is enforcing, five when idle — and
      // publishes the one in force. A reader holding a constant instead is either too eager or blind:
      // every test here used `pulseSeconds: 1`, so a hard-coded `3` was indistinguishable from reading
      // the file, and the doc block's claim that the threshold comes out of the file was never run.
      armed()
      const net = make()
      await net.setOffline(UDID, true)

      // Named, eight seconds old, declaring the five-second rate. Three of those is fifteen, so this
      // is a provider that is alive and quiet — not a lost one. A constant three loses it here.
      staleState([UDID], -8, 5)
      await new Promise((r) => setTimeout(r, 200))
      expect(lost, 'lost a device that was still inside its own declared threshold').toEqual([])

      staleState([UDID], -20, 5)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
    })

    it('reports a loss even when the last file was written at the idle rate', async () => {
      // **The hole a review found, and it is the one this whole watcher exists for.** The rate in the
      // file describes the rule the provider held *when it wrote*, so the last publish before a device
      // goes offline declares the idle five seconds. A provider dying in the second after a toggle
      // leaves that file as the newest one there is: not stale by its own rate for fifteen seconds,
      // and not naming the device either. Both predicates false, nothing reported — while the kernel
      // passes that simulator's traffic.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      writeFileSync(join(dir, 'state.json'), JSON.stringify({
        at: Math.floor(Date.now() / 1000) - 1, pulseSeconds: 5, rule: [],
      }))

      // Not immediately: for about a second after any toggle this is exactly what a healthy provider
      // that has not pulsed yet looks like, and firing there fires on every toggle.
      await new Promise((r) => setTimeout(r, 1_500))
      expect(lost, 'reported before the provider had its pulses to speak').toEqual([])

      // But it does not wait fifteen seconds for a rate that no longer applies.
      await vi.waitFor(() => expect(lost).toEqual([UDID]), { timeout: 6_000 })
    })

    it('does not report a device lost while its own toggle is still in flight', async () => {
      // **Blocker found by review.** A device joins `this.offline` before its rule is written, so a
      // liveness tick landing in between saw a device the file did not name and declared its
      // enforcement lost — rewriting the rule without it, taking layers 2 and 3 down and telling every
      // session. The confirmation then returned, agreed with the set the tick had just edited, and put
      // layers 2 and 3 back **on** over a kernel rule that no longer named the device: the app told it
      // is offline while every request succeeds, produced by the feature that exists to prevent it.
      //
      // The second device is what makes it reachable — the watcher only runs once something is
      // offline — and the slow host is what makes the window wide enough to hit deterministically.
      armed()
      armed(OTHER)
      const net = make(fakeHostBinary(dir, log, 600))
      await net.setOffline(OTHER, true)
      staleState([OTHER], 0)

      const inFlight = net.setOffline(UDID, true)
      await new Promise((r) => setTimeout(r, 300))
      const result = await inFlight

      // **Two guards close this and either one alone is enough**, which is worth knowing before
      // mutating: reverting only the queueing of the liveness tick, or only the `?? now` fallback for a
      // device with no confirmation yet, leaves this green. Reverting both fails it. That is the shape
      // of the defect — it needed a tick to run mid-toggle *and* a predicate that read an absent
      // confirmation as "long ago" — so a mutation of either line surviving is the design, not a hole.
      expect(lost, 'a device was declared lost while its own toggle was still running').toEqual([])
      expect(result).toEqual({ offline: true, available: true })
      expect(existsSync(conditionPath(UDID)), 'layer 2 was applied over a rule that lost the device').toBe(true)
      expect(rules().at(-1)).toContain(UDID)
    })

    it('keeps the layers agreeing when two toggles of one device overlap', async () => {
      // The mirror of the case above, and the second blocker: the confirmation used to read what it
      // wanted off the shared set at reply time rather than from its own request, so an overlapping
      // toggle made one call's confirmation agree with the other call's rule. The loser then ran its
      // success path for the wrong direction — a fully healthy-looking offline control with layer 2
      // taken down under it.
      //
      // Asserted as an invariant rather than a sequence: whatever order they land in, what `state()`
      // reports and what the three layers hold have to be the same thing.
      armed()
      const net = make(fakeHostBinary(dir, log, 200))
      await net.setOffline(UDID, true)

      await Promise.all([net.setOffline(UDID, false), net.setOffline(UDID, true)])

      // Same redundancy as the test above, and the same warning. Serialising the whole operation and
      // taking `wanted` from the request each close this alone; removing both reproduces the original
      // failure and this fails on layer 1.
      const settled = net.state(UDID)
      expect(existsSync(conditionPath(UDID)), 'layer 2 disagrees with the reported state').toBe(settled.offline)
      expect(statusBar.at(-1), 'layer 3 disagrees with the reported state').toBe(`${UDID}:${settled.offline}`)
      expect(rules().at(-1)?.includes(UDID), 'layer 1 disagrees with the reported state').toBe(settled.offline)
    })

    it('is steerable again once the filter answers again', async () => {
      // The recovery half, which nothing covered: every failure test wrote a sentinel and none removed
      // one, so the line that clears the remembered verdict ran unobserved. Deleting it leaves a device
      // permanently `filter-unavailable` after one refusal, with the whole suite green.
      armed()
      writeFileSync(join(dir, 'NO_CONFIRM'), '')
      const net = make()
      await net.setOffline(UDID, true)
      expect(net.state(UDID).available).toBe(false)

      rmSync(join(dir, 'NO_CONFIRM'), { force: true })

      await expect(net.setOffline(UDID, true)).resolves.toEqual({ offline: true, available: true })
      expect(net.state(UDID)).toEqual({ offline: true, available: true })
    })

    it('does not carry a lost verdict into the next boot', async () => {
      // `state()` reads the remembered layer-1 judgment before every other piece of evidence, and
      // nothing else clears it — a device that left `this.offline` is never looked at by the watcher
      // again. So a rebooted simulator answered `enforcement-lost` from `device:ready` and from every
      // re-join after it, and the dashboard interrupts on that reason rather than re-colouring: a new
      // tester told to re-check work that belonged to a session which had already ended.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      staleState([UDID], -10)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
      expect(net.state(UDID)).toMatchObject({ reason: 'enforcement-lost' })

      await net.arm(UDID)

      expect(net.state(UDID)).not.toMatchObject({ reason: 'enforcement-lost' })
    })

    it('watches again after a disconnect and a reconnect', async () => {
      // `dispose()` is called when the agent loses the relay, and `connect()` is public and reuses the
      // same instance — so a one-way flag would leave the watcher off for the rest of the process and
      // the one report that invalidates a finished check would never come. Asserted as a positive:
      // without `resume` clearing the flag nothing fires and this times out.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      net.dispose()
      net.resume()

      staleState([UDID], -10)
      await vi.waitFor(() => expect(lost).toEqual([UDID]))
    })

    it('stops watching once nothing is offline', async () => {
      // The watcher is the first thing here that outlives a call, so it has to end on its own — and
      // a stale file after everything is back online is not an enforcement failure, it is a filter
      // with nothing to do.
      armed()
      const net = make()
      await net.setOffline(UDID, true)
      await net.setOffline(UDID, false)

      staleState([], -10)
      await new Promise((r) => setTimeout(r, 100))

      expect(lost).toEqual([])
    })
  })
})
