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
  writeFileSync(
    path,
    `#!/bin/sh\n`
    + `[ -e "${dir}/BREAK" ] && exit 1\n`
    + (failNth > 0
      ? `N=$(cat "${dir}/runs" 2>/dev/null || echo 0); N=$((N+1)); echo $N > "${dir}/runs"\n`
        + `[ "$N" = "${failNth}" ] && exit 1\n`
      : '')
    + (sleepMs > 0 ? `printf 'enter:%s\\n' "\${2-}" >> "${log}"\nsleep ${sleepMs / 1000}\n` : '')
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

  const make = (hostBinary?: string) =>
    new SimulatorNetwork(simctl, {
      filterHostBinary: hostBinary ?? fakeHostBinary(dir, log),
      conditionDir: dir,
      verdictDir: dir,
      nethookDylib: '/fake/libtapflow-nethook.dylib',
    })

  /** The hooks reported themselves installed — the ordinary case for a device with an app running. */
  const armed = (udid = UDID) => writeFileSync(verdictPath(udid), JSON.stringify({ installed: true }))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tapflow-net-'))
    log = join(dir, 'calls.log')
    statusBar = []
    env = []
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

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

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

    expect(after).toEqual({ offline: true, available: false, reason: 'not-armed' })
    expect(net.state(UDID).offline).toBe(true)

    // **Only `.offline` is compared, and that is a known gap rather than an oversight** (#638).
    // `state()` never looks at the container app, so for this device — dylib fine, filter host gone —
    // it answers `available: true` in the same second the call above answered `false`. Asserting the
    // whole payload here would fail on that divergence, and hiding it behind a one-field read is what
    // a comment is for.
    //
    // The `reason` above is wrong for the same cause: `not-armed` prescribes a reboot, and a missing
    // container app is not something a reboot installs. Both need a reason member that does not exist
    // yet, which is two packages and #638's whole subject.
    expect(net.state(UDID).available).toBe(true)
  })

  it('does not report an online device as offline when the rule cannot be written', async () => {
    // The other direction of the same restore: a device that was online must not be left in the set
    // by a request that did not land.
    armed()
    const net = make()

    writeFileSync(join(dir, 'BREAK'), '')
    const after = await net.setOffline(UDID, true)

    expect(after).toEqual({ offline: false, available: false, reason: 'not-armed' })
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
      offline: false, available: false, reason: 'not-armed',
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

  it('treats an unreadable verdict as a failure, never as an install', () => {
    writeFileSync(verdictPath(UDID), '{ truncated')
    const net = make()
    expect(net.state(UDID)).toEqual({ offline: false, available: false, reason: 'hooks-not-installed' })
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
})
