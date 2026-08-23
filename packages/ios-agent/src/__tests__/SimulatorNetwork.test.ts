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
function fakeHostBinary(dir: string, log: string): string {
  const path = join(dir, 'fake-filter-host')
  // `--offline` may be empty, which is how the rule is cleared; `${2-}` keeps that from failing.
  writeFileSync(
    path,
    `#!/bin/sh\nprintf 'rule:%s cond:%s\\n' "\${2-}" "$(ls "${dir}" | grep -c '^tapflow-offline-')" >> "${log}"\n`,
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

    it('forgets an offline device it is re-arming', async () => {
      armed()
      const net = make()
      await net.setOffline(UDID, true)

      await net.arm(UDID)

      // The device rebooted; whatever it was before, it is online now and the rule has to agree.
      expect(net.state(UDID).offline).toBe(false)
    })
  })

  describe('target', () => {
    it('names the app the hooks may touch', async () => {
      const net = make()
      await net.target(UDID, 'com.example.app')
      expect(env).toEqual([`${UDID}:TAPFLOW_TARGET_BUNDLE=com.example.app`])
    })
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
