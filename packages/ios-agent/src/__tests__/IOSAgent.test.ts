import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { ValidationError, PlatformError, MAX_CLIPBOARD_BYTES } from '@tapflowio/agent-core'
import { ClipboardTooLargeError } from '../SimctlWrapper.js'

// A live helper. Since #482 every write reports whether it reached the helper process and the
// agent acks on that answer, so the mock has to state it — returning undefined would model a
// helper that silently drops everything. `killHelper()` below flips one over to that state.
vi.mock('../TouchHelper', () => ({
  TouchHelper: vi.fn(function () { return ({
    start: vi.fn(),
    stop: vi.fn(),
    isReady: vi.fn(() => true),
    // The agent asks this when a write is refused, to tell "still starting" from "gone" — a mock
    // without it makes the ws dispatch swallow a TypeError and send no ack at all, which surfaces
    // as tests hanging with no message rather than failing.
    inputState: vi.fn(() => 'ready'),
    // Asked before readiness for a continuation frame: a gesture whose open never landed can never
    // be finished, however ready the helper becomes.
    ownsGesture: vi.fn(() => true),
    touchStart: vi.fn(() => true),
    touchMove: vi.fn(() => true),
    touchEnd: vi.fn(() => true),
    pressButton: vi.fn(() => true),
    pressButtonDown: vi.fn(() => true),
    pressButtonUp: vi.fn(() => true),
    pressLegacyButton: vi.fn(() => true),
    pinchStart: vi.fn(() => true),
    pinchMove: vi.fn(() => true),
    pinchEnd: vi.fn(() => true),
    sendKey: vi.fn(() => true),
  }) }),
}))

// The #482 state: the helper object is still there and the stream is still running, but its
// child process is gone, so every write is dropped.
function killHelper(th: Record<string, ReturnType<typeof vi.fn>>): void {
  for (const [name, fn] of Object.entries(th)) {
    if (name !== 'start' && name !== 'stop') fn.mockReturnValue(false)
  }
  th.inputState.mockReturnValue('unavailable')
  th.ownsGesture.mockReturnValue(false)
}

// Running but not yet injecting — measured at 186–247ms after spawn on a real simulator. Writes are
// refused exactly as on a dead channel, so only `inputState()` separates the two.
function startingHelper(th: Record<string, ReturnType<typeof vi.fn>>): void {
  killHelper(th)
  th.inputState.mockReturnValue('starting')
}

// Mock the capture streamer so codec-negotiation tests can read the codec arg the
// agent picked, without spawning the real helper binary. start() returns a stream
// that never closes — mirroring a live capture and avoiding the pump's restart loop.
vi.mock('../ScreenCaptureStreamer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ScreenCaptureStreamer')>()
  return {
    ...actual,
    ScreenCaptureStreamer: vi.fn(function () { return ({
      start: () => new ReadableStream({ start() {} }),
      requestKeyframe: vi.fn(),
    }) }),
  }
})

// Mock the audio path so the whole-sim tap can be asserted without building/launching the real helper
// or enumerating live processes. listen() resolves a fake port; frames() never closes (live capture).
vi.mock('../AudioCaptureStreamer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../AudioCaptureStreamer')>()
  return {
    ...actual,
    AudioCaptureStreamer: vi.fn(function () { return {
      listen: vi.fn().mockResolvedValue(54321),
      frames: () => new ReadableStream({ start() {} }),
      updatePids: vi.fn(),
      stop: vi.fn(),
    } }),
  }
})
// Build/launch/permission helper utils moved to the shared @tapflowio/audiotap-helper package.
vi.mock('@tapflowio/audiotap-helper', () => ({
  ensureHelperApp: vi.fn(() => '/fake/audiotap-helper.app'),
  launchAudioHelper: vi.fn(),
  isAudioSupported: vi.fn(() => true),
}))
vi.mock('../SimProcessTree', () => ({
  enumerateSimPids: vi.fn(() => [101, 102, 103]),
}))

import crypto from 'crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { RelayServer, initDb, closeDb, getDb } from '@tapflowio/relay'
import { IOSAgent } from '../IOSAgent'
import { ScreenCaptureStreamer } from '../ScreenCaptureStreamer'
import { AudioCaptureStreamer } from '../AudioCaptureStreamer'
import { launchAudioHelper } from '@tapflowio/audiotap-helper'
import { SimctlWrapper } from '../SimctlWrapper'
import { TouchHelper } from '../TouchHelper'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
const MockTouchHelper = vi.mocked(TouchHelper)
const MockAudioStreamer = vi.mocked(AudioCaptureStreamer)
const mockLaunchAudioHelper = vi.mocked(launchAudioHelper)

// Test-only view of IOSAgent internals (reconnect state lives behind private fields).
interface IOSAgentInternals {
  ws: WebSocket | null
  _stopping: boolean
  _reconnectTimer: ReturnType<typeof setTimeout> | null
  _reconnectAttempt: number
  _scheduleReconnect(): void
}
const internals = (agent: IOSAgent): IOSAgentInternals => agent as unknown as IOSAgentInternals

// HID usage codes from KeyCodeMap (duplicated here so tests are self-contained)
const HID_BACKSPACE = 0x2A
const HID_KEY_A = 0x04


let pasteboard = ''
const isSentinelish = (v: string): boolean => v.startsWith('\u200Btapflow-clipboard-')
// How long the simulator takes to actually show a written pasteboard. `pbcopy` exiting means
// accepted, not visible — the read path must not assume otherwise.
let pasteboardApplyDelayMs = 0
/** Simulate the app reacting to an injected copy chord by writing to the pasteboard. `afterMs`
 *  models the real gap between injecting HID and the app actually copying — with 0 the write is
 *  synchronous, which would mask any read-too-early bug. */
const copyOnChord = (th: { sendKey: ReturnType<typeof vi.fn> }, text = 'copied text', afterMs = 0) =>
  th.sendKey.mockImplementation(() => {
    if (afterMs > 0) setTimeout(() => { pasteboard = text }, afterMs)
    else pasteboard = text
  })

// `booted` stays boolean for the callers that only care about on/off. `'unknown'` is what
// `toDeviceStatus` returns for every transient state — Booting, Shutting Down, Creating — and
// `simctl erase` refuses all of them, so it needs to be reachable from a test.
/** Two registered simulators, both shut down. The relay opens a session per registered device, so
 *  this is what an ordinary Mac looks like — `mockSimctl`'s single device makes "the session's
 *  device" and "the first registered device" indistinguishable, which is the whole defect. */
function mockSimctlTwoDevices(): SimctlWrapper {
  const sw = mockSimctl(false)
  ;(sw.listDevices as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.3' },
    { id: 'dev-2', name: 'iPhone 16', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.3' },
  ])
  return sw
}

function mockSimctl(booted: boolean | 'unknown' = false): SimctlWrapper {
  const status = booted === 'unknown' ? 'unknown' : booted ? 'booted' : 'shutdown'
  pasteboard = ''
  pasteboardApplyDelayMs = 0
  const sw = {
    listDevices: vi.fn().mockResolvedValue([
      { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status, osVersion: 'iOS 18.3' },
    ]),
    boot: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    erase: vi.fn().mockResolvedValue(undefined),
    uninstallApp: vi.fn().mockResolvedValue(undefined),
    clearAppData: vi.fn().mockResolvedValue(undefined),
    // Absent until L5 added the first `open-url` tests — which is why the handler had none.
    openUrl: vi.fn().mockResolvedValue(undefined),
    installApp: vi.fn().mockResolvedValue(undefined),
    launchApp: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    syncKeyboardsFromLanguages: vi.fn().mockResolvedValue(undefined),
    showSoftwareKeyboard: vi.fn().mockResolvedValue(undefined),
    hideSoftwareKeyboard: vi.fn().mockResolvedValue(undefined),
    // Stateful pasteboard: the agent confirms a write by reading it back, so a mock that
    // always answers '' would never converge.
    setPasteboard: vi.fn(async function (this: void, _d: string, t: string) {
      if (pasteboardApplyDelayMs > 0) setTimeout(() => { pasteboard = t }, pasteboardApplyDelayMs)
      else pasteboard = t
    }),
    getPasteboard: vi.fn(async () => pasteboard),
    stopKeyboardDaemon: vi.fn(),
  } as unknown as SimctlWrapper
  // `handleDeviceBoot` awaits this before it announces readiness (#486). The real one polls
  // `listDevices` until the device reports `booted`, so the double reads the same list — a test that
  // rewrites it (`mockSimctlTwoDevices`, and the per-test `mockResolvedValue` overrides) then gets
  // the device the agent actually asked for rather than a fixture pinned here. It answers `booted`
  // because that is the only status the poll returns on; the polling itself, its deadline, its grace
  // for a settled device and its `isStale` signal are all covered in `SimctlWrapper.test.ts`, which
  // drives real transitions through the runner.
  //
  // **`opts.isStale` is deliberately ignored here.** This double does not poll, so there is nothing
  // to cancel — and the agent-side claim worth testing is the other guard: the `bootSeq` re-check on
  // the far side of the wait, which only runs once the wait returns.
  //
  // One caller does not get the shared list: `{ ...mockSimctl(false), listDevices: … }` spreads the
  // object, and the copy's `waitUntilBooted` still closes over the original `sw`. That test does not
  // boot, and the failure mode if one did would be a loud `device:boot-error`, not a silent pass.
  sw.waitUntilBooted = vi.fn(async (deviceId: string, _opts?: { isStale?: () => boolean }) => {
    const device = (await sw.listDevices()).find((d) => d.id === deviceId)
    if (!device) throw new PlatformError(`Device ${deviceId} did not finish booting`)
    return { ...device, status: 'booted' as const }
  })
  return sw
}

describe('IOSAgent', () => {
  let relay: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-ios-test-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(async () => {
    relay = new RelayServer({ port: 0 })
    await relay.start()
    port = (relay.address() as { port: number }).port
  })

  afterEach(async () => {
    await relay.stop()
  })

  // CodeRabbit #272 ⑥ — 직접 인스턴스화 시 비-macOS에서 일찍 명확히 실패한다 (AGENTS.md 규칙)
  describe('platform guard', () => {
    it('비-macOS + simctl 미주입(실제 런타임 경로)은 throw', () => {
      const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
      expect(() => new IOSAgent()).toThrow(/macOS/)
      spy.mockRestore()
    })

    it('비-macOS여도 simctl 주입(테스트/모킹 경로)은 허용', () => {
      const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
      expect(() => new IOSAgent({}, mockSimctl())).not.toThrow()
      spy.mockRestore()
    })
  })

  describe('DeviceAgent delegation', () => {
    it('listDevices delegates to SimctlWrapper', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      const devices = await agent.listDevices()
      expect(simctl.listDevices).toHaveBeenCalled()
      expect(devices[0].platform).toBe('ios')
    })

    it('boot delegates to SimctlWrapper', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await agent.boot('dev-1')
      expect(simctl.boot).toHaveBeenCalledWith('dev-1')
    })

    it('shutdown delegates to SimctlWrapper', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await agent.shutdown('dev-1')
      expect(simctl.shutdown).toHaveBeenCalledWith('dev-1')
    })

    // The DeviceAgent interface carries no device (it is shared with Android and predates
    // multi-session agents), so these resolve the one live session — or refuse. Refusing beats
    // falling through to simctl's `booted` alias, which would act on whichever simulator is up.
    it('installApp refuses when no session is open', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await expect(agent.installApp('/path/MyApp.app')).rejects.toThrow(/no booted device/)
      expect(simctl.installApp).not.toHaveBeenCalled()
    })

    it('launchApp refuses when no session is open', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await expect(agent.launchApp('com.example.app')).rejects.toThrow(/no booted device/)
      expect(simctl.launchApp).not.toHaveBeenCalled()
    })

    it('screenshot refuses when no session is open', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await expect(agent.screenshot()).rejects.toThrow(/no booted device/)
      expect(simctl.screenshot).not.toHaveBeenCalled()
    })

    // installBuild: extract .app.zip / .tar.gz to a temp dir, then simctl install the .app.
    // The real simulator install+launch (fidelity/exec-bit) is manual QA; here we verify the
    // archive branch resolves the .app path via mocked simctl.
    type WithInstallBuild = { installBuild(udid: string, filePath: string, bundleId?: string): Promise<void> }
    const makeSimAppArchive = (name: string, ext: string): string => {
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-arch-src-'))
      const appDir = path.join(src, `${name}.app`)
      fs.mkdirSync(appDir, { recursive: true })
      fs.writeFileSync(path.join(appDir, 'Info.plist'), '<plist><dict/></plist>')
      fs.writeFileSync(path.join(appDir, name), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))
      const out = path.join(src, `${name}${ext}`)
      if (ext.includes('tar') || ext.includes('tgz')) {
        spawnSync('tar', ['-czf', out, '-C', src, `${name}.app`])
      } else {
        spawnSync('zip', ['-r', out, `${name}.app`], { cwd: src })
      }
      return out
    }

    it('installBuild extracts a .tar.gz and installs the .app (R4)', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl) as unknown as WithInstallBuild
      const tarPath = makeSimAppArchive('TarApp', '.tar.gz')
      await agent.installBuild('dev-1', tarPath)
      expect(simctl.installApp).toHaveBeenCalledTimes(1)
      expect((simctl.installApp as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/\/TarApp\.app$/)
    })

    it('installBuild supports the .tgz extension', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl) as unknown as WithInstallBuild
      const tarPath = makeSimAppArchive('TgzApp', '.tgz')
      await agent.installBuild('dev-1', tarPath)
      expect((simctl.installApp as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/\/TgzApp\.app$/)
    })

    it('installBuild still handles legacy .app.zip (regression)', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl) as unknown as WithInstallBuild
      const zipPath = makeSimAppArchive('ZipApp', '.app.zip')
      await agent.installBuild('dev-1', zipPath)
      expect((simctl.installApp as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/\/ZipApp\.app$/)
    })

    it('installBuild rejects a tar.gz with no .app directory', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl) as unknown as WithInstallBuild
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-arch-noapp-'))
      fs.writeFileSync(path.join(src, 'readme.txt'), 'hi')
      const out = path.join(src, 'noapp.tar.gz')
      spawnSync('tar', ['-czf', out, '-C', src, 'readme.txt'])
      await expect(agent.installBuild('dev-1', out)).rejects.toThrow(/\.app/)
      expect(simctl.installApp).not.toHaveBeenCalled()
    })

    it('installBuild throws a validation error on a corrupt .tar.gz (bad archive, not a spawn failure)', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl) as unknown as WithInstallBuild
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-arch-bad-'))
      const out = path.join(src, 'corrupt.tar.gz')
      fs.writeFileSync(out, Buffer.from('not a real gzip stream'))
      await expect(agent.installBuild('dev-1', out)).rejects.toThrow(/압축 해제 실패/)
      expect(simctl.installApp).not.toHaveBeenCalled()
    })

    it('launchApp refuses when no session is open (interface path)', async () => {
      const simctl = mockSimctl()
      const agent = new IOSAgent({}, simctl)
      await expect(agent.launchApp('com.example.app')).rejects.toThrow(/no booted device/)
      expect(simctl.launchApp).not.toHaveBeenCalled()
    })

    it('stream throws ValidationError before any device session is available', () => {
      const agent = new IOSAgent({}, mockSimctl())
      expect(() => agent.stream()).toThrow(ValidationError)
    })
  })

  describe('power assertion', () => {
    it('acquires on connect and releases on disconnect', async () => {
      const sleepBlocker = { acquire: vi.fn(), release: vi.fn() }
      const agent = new IOSAgent({ sleepBlocker }, mockSimctl())
      await agent.connect(`ws://localhost:${port}`)
      expect(sleepBlocker.acquire).toHaveBeenCalled()
      expect(sleepBlocker.release).not.toHaveBeenCalled()
      agent.disconnect()
      expect(sleepBlocker.release).toHaveBeenCalled()
    })
  })

  describe('input setup — lazy TouchHelper on a null-helper booted session (followups H-E)', () => {
    beforeEach(() => { MockTouchHelper.mockClear() })

    // A reconnect clears+re-registers deviceStates with touchHelper=null while the sim stays booted (IOSAgent _scheduleReconnect → initDeviceStates); input must self-heal without a fresh device:boot. These tests drive that null-helper-on-booted-sim state directly — skipping device:boot is intentional, since booting would create the helper and bypass the lazy path under test.
    async function joinBootlessSession() {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true)) // sim booted, session has touchHelper=null (no device:boot)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      MockTouchHelper.mockClear()
      return { browser, agent }
    }

    // The socket boundary requires a string `sessionId` before dispatching, and that is what lets the
    // dispatcher declare it required — which removed 25 `msg.sessionId!` assertions. Without a test the guard
    // could be deleted and nothing would notice until one of those `!` was needed again.
    //
    // Driven by emitting on the agent's own socket rather than sending through the relay, because **the relay
    // already blocks this**: its forward gate resolves `sessions.get(msg.sessionId)` and answers the browser
    // itself for a terminal input, so a frame with no sessionId never reaches an agent by that path. That is
    // the same fact the required declaration rests on — and it means the guard exists for a client that
    // connects to the agent directly, which no relay-level test can simulate. Two earlier versions of this
    // test went through the relay and passed the mutation for exactly that reason.
    it('does not dispatch a frame with no sessionId', async () => {
      const { browser, agent } = await joinBootlessSession()
      const ws = internals(agent).ws
      const sent = vi.spyOn(ws, 'send')

      for (const frame of [
        { type: 'input:touch:end', requestId: 'rq-in1', payload: { x: 0.4, y: 0.6 } },
        { type: 'input:touch:end', requestId: 'rq-in2', sessionId: 42, payload: { x: 0.4, y: 0.6 } },
      ]) ws.emit('message', Buffer.from(JSON.stringify(frame)))

      const answers = () => sent.mock.calls
        .map(([f]) => JSON.parse(String(f)) as { type: string })
        .filter((m) => m.type === 'input:error' || m.type === 'input:done')
      expect(answers()).toEqual([])

      // A well-formed frame on the same path is still dispatched, so the guard is not rejecting everything.
      ws.emit('message', Buffer.from(JSON.stringify(
        { type: 'input:touch:end', requestId: 'rq-in3', sessionId: agent.sessionId, payload: { x: 0.4, y: 0.6 } },
      )))
      await vi.waitFor(() => expect(answers()).toHaveLength(1), { timeout: 500 })

      agent.disconnect()
      browser.close()
    })

    it('lazily creates TouchHelper when input arrives with no device:boot for the session', async () => {
      const { browser, agent } = await joinBootlessSession()

      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.4, y: 0.6 } }))

      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(1), { timeout: 500 })
      const th = MockTouchHelper.mock.results[0].value
      expect(th.start).toHaveBeenCalled()
      expect(th.touchStart).toHaveBeenCalledWith(0.4, 0.6)

      agent.disconnect()
      browser.close()
    })

    // A tap is start + end (two messages); sync setup lets the end see the helper the start created (async would drop touchEnd → stuck finger).
    it('keeps touch start/end paired through lazy setup (no stuck finger)', async () => {
      const { browser, agent } = await joinBootlessSession()

      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in4', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))

      await vi.waitFor(() => {
        expect(MockTouchHelper.mock.results).toHaveLength(1)
        const th = MockTouchHelper.mock.results[0].value
        expect(th.touchStart).toHaveBeenCalledTimes(1)
        expect(th.touchEnd).toHaveBeenCalledTimes(1)
      }, { timeout: 500 })

      agent.disconnect()
      browser.close()
    })
  })

  describe('input acks (followups H-F)', () => {
    beforeEach(() => { MockTouchHelper.mockClear() })

    it('acks input:done after a tap on a booted session', async () => {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-1', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      const done = waitForType(browser, 'input:done')
      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in5', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      const ack = await done
      expect(ack.sessionId).toBe(agent.sessionId)
      // L5c. The ack must carry **the terminal frame's** id, and nothing else here would say so: replacing
      // the echo with a literal left all 382 tests passing in the mutation round. `#499` is what an
      // unattributed ack costs — a late one is consumed by the next input's waiter, which then reports the
      // previous input's outcome, including reporting an unanswered input as landed.
      expect(ack.requestId).toBe('rq-in5')

      agent.disconnect()
      browser.close()
    })

    it('acks input:error after the device is shut down (booted then shutdown)', async () => {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const simctl = mockSimctl(true)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      // Boot first (per the device:boot guideline → booted flag true, TouchHelper set up).
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-2', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      // Power the device off: shutdown clears the booted flag, and simctl now reports it shut down.
      ;(simctl.listDevices as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.3' },
      ])
      browser.send(JSON.stringify({ type: 'device:shutdown', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:shutdown-done')

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in6', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      const e = await errored
      expect(e.sessionId).toBe(agent.sessionId)
      expect(e.message).toBe('device not booted')
      // The **error** half of `ackInput`, and it needs its own assertion: the `input:done` line above is
      // pinned one test up, and a literal on this line survived the whole suite in review. Worse than a
      // hang, too — `awaitInputAck` drops an unmatched reply into its catch, and on a session that is not
      // yet strict that path resolves *optimistically*. So a device failure the agent stated plainly would
      // be reported to the caller as success: #457 restored for exactly the frames that carry the failure.
      expect(e.requestId).toBe('rq-in6')

      agent.disconnect()
      browser.close()
    })

    // A terminal input naming a session this agent holds no state for. Nothing used to answer it —
    // `if (!state) break` — so the caller waited out its own timeout, which its fallback then
    // reported as success. Reachability is genuinely disputed (see `ackNoSession`'s comment), which
    // is why the state is manufactured here rather than driven through a relay sequence: the only
    // shape that produces it needs the relay to hold two sessions for one device, and this suite
    // cannot stand that up. What the test pins is the answer, not the route to it.
    // Asserted on what the agent sends rather than on what reaches the browser, for the same reason
    // the Android suite does: the relay answers these types on an agent's behalf when the socket is
    // down, so a round trip would risk testing the relay's fallback instead of this branch.
    describe('terminal inputs for a session whose state is gone (#489)', () => {
      async function connectedAgent() {
        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
        await agent.connect(`ws://localhost:${port}`)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        await waitForType(browser, 'session:joined')
        return { agent, browser }
      }

      type Internals = {
        ws: WebSocket
        deviceStates: Map<string, unknown>
        handleRelayMessage(msg: { type: string; sessionId?: string; requestId?: string; payload?: unknown }): void
      }
      const internals = (a: IOSAgent): Internals => a as unknown as Internals

      function inputErrors(spy: ReturnType<typeof vi.spyOn>) {
        return spy.mock.calls
          .map(([raw]) => JSON.parse(raw as string) as { type: string; sessionId?: string; requestId?: string; message?: string; reason?: string })
          .filter((m) => m.type === 'input:error')
      }

      for (const [type, payload] of [
        ['input:touch:end', { x: 0.5, y: 0.5 }],
        ['input:pinch:end', { f0: { x: 0.5, y: 0.5 }, f1: { x: 0.5, y: 0.5 } }],
        ['input:button', { name: 'home' }],
        ['input:key', { code: 'KeyA' }],
      ] as Array<[string, Record<string, unknown>]>) {
        it(`answers input:error with reason channel-unavailable for ${type}`, async () => {
          const { agent, browser } = await connectedAgent()
          // Captured first: `sessionId` is derived from `deviceStates`, so clearing the map would
          // also make the id null and the ack would have nothing to address.
          const sessionId = agent.sessionId
          const sent = vi.spyOn(internals(agent).ws, 'send')
          internals(agent).deviceStates.clear()

          internals(agent).handleRelayMessage({ type, sessionId: sessionId!, requestId: 'rq-gone', payload })

          const acks = inputErrors(sent)
          expect(acks).toHaveLength(1)
          expect(acks[0]!.sessionId).toBe(sessionId)
          expect(acks[0]!.reason).toBe('channel-unavailable')
          // `ackNoSession` is the one reply path with no `state` to hang anything on, so the correlator has
          // to arrive as an argument. A literal there survived the whole suite in the mutation round.
          expect(acks[0]!.requestId).toBe('rq-gone')

          agent.disconnect()
          browser.close()
        })
      }

      it('stays silent for an opening frame — those carry no ack obligation', async () => {
        const { agent, browser } = await connectedAgent()
        const sessionId = agent.sessionId
        const sent = vi.spyOn(internals(agent).ws, 'send')
        internals(agent).deviceStates.clear()

        internals(agent).handleRelayMessage({ type: 'input:touch:start', sessionId: sessionId!, payload: { x: 0.5, y: 0.5 } })

        expect(inputErrors(sent)).toHaveLength(0)

        agent.disconnect()
        browser.close()
      })
    })
  })

  // #482: the helper process dies, the session keeps streaming, and every input is dropped.
  // The agent used to ack on `state.touchHelper !== null` — the wrapper object, which is still
  // there — so the caller was told each dropped input had been delivered.
  describe('input acks when the helper process has died (#482)', () => {
    beforeEach(() => { MockTouchHelper.mockClear() })

    async function bootedSession(simctl = mockSimctl(true)) {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-3', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      // device:ready is not a sync point for the helper — wait on the mock itself.
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      return { browser, agent, simctl, th: MockTouchHelper.mock.results[0].value }
    }

    // A refusal from a *ready* helper is the gesture-ownership guard: the channel is fine and the
    // message is well-formed, but this frame's gesture is gone, so the caller has to open a new one
    // rather than retry or give up.
    it('answers no-gesture when a ready helper refuses a mid-gesture frame', async () => {
      const { browser, agent, th } = await bootedSession()
      th.touchEnd.mockReturnValue(false)
      th.ownsGesture.mockReturnValue(false)

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in7', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))

      expect((await errored)['reason']).toBe('no-gesture')

      agent.disconnect()
      browser.close()
    })

    // The inverted advice both design reviews found: an opening frame refused inside the start-up
    // window owns nothing, so by the time the terminal frame arrives the helper reads `ready` and the
    // ack used to say "never retry" — for the exact sequence `channel-starting` exists to serve.
    // MCP's `swipe` defaults to 300ms, comfortably past the measured 247ms, so it lands here.
    it('answers no-gesture, not malformed, when the gesture opened inside the start-up window', async () => {
      const { browser, agent, th } = await bootedSession()
      startingHelper(th)
      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))

      // the helper finishes starting between the two frames
      th.inputState.mockReturnValue('ready')
      th.ownsGesture.mockReturnValue(false) // nothing was owned: the open was refused

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in8', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))

      const msg = await errored
      expect(msg['reason']).toBe('no-gesture')
      expect(msg['message']).toContain('start a new one')

      agent.disconnect()
      browser.close()
    })

    // A standalone input never consults ownership — only a continuation does.
    it('answers channel-starting for a key while the helper is coming up', async () => {
      const { browser, agent, th } = await bootedSession()
      startingHelper(th)

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in9', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))

      expect((await errored)['reason']).toBe('channel-starting')

      agent.disconnect()
      browser.close()
    })

    it('carries reason channel-unavailable when the helper is gone', async () => {
      const { browser, agent, th } = await bootedSession()
      killHelper(th)

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in10', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))

      const msg = await errored
      // No channel at all outranks "no gesture": re-opening one could not help.
      expect(msg['reason']).toBe('channel-unavailable')
      expect(msg['message']).toBe('input channel not ready') // wording preserved for consumers

      agent.disconnect()
      browser.close()
    })

    it('carries reason unsupported for an unknown key code, keeping the code in the prose', async () => {
      const { browser, agent } = await bootedSession()

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in11', sessionId: agent.sessionId, payload: { code: 'KeyNope', modifiers: 0 } }))

      const msg = await errored
      expect(msg['reason']).toBe('unsupported')
      expect(msg['message']).toBe('unknown key code: KeyNope')

      agent.disconnect()
      browser.close()
    })

    it('answers input:error for a tap the dead helper dropped', async () => {
      const { browser, agent, th } = await bootedSession()
      killHelper(th)

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in12', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))

      // The device is still booted — this is the input channel failing, not the device.
      expect((await errored).message).toBe('input channel not ready')

      agent.disconnect()
      browser.close()
    })

    it('answers input:error for a pinch the dead helper dropped', async () => {
      const { browser, agent, th } = await bootedSession()
      killHelper(th)

      const errored = waitForType(browser, 'input:error')
      const f0 = { x: 0.2, y: 0.2 }, f1 = { x: 0.8, y: 0.8 }
      browser.send(JSON.stringify({ type: 'input:pinch:start', sessionId: agent.sessionId, payload: { f0, f1 } }))
      browser.send(JSON.stringify({ type: 'input:pinch:end', requestId: 'rq-in13', sessionId: agent.sessionId, payload: { f0, f1 } }))
      expect((await errored).message).toBe('input channel not ready')

      agent.disconnect()
      browser.close()
    })

    it('answers input:done again once the helper has recovered, without a reconnect', async () => {
      const { browser, agent, th } = await bootedSession()
      killHelper(th)
      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in14', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      await errored

      // TouchHelper respawns itself, so the session heals in place — the same object starts
      // reporting delivery again. Nothing re-issues the session.
      th.touchEnd.mockReturnValue(true)
      th.isReady.mockReturnValue(true)

      const done = waitForType(browser, 'input:done')
      browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in15', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      expect((await done).sessionId).toBe(agent.sessionId)

      agent.disconnect()
      browser.close()
    })

    it('answers input:error for a button the dead helper dropped', async () => {
      const { browser, agent, th } = await bootedSession()
      killHelper(th)

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:button', requestId: 'rq-in16', sessionId: agent.sessionId, payload: { name: 'home' } }))
      expect((await errored).message).toBe('input channel not ready')

      agent.disconnect()
      browser.close()
    })

    // The two branches that deliberately write nothing answer with the channel's health. Both
    // directions need pinning: a seed of `false` invents a failure on a healthy channel, and a
    // seed of `true` is the silent success this whole issue is about.
    const noWriteBranches: Array<[string, Record<string, unknown>]> = [
      ['a home press-down', { name: 'home', phase: 'down' }],
      // `mockSimctl` reports no typeId, so DeviceChromeLoader finds nothing and `loadedChrome`
      // stays null for this whole suite — this pair covers the "no chrome button matched" branch.
      // The narrower `usagePage > 0 && usage > 0` sub-guard inside it is unreached here and
      // untested; it predates this change.
      ['a button with no chrome entry', { name: 'volume-up' }],
    ]

    for (const [label, payload] of noWriteBranches) {
      it(`does not invent a failure for ${label} on a healthy channel`, async () => {
        const { browser, agent, th } = await bootedSession()

        const done = waitForType(browser, 'input:done')
        browser.send(JSON.stringify({ type: 'input:button', requestId: 'rq-in17', sessionId: agent.sessionId, payload }))
        expect((await done).sessionId).toBe(agent.sessionId)
        expect(th.pressLegacyButton).not.toHaveBeenCalled()
        expect(th.pressButtonDown).not.toHaveBeenCalled()

        agent.disconnect()
        browser.close()
      })

      it(`does not claim success for ${label} on a dead channel`, async () => {
        const { browser, agent, th } = await bootedSession()
        killHelper(th)

        const errored = waitForType(browser, 'input:error')
        browser.send(JSON.stringify({ type: 'input:button', requestId: 'rq-in18', sessionId: agent.sessionId, payload }))
        expect((await errored).message).toBe('input channel not ready')

        agent.disconnect()
        browser.close()
      })
    }

    it('answers input:error for a key the dead helper dropped', async () => {
      const { browser, agent, th } = await bootedSession()
      killHelper(th)

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in19', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
      expect((await errored).message).toBe('input channel not ready')

      agent.disconnect()
      browser.close()
    })

    // The deferred branch had no test that drove it with a *starting* helper, so the reason there
    // could be replaced with the constant `channel-unavailable` and everything stayed green — losing
    // exactly the distinction this change exists to make, for every key pressed while the software
    // keyboard is up.
    it('reasons about the channel in the deferred key branch, not just in the direct one', async () => {
      const { browser, agent, simctl, th } = await bootedSession()
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await waitForType(browser, 'keyboard:toggled')
      startingHelper(th)

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in20', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))

      const msg = await errored
      expect(msg['reason']).toBe('channel-starting')
      expect(simctl.hideSoftwareKeyboard).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

    it('answers input:error for a key deferred behind hiding the software keyboard', async () => {
      // The branch the ack used to race: the chord is sent inside the hide's continuation, so
      // acking beside it answered before the key had been written at all.
      const { browser, agent, simctl, th } = await bootedSession()
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await waitForType(browser, 'keyboard:toggled')
      killHelper(th)

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in21', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
      expect((await errored).message).toBe('input channel not ready')
      expect(simctl.hideSoftwareKeyboard).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

    it('stops a helper that input created while a boot was still in flight', async () => {
      // handleDeviceBoot clears the helper up front and then awaits simctl. An input arriving
      // inside that window builds a fresh one through ensureTouchHelper, and sendChromeData
      // later replaces it. That used to leak one child process; now the orphan revives itself
      // for the life of the agent with nothing left holding a reference to stop it.
      const simctl = mockSimctl(false)
      let releaseBoot = (): void => {}
      ;(simctl.boot as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise<void>((resolve) => { releaseBoot = () => resolve() }),
      )
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const booting = waitForType(browser, 'device:booting')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-4', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await booting
      await vi.waitFor(() => expect(simctl.boot).toHaveBeenCalled(), { timeout: 500 })

      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(1), { timeout: 500 })
      const orphan = MockTouchHelper.mock.results[0].value

      const ready = waitForType(browser, 'device:ready')
      releaseBoot()
      await ready
      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(2), { timeout: 1000 })

      expect(orphan.stop).toHaveBeenCalled()

      agent.disconnect()
      browser.close()
    })

    it('does not install a helper onto a state that a reconnect has already dropped', async () => {
      // What `cleanupDeviceState`'s bootSeq bump is actually for. A boot awaiting simctl holds its
      // own reference to the state, and `_scheduleReconnect`'s `deviceStates.clear()` does not
      // reach it. `sendChromeData`'s `!this.ws` guard covers the window only until the reconnect
      // completes — after that the socket is live again and the abandoned boot goes on to build a
      // TouchHelper nobody owns, which a self-reviving helper would keep respawning for the life
      // of the agent with nothing left to stop it.
      //
      // Driving the reconnect is the whole point: an `agent.disconnect()` version of this test
      // passes with the bump deleted, because ws stays null forever and the guard above catches it.
      const simctl = mockSimctl(false)
      let releaseBoot = (): void => {}
      ;(simctl.boot as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise<void>((resolve) => { releaseBoot = () => resolve() }),
      )
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50, reconnectDelays: [20] }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const booting = waitForType(browser, 'device:booting')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-5', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await booting
      await vi.waitFor(() => expect(simctl.boot).toHaveBeenCalled(), { timeout: 500 })
      expect(MockTouchHelper.mock.results).toHaveLength(0)

      // Drop the relay and bring it back on the same port so the agent's own reconnect runs.
      browser.close()
      await relay.stop()
      relay = new RelayServer({ port })
      await relay.start()
      const rejoined = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(rejoined)
      // A join only succeeds once the agent has re-registered, so this is the barrier that says
      // the socket is live again — and therefore that `!this.ws` no longer guards anything.
      let joined = null
      for (let i = 0; i < 20 && joined === null; i++) {
        rejoined.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        joined = await waitForTypeOrNull(rejoined, 'session:joined', 150)
      }
      expect(joined).not.toBeNull()

      // The abandoned boot returns at the seq check that follows `simctl.boot`, before it reaches
      // `waitUntilBooted` — so no further `listDevices` happening is the assertion. No sleep, and it
      // fails if the bump is removed (the boot then runs on and builds the helper). `setImmediate`
      // drains the microtask queue, which is all the guarded path needs to reach its early return.
      //
      // The extra reading it would make is now the double's, not the handler's: `mockSimctl`'s
      // `waitUntilBooted` reads the shared list to answer with the right device. That keeps this
      // assertion working, but the `MockTouchHelper` check below is the one that does not depend on
      // how the double is written. The later seq check — the one on the far side of the wait — is a
      // different guard with its own test in `device:boot handler`.
      const listCallsBeforeRelease = (simctl.listDevices as ReturnType<typeof vi.fn>).mock.calls.length
      releaseBoot()
      await new Promise((r) => setImmediate(r))

      expect(simctl.listDevices).toHaveBeenCalledTimes(listCallsBeforeRelease)
      expect(MockTouchHelper.mock.results).toHaveLength(0)

      agent.disconnect()
      rejoined.close()
    })

    it('answers input:type-error when the paste chord is dropped', async () => {
      // No pasteboard deadline guards this path, unlike the copy in clipboard:read — the text
      // lands on the device clipboard and nothing reaches the app under test.
      const { browser, agent, th } = await bootedSession()
      killHelper(th)

      const errored = waitForType(browser, 'input:type-error')
      browser.send(JSON.stringify({ type: 'input:type', requestId: 'rq-in22', sessionId: agent.sessionId, payload: { text: 'hello' } }))
      const e = await errored
      expect(e.message).toContain('no input channel')
      // All three `input:type-*` producers here took a literal in the mutation round with nothing failing.
      // The client tests that echo it echo it correctly, so a predicate that stopped checking matched either
      // way — which is what makes an assertion at the producer the only real one.
      expect(e.requestId).toBe('rq-in22')

      agent.disconnect()
      browser.close()
    })
  })

  describe('pinch relay messages', () => {
    beforeEach(() => { MockTouchHelper.mockClear() })

    async function setupPinchSession() {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)

      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)

      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-6', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      // device:ready is sent as the stream is handed off, which is not the same instant the helper
      // becomes observable — wait for the helper itself. (A vi.fn call log never lags.)
      // The relay used to replay a device:ready for any already-booted session too, which could
      // latch an ack belonging to no boot; that is fixed, but this wait is still the right shape.
      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(1), { timeout: 500 })
      const thInstance = MockTouchHelper.mock.results[0].value
      return { browser, agent, thInstance }
    }

    it('input:type sets the pasteboard then pastes with Cmd+V', async () => {
      const simctl = mockSimctl(true)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-7', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(1), { timeout: 500 })
      const thInstance = MockTouchHelper.mock.results[0].value

      // register the ack listener before sending — the done can arrive before
      // the assertions below finish awaiting
      const done = waitForType(browser, 'input:type-done')
      browser.send(JSON.stringify({ type: 'input:type', requestId: 'rq-in23', sessionId: agent.sessionId, payload: { text: '안녕 hi' } }))
      // the ack must arrive AFTER the work completed — so once done lands, the
      // pasteboard write and Cmd+V (KeyV 0x19, MetaLeft 0x08) are already done.
      // (a synchronous check here, not waitFor, so moving .then(done) ahead of
      // the paste would fail this test — the ordering is what's under guard)
      const ack = await done
      expect(ack.sessionId).toBe(agent.sessionId)
      expect(ack.requestId).toBe('rq-in23')
      expect(simctl.setPasteboard).toHaveBeenCalledWith('dev-1', '안녕 hi')
      expect(thInstance.sendKey).toHaveBeenCalledWith(0x19, 0x08)

      agent.disconnect()
      browser.close()
    })

    it('input:type hides the software keyboard first when it is visible', async () => {
      const simctl = mockSimctl(true)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-8', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(1), { timeout: 500 })

      // bring the software keyboard up first
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await waitForType(browser, 'keyboard:toggled')

      const typed = waitForType(browser, 'input:type-done')
      browser.send(JSON.stringify({ type: 'input:type', requestId: 'rq-in24', sessionId: agent.sessionId, payload: { text: 'hi' } }))
      await typed
      // hidden before the Cmd+V chord (mirrors the input:key guard)
      expect(simctl.hideSoftwareKeyboard).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

    it('input:pinch:start calls touchHelper.pinchStart', async () => {
      const { browser, agent, thInstance } = await setupPinchSession()
      browser.send(JSON.stringify({
        type: 'input:pinch:start',
        sessionId: agent.sessionId,
        payload: { f0: { x: 0.3, y: 0.5 }, f1: { x: 0.7, y: 0.5 } },
      }))
      await vi.waitFor(() => expect(thInstance.pinchStart).toHaveBeenCalledWith(0.3, 0.5, 0.7, 0.5), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    it('input:pinch:move calls touchHelper.pinchMove', async () => {
      const { browser, agent, thInstance } = await setupPinchSession()
      browser.send(JSON.stringify({
        type: 'input:pinch:move',
        sessionId: agent.sessionId,
        payload: { f0: { x: 0.2, y: 0.5 }, f1: { x: 0.8, y: 0.5 } },
      }))
      await vi.waitFor(() => expect(thInstance.pinchMove).toHaveBeenCalledWith(0.2, 0.5, 0.8, 0.5), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    it('input:pinch:end calls touchHelper.pinchEnd', async () => {
      const { browser, agent, thInstance } = await setupPinchSession()
      browser.send(JSON.stringify({ type: 'input:pinch:end', requestId: 'rq-in25', sessionId: agent.sessionId }))
      await vi.waitFor(() => expect(thInstance.pinchEnd).toHaveBeenCalled(), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    // home has no HID down/up split — a down+up pair from the dashboard must not fire it twice.
    it('input:button home (no phase) presses the legacy button once', async () => {
      const { browser, agent, thInstance } = await setupPinchSession()
      browser.send(JSON.stringify({ type: 'input:button', requestId: 'rq-in26', sessionId: agent.sessionId, payload: { name: 'home' } }))
      await vi.waitFor(() => expect(thInstance.pressLegacyButton).toHaveBeenCalledWith(0), { timeout: 500 })
      expect(thInstance.pressLegacyButton).toHaveBeenCalledTimes(1)
      agent.disconnect()
      browser.close()
    })

    it('input:button home fires only on the up phase, not on down', async () => {
      const { browser, agent, thInstance } = await setupPinchSession()
      browser.send(JSON.stringify({ type: 'input:button', requestId: 'rq-in27', sessionId: agent.sessionId, payload: { name: 'home', phase: 'down' } }))
      browser.send(JSON.stringify({ type: 'input:button', requestId: 'rq-in28', sessionId: agent.sessionId, payload: { name: 'home', phase: 'up' } }))
      await vi.waitFor(() => expect(thInstance.pressLegacyButton).toHaveBeenCalledWith(0), { timeout: 500 })
      expect(thInstance.pressLegacyButton).toHaveBeenCalledTimes(1)
      agent.disconnect()
      browser.close()
    })
  })

  describe('device:boot handler', () => {
    beforeEach(() => { MockTouchHelper.mockClear() })

    it('sends device:booting then device:ready for a shutdown device', async () => {
      const simctl = mockSimctl(false)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const bootingPromise = waitForType(browser, 'device:booting')
      const readyPromise = waitForType(browser, 'device:ready')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-9', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))

      await bootingPromise
      const ready = await readyPromise
      expect((ready.payload as { deviceId: string }).deviceId).toBe('dev-1')
      expect(simctl.boot).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

    it('holds device:ready until the simulator has finished booting (#486)', async () => {
      // `simctl boot` returns when the boot has been *initiated* — measured 7.6s short of Booted on an
      // iPhone 17 Pro / iOS 26.5. Announcing readiness there tells `mcp-server` to install and tap a
      // device that is not up, which is the half of #440 ("No devices are booted") that targeting the
      // session udid did not remove. Android has waited since the beginning.
      //
      // The wait is held open and `session:deviceInfo` is what is asserted absent, not `device:ready`.
      // Two earlier drafts of this test passed under the mutation that drops the `await`:
      //   - a 30ms mock + `events.push('ready')` after `await waitForType` stamps the *read* rather
      //     than the arrival, and the stream handoff between the two outlasts 30ms;
      //   - releasing the wait as soon as it had been called still ran ahead of the mutated path,
      //     because `openStreamWs` sits between the mutation site and `device:ready`.
      // `sendChromeData` is the first thing after the wait and it sends `session:deviceInfo`
      // synchronously, so with the await gone it arrives with nothing in front of it to hide behind.
      const simctl = mockSimctl(false)
      let releaseWait = (): void => {}
      ;(simctl.waitUntilBooted as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => {
          releaseWait = () =>
            resolve({ id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'booted', osVersion: 'iOS 18.3' })
        }),
      )
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-486', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:booting')
      await vi.waitFor(() => expect(simctl.waitUntilBooted).toHaveBeenCalledWith('dev-1', expect.anything()), { timeout: 2000 })

      expect(await waitForTypeOrNull(browser, 'session:deviceInfo', 300)).toBeNull()
      // `device:ready` too, and not only `session:deviceInfo`. The recording is already running, so
      // this reads whatever arrived during the 300ms above rather than waiting again — and without
      // it, moving the `sendMsg({ type: 'device:ready' })` above the wait while leaving
      // `sendChromeData` below it passes this test, which is #486 itself restored.
      expect(await waitForTypeOrNull(browser, 'device:ready', 0)).toBeNull()
      // In-process and hop-free: `sendChromeData` constructs the helper synchronously, before either
      // message goes out, so this holds even if a socket were slower than the deadline above.
      expect(MockTouchHelper.mock.results).toHaveLength(0)

      const ready = waitForType(browser, 'device:ready')
      releaseWait()
      await ready
      expect(await waitForTypeOrNull(browser, 'session:deviceInfo', 0)).not.toBeNull()
      // The wait runs after the boot, not instead of it.
      const bootOrder = (simctl.boot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      const waitOrder = (simctl.waitUntilBooted as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      expect(bootOrder).toBeLessThan(waitOrder)

      agent.disconnect()
      browser.close()
    })

    it('reports a boot that never finishes as device:boot-error (#486)', async () => {
      // What the deadline answers with. `device:ready` is the alternative — ready-anyway with a
      // warning — and it would put the caller back where it started, acting on a device that is not up.
      const simctl = mockSimctl(false)
      ;(simctl.waitUntilBooted as ReturnType<typeof vi.fn>).mockRejectedValue(
        new PlatformError('Device dev-1 did not finish booting within 90000ms (last seen: unknown)'),
      )
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const errored = waitForType(browser, 'device:boot-error')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-486b', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      const e = await errored
      expect(e.message).toContain('did not finish booting')
      expect(e.requestId).toBe('rq-486b')

      agent.disconnect()
      browser.close()
    })

    it('keeps the argv line out of a boot failure toast', async () => {
      // `Shutting Down` is the state a device caught mid-quit is in, and `simctl boot` refuses it.
      // Refusing is right — swallowing it would put the wait back to polling a device nobody is
      // bringing up — so this refusal is what the tester reads, and node's own first line is
      // `Command failed: xcrun simctl boot <UDID>`, which says nothing and echoes the udid.
      const simctl = mockSimctl(false)
      ;(simctl.boot as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Command failed: xcrun simctl boot 1A2B-3C4D\nUnable to boot device in current state: Shutting Down'),
      )
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const errored = waitForType(browser, 'device:boot-error')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-486f', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      const e = await errored
      expect(e.message).toBe('Unable to boot device in current state: Shutting Down')

      agent.disconnect()
      browser.close()
    })

    it('installs no helper when a shutdown lands while the boot is waiting (#486)', async () => {
      // The `bootSeq` re-check on the far side of the wait, which nothing reached before. The
      // existing reconnect test bumps the seq while `simctl.boot` is in flight, so it returns at the
      // check *before* this one — its own comment says so — and deleting the check after the wait
      // left all 388 tests green. The gap it guards used to be sub-second and is now the boot itself
      // (measured 7.6s), so it is the wider of the two.
      //
      // `isStale` covers the same window from inside the poll, but only while the poll is running.
      // This is the microtask-thin case it cannot see: the wait has already resolved and the seq
      // moves before the handler resumes.
      const simctl = mockSimctl(false)
      let releaseWait = (): void => {}
      ;(simctl.waitUntilBooted as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => {
          releaseWait = () =>
            resolve({ id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'booted', osVersion: 'iOS 18.3' })
        }),
      )
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-486c', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:booting')
      await vi.waitFor(() => expect(simctl.waitUntilBooted).toHaveBeenCalled(), { timeout: 2000 })
      expect(MockTouchHelper.mock.results).toHaveLength(0)

      // `device:shutdown` bumps `bootSeq` on its first line. Its reply is the barrier: the agent has
      // finished with the shutdown before the wait is released, so this is an answer rather than a
      // guess about timing.
      browser.send(JSON.stringify({ type: 'device:shutdown', requestId: 'rq-486d', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:shutdown-done')

      releaseWait()
      await new Promise((r) => setImmediate(r))

      expect(MockTouchHelper.mock.results).toHaveLength(0)
      expect(await waitForTypeOrNull(browser, 'device:ready', 0)).toBeNull()

      agent.disconnect()
      browser.close()
    })

    it('shuts a running device down before erasing it (#439)', async () => {
      // `simctl erase` refuses a Booted device. A device is often already up — it survives agent
      // restarts and sessions that ended without a clean shutdown — so without the shutdown the
      // whole boot fails with `Boot failed: Command failed: xcrun simctl erase`.
      const simctl = mockSimctl(true)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-fix-10',
        sessionId: agent.sessionId,
        payload: { deviceId: 'dev-1', resetMode: 'full-erase' },
      }))
      await waitForType(browser, 'device:ready')

      expect(simctl.shutdown).toHaveBeenCalledWith('dev-1')
      expect(simctl.erase).toHaveBeenCalledWith('dev-1')
      const shutdownOrder = (simctl.shutdown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      const eraseOrder = (simctl.erase as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      const bootOrder = (simctl.boot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      expect(shutdownOrder).toBeLessThan(eraseOrder)
      expect(eraseOrder).toBeLessThan(bootOrder)

      agent.disconnect()
      browser.close()
    })

    // ── L5b′: the lifecycle pair correlates, and the correlator is optional ────────────────────
    //
    // Optional means `<Pair>ReplyBody` cannot exist for it — `Omit<T,'sessionId'|'requestId'>` is
    // satisfied by an object with no correlator at all, so the excess-property trick that catches a
    // freshly minted id has nothing to bite on. Nor does `correlatedRequestsGated` derive this pair.
    // These tests are the entire enforcement of the echo on this agent.
    describe('lifecycle replies echo the boot/shutdown correlator', () => {
      async function joined(simctl: SimctlWrapper) {
        const agent = new IOSAgent({ intervalMs: 50 }, simctl)
        await agent.connect(`ws://localhost:${port}`)
        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        await waitForType(browser, 'session:joined')
        return { agent, browser }
      }

      it('device:ready carries the requestId of the boot it answers', async () => {
        const { agent, browser } = await joined(mockSimctl(false))

        const ready = waitForType(browser, 'device:ready')
        browser.send(JSON.stringify({
          type: 'device:boot', sessionId: agent.sessionId, requestId: 'boot-1',
          payload: { deviceId: 'dev-1' },
        }))
        expect((await ready)['requestId']).toBe('boot-1')

        agent.disconnect(); browser.close()
      })

      it('device:boot-error carries the requestId of the boot it answers', async () => {
        // The failure exit is the one that matters most and the one a happy-path test cannot reach:
        // a caller that gets an uncorrelatable diagnosis waits out its deadline instead of failing,
        // so the error arrives and is discarded. That is the defect this file's `open-url` block
        // already records as having shipped twice.
        const simctl = mockSimctl(false)
        ;(simctl.boot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boot exploded'))
        const { agent, browser } = await joined(simctl)

        const err = waitForType(browser, 'device:boot-error')
        browser.send(JSON.stringify({
          type: 'device:boot', sessionId: agent.sessionId, requestId: 'boot-2',
          payload: { deviceId: 'dev-1' },
        }))
        const msg = await err
        expect(msg['requestId']).toBe('boot-2')
        expect(msg['message']).toContain('boot exploded')

        agent.disconnect(); browser.close()
      })

      it('device:shutdown-done carries the requestId of the shutdown it answers', async () => {
        const { agent, browser } = await joined(mockSimctl(true))

        const done = waitForType(browser, 'device:shutdown-done')
        browser.send(JSON.stringify({
          type: 'device:shutdown', sessionId: agent.sessionId, requestId: 'down-1',
          payload: { deviceId: 'dev-1' },
        }))
        expect((await done)['requestId']).toBe('down-1')

        agent.disconnect(); browser.close()
      })

      it('answers a correlator-less request without inventing one', async () => {
        // The relay originates `device:shutdown` from its idle timer with no id, so this is a live
        // wire shape rather than a legacy one. A minted id here would be worse than none: the
        // consumer's fallback accepts an absent correlator and rejects one that does not match, so an
        // invented id turns a reply that lands today into one that is silently dropped.
        const { agent, browser } = await joined(mockSimctl(true))

        const done = waitForType(browser, 'device:shutdown-done')
        browser.send(JSON.stringify({
          type: 'device:shutdown', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' },
        }))
        expect((await done)['requestId']).toBeUndefined()

        agent.disconnect(); browser.close()
      })

      it('does not answer a boot that a newer boot superseded', async () => {
        // `bootSeq` makes a superseded boot return silently, and the correlator is what lets a caller
        // see that: exactly one `device:ready` arrives and it carries the newer id. A correlator read
        // from shared device state would pass every test above and fail this one — which is why the
        // agents take it as a parameter.
        const { agent, browser } = await joined(mockSimctl(false))

        browser.send(JSON.stringify({
          type: 'device:boot', sessionId: agent.sessionId, requestId: 'boot-old',
          payload: { deviceId: 'dev-1' },
        }))
        browser.send(JSON.stringify({
          type: 'device:boot', sessionId: agent.sessionId, requestId: 'boot-new',
          payload: { deviceId: 'dev-1' },
        }))

        const ready = await waitForType(browser, 'device:ready')
        expect(ready['requestId']).toBe('boot-new')
        // And nothing answers the superseded one afterwards.
        expect(await waitForTypeOrNull(browser, 'device:ready', 300)).toBeNull()

        agent.disconnect(); browser.close()
      })
    })

    // #440: simctl's `booted` alias means "whichever device is up", so with two simulators running
    // these commands could land on the wrong one — silently, since the wrong device accepts them
    // just fine. The guard is that every app command carries the session's udid, and the place it
    // can regress is the call site, not the wrapper: a default parameter on the wrapper would keep
    // every one of these compiling while the alias came back.
    //
    // Driven through the agent's own message handler rather than a browser socket. Going through
    // the relay would drag in its build lookup (`app:install` carries a buildId, not a filePath),
    // which is a different contract from the one under test here.
    describe('app commands target the session device (#440)', () => {
      type WithHandler = { handleRelayMessage(msg: Record<string, unknown>): void }
      const deliver = (agent: IOSAgent, msg: Record<string, unknown>) =>
        (agent as unknown as WithHandler).handleRelayMessage(msg)

      async function bootedAgent() {
        const simctl = mockSimctl(false)
        const agent = new IOSAgent({ intervalMs: 50 }, simctl)
        await agent.connect(`ws://localhost:${port}`)
        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        const ready = waitForType(browser, 'device:ready')
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        await waitForType(browser, 'session:joined')
        browser.send(JSON.stringify({
          type: 'device:boot', requestId: 'rq-fix-11', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' },
        }))
        await ready
        return { simctl, agent, browser }
      }

      // The DeviceAgent entry points have no device argument, so they resolve one themselves. With
      // several simulators registered — the normal case — "the first entry" is whichever simctl
      // listed first, usually shut down. That would be worse than the alias this PR removed: the
      // alias at least hit the device that was actually running.
      it('the DeviceAgent path picks the booted device, not the first registered one', async () => {
        const simctl = mockSimctlTwoDevices()
        const agent = new IOSAgent({ intervalMs: 50 }, simctl)
        await agent.connect(`ws://localhost:${port}`)
        const sessions = [...(agent as unknown as { deviceStates: Map<string, { deviceId: string }> }).deviceStates.entries()]
        const second = sessions.find(([, v]) => v.deviceId === 'dev-2')!

        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        const ready = waitForType(browser, 'device:ready')
        browser.send(JSON.stringify({ type: 'session:start', sessionId: second[0] }))
        await waitForType(browser, 'session:joined')
        browser.send(JSON.stringify({
          type: 'device:boot', requestId: 'rq-fix-12', sessionId: second[0], payload: { deviceId: 'dev-2' },
        }))
        await ready

        // `installApp`, not `screenshot`: the MJPEG stream calls screenshot on a timer with the same
        // udid, so asserting on it would pass whatever this line did.
        await agent.installApp('/tmp/iface.app')
        expect(simctl.installApp).toHaveBeenCalledWith('dev-2', '/tmp/iface.app')

        agent.disconnect(); browser.close()
      })

      it('a session drives its own device, not the first registered one', async () => {
        const simctl = mockSimctlTwoDevices()
        const agent = new IOSAgent({ intervalMs: 50 }, simctl)
        await agent.connect(`ws://localhost:${port}`)
        const sessions = [...(agent as unknown as { deviceStates: Map<string, { deviceId: string }> }).deviceStates.entries()]
        const second = sessions.find(([, v]) => v.deviceId === 'dev-2')!

        deliver(agent, {
          type: 'app:install',
          requestId: 'rq-1',
          sessionId: second[0],
          payload: { filePath: '/tmp/x.app', bundleId: 'com.example.app' },
        })
        await vi.waitFor(() => expect(simctl.installApp).toHaveBeenCalled())

        expect(simctl.installApp).toHaveBeenCalledWith('dev-2', '/tmp/x.app')

        agent.disconnect()
      })

      // The reply direction, for all three app commands. Nothing asserted it before: review made all six
      // `respond` helpers emit a fabricated correlator and every suite held its baseline exactly, which is
      // the only guarantee this layer has — the compiler sees the field is present, never that it is the
      // request's.
      //
      // A wrong echo is now a *loss*, not a misattribution: the dashboard gate discards it and nothing
      // clears `installing`, and the MCP caller burns its full deadline.
      const PAIRS = [
        { req: 'app:install', payload: { filePath: '/tmp/x.app', bundleId: 'com.example.app' }, call: 'installApp' },
        { req: 'app:launch', payload: { bundleId: 'com.example.app' }, call: 'launchApp' },
        { req: 'app:clear-state', payload: { bundleId: 'com.example.app' }, call: 'clearAppData' },
      ] as const

      for (const { req, payload, call } of PAIRS) {
        it(`${req} echoes the requestId on both outcomes`, async () => {
          const { simctl, agent, browser } = await bootedAgent()

          const done = waitForType(browser, `${req}-done`)
          deliver(agent, { type: req, sessionId: agent.sessionId, requestId: 'echo-1', payload })
          expect((await done)['requestId']).toBe('echo-1')

          simctl[call].mockRejectedValueOnce(new Error('nope'))
          const err = waitForType(browser, `${req}-error`)
          deliver(agent, { type: req, sessionId: agent.sessionId, requestId: 'echo-2', payload })
          const msg = await err
          expect(msg['requestId']).toBe('echo-2')
          expect(msg['message']).toBe('nope')

          agent.disconnect(); browser.close()
        })

        it(`${req} answers two concurrent requests with their own ids`, async () => {
          // TC5. Hoisting the correlator out of per-request scope — a plausible "share `respond`" refactor
          // — compiles clean and passes every other test in this file. This is the only thing that sees it,
          // and concurrency is the reason the correlator exists at all.
          const { simctl, agent, browser } = await bootedAgent()

          let release: (() => void) | undefined
          simctl[call]
            .mockImplementationOnce(() => new Promise<void>((r) => { release = () => r() }))
            .mockImplementationOnce(() => Promise.resolve())

          deliver(agent, { type: req, sessionId: agent.sessionId, requestId: 'con-A', payload })
          await vi.waitFor(() => expect(release).toBeDefined())

          // Sequential waits: `waitForType` does not correlate either, so two concurrent ones would hand
          // the first waiter whichever reply lands first — passing under the very mutation this catches.
          deliver(agent, { type: req, sessionId: agent.sessionId, requestId: 'con-B', payload })
          expect((await waitForType(browser, `${req}-done`))['requestId']).toBe('con-B')

          release!()
          expect((await waitForType(browser, `${req}-done`))['requestId']).toBe('con-A')

          agent.disconnect(); browser.close()
        })
      }

      it('install carries the udid', async () => {
        const { simctl, agent, browser } = await bootedAgent()

        deliver(agent, {
          type: 'app:install',
          requestId: 'rq-2',
          sessionId: agent.sessionId,
          payload: { filePath: '/tmp/x.app', bundleId: 'com.example.app' },
        })
        await vi.waitFor(() => expect(simctl.installApp).toHaveBeenCalled())

        expect(simctl.installApp).toHaveBeenCalledWith('dev-1', '/tmp/x.app')
        expect(simctl.uninstallApp).toHaveBeenCalledWith('dev-1', 'com.example.app')

        agent.disconnect(); browser.close()
      })

      it('launch carries the udid', async () => {
        const { simctl, agent, browser } = await bootedAgent()

        deliver(agent, {
          type: 'app:launch',
          requestId: 'rq-3',
          sessionId: agent.sessionId,
          payload: { bundleId: 'com.example.app' },
        })
        await vi.waitFor(() => expect(simctl.launchApp).toHaveBeenCalled())

        expect(simctl.launchApp).toHaveBeenCalledWith('dev-1', 'com.example.app')

        agent.disconnect(); browser.close()
      })

      // `open-url` had no test at all until the correlation work (L5) touched its handler — the iOS
      // suite passed the whole change because nothing exercised it. These two cover the echo and the
      // guard; Android's equivalents sit in its own suite.
      it('open-url echoes the requestId on both outcomes', async () => {
        const { simctl, agent, browser } = await bootedAgent()

        const done = waitForType(browser, 'open-url:done')
        deliver(agent, {
          type: 'open-url',
          sessionId: agent.sessionId,
          requestId: 'req-1',
          payload: { url: 'https://example.com' },
        })
        expect((await done)['requestId']).toBe('req-1')
        expect(simctl.openUrl).toHaveBeenCalledWith('dev-1', 'https://example.com')

        simctl.openUrl.mockRejectedValueOnce(new Error('no handler'))
        const err = waitForType(browser, 'open-url:error')
        deliver(agent, {
          type: 'open-url',
          sessionId: agent.sessionId,
          requestId: 'req-2',
          payload: { url: 'https://example.com' },
        })
        const msg = await err
        expect(msg['requestId']).toBe('req-2')
        expect(msg['message']).toBe('no handler')

        agent.disconnect(); browser.close()
      })

      it('answers two concurrent open-urls with their own ids', async () => {
        // The only reason this pair needs a correlator, and the case the echo tests above cannot see:
        // hoisting `requestId` out of per-request scope — a plausible "share `respond` across handlers"
        // refactor — compiles clean and passes every other test in this file, while both replies come
        // back carrying the *second* request's id. That is exactly the #499 class the layer removes.
        const { simctl, agent, browser } = await bootedAgent()

        let release: (() => void) | undefined
        simctl.openUrl
          .mockImplementationOnce(() => new Promise<void>((r) => { release = () => r() }))
          .mockImplementationOnce(() => Promise.resolve())

        deliver(agent, { type: 'open-url', sessionId: agent.sessionId, requestId: 'req-A', payload: { url: 'a://x' } })
        await vi.waitFor(() => expect(release).toBeDefined())

        // B is issued while A is still in flight, and completes first. The waits are sequential rather
        // than two concurrent `waitForType`s because that helper does not correlate either — the first
        // registered waiter takes the first arriving message, which would pass under the very mutation
        // this test exists to catch.
        deliver(agent, { type: 'open-url', sessionId: agent.sessionId, requestId: 'req-B', payload: { url: 'b://y' } })
        expect((await waitForType(browser, 'open-url:done'))['requestId']).toBe('req-B')

        release!()
        expect((await waitForType(browser, 'open-url:done'))['requestId']).toBe('req-A')

        agent.disconnect(); browser.close()
      })

      it('open-url with no requestId is dropped rather than answered uncorrelatably', async () => {
        // Required on the wire with no fallback, so a reply here could not be matched by anyone, and
        // minting an id would make it look like an answer to a request nobody made. Third-party frames
        // are validated at the relay's door by #444; until then nothing is the honest outcome.
        const { simctl, agent, browser } = await bootedAgent()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        deliver(agent, { type: 'open-url', sessionId: agent.sessionId, payload: { url: 'https://example.com' } })
        // Barrier then read, not a timeout: a round-trip proves the agent is done with the frame, so a
        // reply it was going to send is already recorded. A bare deadline passes whether the drop
        // happened or the reply merely arrived slowly.
        await barrier(browser)

        expect(await waitForTypeOrNull(browser, 'open-url:done', 0)).toBeNull()
        expect(simctl.openUrl).not.toHaveBeenCalled()
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('open-url without a requestId'))

        agent.disconnect(); browser.close()
      })

      it('clear-state carries the udid', async () => {
        const { simctl, agent, browser } = await bootedAgent()

        deliver(agent, {
          type: 'app:clear-state',
          requestId: 'rq-4',
          sessionId: agent.sessionId,
          payload: { bundleId: 'com.example.app' },
        })
        await vi.waitFor(() => expect(simctl.clearAppData).toHaveBeenCalled())

        expect(simctl.clearAppData).toHaveBeenCalledWith('dev-1', 'com.example.app')

        agent.disconnect(); browser.close()
      })

      // The compiler could not have caught this one: the old call was `screenshot(format)`, and
      // adding a leading `udid: string` left it type-correct — the format string simply became the
      // device id. Only an assertion on the arguments finds it.
      it('screenshot carries the udid, not the format string', async () => {
        const { simctl, agent, browser } = await bootedAgent()

        deliver(agent, {
          type: 'screenshot:request',
          sessionId: agent.sessionId,
          requestId: 'req-1',
          format: 'png',
        })
        await vi.waitFor(() => expect(simctl.screenshot).toHaveBeenCalled())

        expect(simctl.screenshot).toHaveBeenCalledWith('dev-1', 'png')

        agent.disconnect(); browser.close()
      })
    })

    it('shuts a device down from a transient state too, not just Booted (#439)', async () => {
      // toDeviceStatus collapses Booting / Shutting Down / Creating into 'unknown', and erase
      // refuses every one of them. Re-picking a device while its device:shutdown is still draining
      // lands here, so a guard that only recognises 'booted' would fail the boot outright.
      const simctl = mockSimctl('unknown')
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-fix-13',
        sessionId: agent.sessionId,
        payload: { deviceId: 'dev-1', resetMode: 'full-erase' },
      }))
      await waitForType(browser, 'device:ready')

      expect(simctl.shutdown).toHaveBeenCalledWith('dev-1')
      expect(simctl.erase).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

    it('does not shut down a device that is already off', async () => {
      // The other direction of the same guard: without this, widening it to "always shut down"
      // would go unnoticed.
      const simctl = mockSimctl(false)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-fix-14',
        sessionId: agent.sessionId,
        payload: { deviceId: 'dev-1', resetMode: 'full-erase' },
      }))
      await waitForType(browser, 'device:ready')

      expect(simctl.shutdown).not.toHaveBeenCalled()
      expect(simctl.erase).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

    it('powers a device back up when the erase itself fails', async () => {
      // The shutdown is ours, not the tester's. Failing the erase after it would otherwise hand
      // back a dead device along with the error.
      const simctl = mockSimctl(true)
      ;(simctl.erase as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('erase exploded'))
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-fix-15',
        sessionId: agent.sessionId,
        payload: { deviceId: 'dev-1', resetMode: 'full-erase' },
      }))
      const err = await waitForType(browser, 'device:boot-error')

      expect(err.message).toContain('erase exploded')
      // Exactly one boot, and it comes after the failed erase — not the normal post-erase boot,
      // which never runs, and not a second attempt.
      expect(simctl.boot).toHaveBeenCalledTimes(1)
      const eraseOrder = (simctl.erase as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      const bootOrder = (simctl.boot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      expect(eraseOrder).toBeLessThan(bootOrder)

      agent.disconnect()
      browser.close()
    })

    it('does not power up a device it never took down when the erase fails', async () => {
      // 'unknown' is Shutting Down / Creating: the device was on its way off, or had never run.
      // The recovery exists to undo *our* shutdown, so here there is nothing to undo — booting
      // would override what someone else asked for.
      const simctl = mockSimctl('unknown')
      ;(simctl.erase as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('erase exploded'))
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-fix-16',
        sessionId: agent.sessionId,
        payload: { deviceId: 'dev-1', resetMode: 'full-erase' },
      }))
      const err = await waitForType(browser, 'device:boot-error')

      expect(err.message).toContain('erase exploded')
      expect(simctl.boot).not.toHaveBeenCalled()

      agent.disconnect()
      browser.close()
    })

    it('calls erase then boot when resetMode=full-erase', async () => {
      const simctl = mockSimctl(false)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-fix-17',
        sessionId: agent.sessionId,
        payload: { deviceId: 'dev-1', resetMode: 'full-erase' },
      }))
      await waitForType(browser, 'device:ready')

      expect(simctl.erase).toHaveBeenCalledWith('dev-1')
      expect(simctl.boot).toHaveBeenCalledWith('dev-1')
      // erase must precede boot
      const eraseOrder = (simctl.erase as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      const bootOrder = (simctl.boot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      expect(eraseOrder).toBeLessThan(bootOrder)

      agent.disconnect()
      browser.close()
    })

    it('does not call erase when resetMode is omitted', async () => {
      const simctl = mockSimctl(false)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-18', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      expect(simctl.erase).not.toHaveBeenCalled()
      expect(simctl.boot).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

    it('re-issues the boot even for a device the list reported as booted (#486)', async () => {
      // This used to assert the opposite — the boot was skipped when the list said `booted`. That
      // skip arrived with the original on-demand boot feature (`42a5ea6`) as an obvious economy,
      // with no recorded reason, and it became load-bearing in the wrong direction once
      // `waitUntilBooted` existed: it was the only path reaching the wait with **nothing bringing
      // the device up**, so a tester who ⌘Q'd the simulator in the width of one `xcrun` round trip
      // got a 90s deadline instead of a boot.
      //
      // A short grace on `shutdown` inside the poll was tried first and rejected in review: that
      // reading is not distinguishable from a slow machine's healthy boot, so the clock would fail
      // real boots to shorten a case that can simply be removed. `SimctlWrapper.boot` swallows
      // `Unable to boot device in current state: Booted`, so the cost for a device that really is
      // up is one no-op subprocess.
      const simctl = mockSimctl(true)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const readyPromise = waitForType(browser, 'device:ready')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-19', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await readyPromise
      expect(simctl.boot).toHaveBeenCalledWith('dev-1')
      // Not the erase path — that one has its own boot call and a very different meaning.
      expect(simctl.erase).not.toHaveBeenCalled()

      agent.disconnect()
      browser.close()
    })

    it('erases then retries boot when the device data is missing on disk (zombie auto-recovery)', async () => {
      const simctl = mockSimctl(false)
      let bootCalls = 0
      ;(simctl.boot as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        bootCalls += 1
        if (bootCalls === 1) {
          throw new Error("Unable to boot device because it cannot be located on disk. The device's data is no longer present")
        }
      })
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const readyPromise = waitForType(browser, 'device:ready')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-20', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await readyPromise

      expect(simctl.erase).toHaveBeenCalledWith('dev-1')
      expect(simctl.boot).toHaveBeenCalledTimes(2)
      // erase must happen between the failed boot and the successful retry
      const eraseOrder = (simctl.erase as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
      const retryBootOrder = (simctl.boot as ReturnType<typeof vi.fn>).mock.invocationCallOrder[1]!
      expect(eraseOrder).toBeLessThan(retryBootOrder)

      agent.disconnect()
      browser.close()
    })

    it('never erases on an unrelated boot failure (protects healthy devices)', async () => {
      const simctl = mockSimctl(false)
      ;(simctl.boot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('operation timed out'))
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const errPromise = waitForType(browser, 'device:boot-error')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-21', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      const err = await errPromise

      expect(simctl.erase).not.toHaveBeenCalled()
      expect(err.message as string).toContain('operation timed out')

      agent.disconnect()
      browser.close()
    })

    it('reports boot-error without looping when erase recovery still fails', async () => {
      const simctl = mockSimctl(false)
      ;(simctl.boot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cannot be located on disk'))
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const errPromise = waitForType(browser, 'device:boot-error')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-22', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await errPromise

      // exactly one erase + one retry — bounded, no infinite loop
      expect(simctl.erase).toHaveBeenCalledTimes(1)
      expect(simctl.boot).toHaveBeenCalledTimes(2)

      agent.disconnect()
      browser.close()
    })
  })

  describe('agent:register', () => {
    it('includes osVersion in register payload', async () => {
      const agent = new IOSAgent({}, mockSimctl())
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)

      const agentsListedPromise = waitForType(browser, 'agents:listed')
      browser.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await agentsListedPromise

      const sessions = listed.sessions as Array<{ devices: Array<{ osVersion?: string }> }>
      expect(sessions[0]?.devices[0]?.osVersion).toBe('iOS 18.3')

      agent.disconnect()
      browser.close()
    })

    it('agents:listed includes sessionId per device', async () => {
      const agent = new IOSAgent({}, mockSimctl())
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForType(browser, 'agents:listed')

      const sessions = listed.sessions as Array<{ devices: Array<{ sessionId?: string }> }>
      expect(typeof sessions[0]?.devices[0]?.sessionId).toBe('string')
      expect(sessions[0].devices[0].sessionId).toBe(agent.sessionId)

      agent.disconnect()
      browser.close()
    })

    it('registers only the device matching deviceFilter (exposure filter, never boots)', async () => {
      const simctl = {
        ...mockSimctl(false),
        listDevices: vi.fn().mockResolvedValue([
          { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.3' },
          { id: 'dev-2', name: 'iPhone 16', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.3' },
        ]),
      } as unknown as SimctlWrapper
      const agent = new IOSAgent({ deviceFilter: 'iPhone 16' }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForType(browser, 'agents:listed')

      const sessions = listed.sessions as Array<{ devices: Array<{ name: string }> }>
      const registered = sessions.flatMap((s) => s.devices)
      expect(registered).toHaveLength(1)
      expect(registered[0].name).toBe('iPhone 16')
      // connect registers only — booting is the dashboard/MCP's job (device:boot)
      expect(simctl.boot).not.toHaveBeenCalled()

      agent.disconnect()
      browser.close()
    })
  })

  describe('relay connection', () => {
    it('connects to relay and receives a sessionId', async () => {
      const agent = new IOSAgent({}, mockSimctl())
      await agent.connect(`ws://localhost:${port}`)
      expect(agent.sessionId).toBeDefined()
      agent.disconnect()
    })

    it('forwards binary frame to browser via stream WS after connecting', async () => {
      const browser = new WebSocket(`ws://localhost:${port}`)
      browser.binaryType = 'nodebuffer'
      await waitForOpen(browser)

      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)

      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      // Register before device:boot — MjpegStreamer emits the first frame immediately
      // after device:ready; registering after waitForType risks missing it
      const framePromise = new Promise<Buffer>((r) =>
        browser.on('message', function listener(d, isBinary) {
          if (isBinary) {
            browser.off('message', listener)
            r(d as Buffer)
          }
        })
      )

      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-23', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      const frame = await framePromise
      expect(frame.length).toBeGreaterThan(0)

      agent.disconnect()
      browser.close()
    })
  })

  describe('input:key handler', () => {
    beforeEach(() => { MockTouchHelper.mockClear() })

    async function setupSession() {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-24', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(1), { timeout: 500 })
      const thInstance = MockTouchHelper.mock.results[0].value
      return { browser, agent, thInstance }
    }

    it('input:key Backspace calls touchHelper.sendKey with HID usage 0x2A', async () => {
      const { browser, agent, thInstance } = await setupSession()
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in29', sessionId: agent.sessionId, payload: { code: 'Backspace', modifiers: 0 } }))
      await vi.waitFor(() => expect(thInstance.sendKey).toHaveBeenCalledWith(HID_BACKSPACE, 0), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    it('input:key KeyA calls touchHelper.sendKey with HID usage 0x04', async () => {
      const { browser, agent, thInstance } = await setupSession()
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in30', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
      await vi.waitFor(() => expect(thInstance.sendKey).toHaveBeenCalledWith(HID_KEY_A, 0), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    it('input:key with Shift modifier forwards modifier bits', async () => {
      const { browser, agent, thInstance } = await setupSession()
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in31', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0x02 } }))
      await vi.waitFor(() => expect(thInstance.sendKey).toHaveBeenCalledWith(HID_KEY_A, 0x02), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    it('input:key unknown code is silently dropped', async () => {
      const { browser, agent, thInstance } = await setupSession()
      // Send unknown key first, then a known key as a sentinel.
      // WebSocket messages are ordered — when KeyA is processed, UnknownKey was already processed.
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in32', sessionId: agent.sessionId, payload: { code: 'UnknownKey', modifiers: 0 } }))
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in33', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
      await vi.waitFor(() => expect(thInstance.sendKey).toHaveBeenCalledTimes(1), { timeout: 500 })
      expect(thInstance.sendKey).toHaveBeenCalledWith(HID_KEY_A, 0)
      agent.disconnect()
      browser.close()
    })
  })

  describe('input:keyboard:toggle handler', () => {
    beforeEach(() => { MockTouchHelper.mockClear() })

    async function setupSession(sim = mockSimctl(true)) {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, sim)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-25', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      return { browser, agent, sim }
    }

    it('첫 토글 시 showSoftwareKeyboard를 호출한다', async () => {
      const sim = mockSimctl(true)
      const { browser, agent } = await setupSession(sim)
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await vi.waitFor(() => expect(sim.showSoftwareKeyboard).toHaveBeenCalledWith('dev-1'), { timeout: 500 })
      expect(sim.hideSoftwareKeyboard).not.toHaveBeenCalled()
      agent.disconnect()
      browser.close()
    })

    it('두 번째 토글 시 hideSoftwareKeyboard를 호출한다', async () => {
      const sim = mockSimctl(true)
      const { browser, agent } = await setupSession(sim)
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await vi.waitFor(() => expect(sim.showSoftwareKeyboard).toHaveBeenCalledTimes(1), { timeout: 500 })
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await vi.waitFor(() => expect(sim.hideSoftwareKeyboard).toHaveBeenCalledWith('dev-1'), { timeout: 500 })
      expect(sim.showSoftwareKeyboard).toHaveBeenCalledTimes(1)
      agent.disconnect()
      browser.close()
    })

    it('토글 성공 시 keyboard:toggled ACK를 dashboard로 송신한다', async () => {
      const sim = mockSimctl(true)
      const { browser, agent } = await setupSession(sim)
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      const ack = await waitForType(browser, 'keyboard:toggled')
      expect(ack.payload).toEqual({ visible: true })
      // second toggle: visible becomes false
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      const ack2 = await waitForType(browser, 'keyboard:toggled')
      expect(ack2.payload).toEqual({ visible: false })
      agent.disconnect()
      browser.close()
    })

    it('토글 실패 시 state가 롤백되고 ACK가 오지 않는다', async () => {
      const sim = mockSimctl(true)
      ;(sim.showSoftwareKeyboard as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('helper failed'))
      const { browser, agent } = await setupSession(sim)
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await vi.waitFor(() => expect(sim.showSoftwareKeyboard).toHaveBeenCalledTimes(1), { timeout: 500 })
      // state should remain false (no visible=true ACK)
      // next toggle should call show again (not hide), confirming state stayed false
      ;(sim.showSoftwareKeyboard as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await vi.waitFor(() => expect(sim.showSoftwareKeyboard).toHaveBeenCalledTimes(2), { timeout: 500 })
      expect(sim.hideSoftwareKeyboard).not.toHaveBeenCalled()
      agent.disconnect()
      browser.close()
    })

    it('input:key 수신 시 SW 켜져 있으면 hideSoftwareKeyboard를 먼저 호출한다', async () => {
      const sim = mockSimctl(true)
      const { browser, agent } = await setupSession(sim)
      // show keyboard first
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await waitForType(browser, 'keyboard:toggled')
      // hardware key press → hide must be called before sendKey
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in34', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
      await vi.waitFor(() => expect(sim.hideSoftwareKeyboard).toHaveBeenCalledWith('dev-1'), { timeout: 500 })
      await vi.waitFor(() => {
        expect(MockTouchHelper.mock.results[0].value.sendKey).toHaveBeenCalledWith(HID_KEY_A, 0)
      }, { timeout: 500 })
      // next toggle should show (state was reset to false by the key press)
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await vi.waitFor(() => expect(sim.showSoftwareKeyboard).toHaveBeenCalledTimes(2), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    it('input:key 수신 시 SW 꺼져 있으면 hideSoftwareKeyboard를 호출하지 않는다', async () => {
      const sim = mockSimctl(true)
      const { browser, agent } = await setupSession(sim)
      browser.send(JSON.stringify({ type: 'input:key', requestId: 'rq-in35', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
      await vi.waitFor(() => {
        const thInstance = MockTouchHelper.mock.results[0].value
        return expect(thInstance.sendKey).toHaveBeenCalledWith(HID_KEY_A, 0)
      }, { timeout: 500 })
      expect(sim.hideSoftwareKeyboard).not.toHaveBeenCalled()
      agent.disconnect()
      browser.close()
    })
  })

  describe('reconnect', () => {
    it('disconnect() sets _stopping and cancels pending reconnect timer', async () => {
      const agent = new IOSAgent({}, mockSimctl())
      await agent.connect(`ws://localhost:${port}`)

      internals(agent)._reconnectTimer = setTimeout(() => {}, 10000)

      agent.disconnect()

      expect(internals(agent)._stopping).toBe(true)
      expect(internals(agent)._reconnectTimer).toBeNull()
    })

    it('_scheduleReconnect() is no-op when _stopping is true', async () => {
      const agent = new IOSAgent({}, mockSimctl())
      await agent.connect(`ws://localhost:${port}`)

      internals(agent)._stopping = true
      internals(agent)._scheduleReconnect()

      expect(internals(agent)._reconnectTimer).toBeNull()
      expect(internals(agent)._reconnectAttempt).toBe(0)

      agent.disconnect()
    })

    it('reconnects automatically when connection drops and relay is available', async () => {
      const agent = new IOSAgent({ reconnectDelays: [0] }, mockSimctl())
      await agent.connect(`ws://localhost:${port}`)

      const oldWs = internals(agent).ws!
      oldWs.terminate()

      await vi.waitFor(() => {
        const ws = internals(agent).ws
        expect(ws).not.toBeNull()
        expect(ws).not.toBe(oldWs)       // 새 연결 객체여야 함
        expect(ws!.readyState).toBe(WebSocket.OPEN)
      }, { timeout: 2000 })

      agent.disconnect()
    })
  })

  // Codec negotiation: H.264 only when the agent opts in (env) AND the browser reported
  // it can decode it (device:boot acceptH264). Otherwise JPEG. Uses the ScreenCaptureStreamer
  // path (no intervalMs) and reads the codec arg the mocked streamer was constructed with.
  describe('codec negotiation', () => {
    const ORIG_CODEC = process.env.TAPFLOW_IOS_CODEC
    const MockCapture = vi.mocked(ScreenCaptureStreamer)

    afterEach(() => {
      if (ORIG_CODEC === undefined) delete process.env.TAPFLOW_IOS_CODEC
      else process.env.TAPFLOW_IOS_CODEC = ORIG_CODEC
    })

    // Boots via the ScreenCaptureStreamer path and returns the codec the streamer got.
    async function bootAndGetCodec(bootPayload: Record<string, unknown>): Promise<string> {
      MockCapture.mockClear()
      const agent = new IOSAgent({}, mockSimctl(true)) // no intervalMs → ScreenCaptureStreamer
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-fix-26',
        sessionId: agent.sessionId,
        payload: { deviceId: 'dev-1', ...bootPayload },
      }))
      await waitForType(browser, 'device:ready')
      // mockSimctl(true) registers the device as already booted, so the relay replays a
      // device:ready on session:start — waitForType can latch that stale ack instead of this
      // boot's, and the mock read then saw zero calls (`undefined` vs the expected codec).
      // Sync on the streamer itself, which is what this test actually asserts.
      await vi.waitFor(() => expect(MockCapture.mock.calls.length).toBeGreaterThan(0), { timeout: 2000 })
      const calls = MockCapture.mock.calls
      const codec = calls[calls.length - 1]?.[2] as string
      agent.disconnect()
      browser.close()
      return codec
    }

    it('streams H.264 when env=h264 and the browser accepts it', async () => {
      process.env.TAPFLOW_IOS_CODEC = 'h264'
      expect(await bootAndGetCodec({ acceptH264: true })).toBe('h264')
    })

    it('falls back to JPEG when the browser cannot decode H.264', async () => {
      process.env.TAPFLOW_IOS_CODEC = 'h264'
      expect(await bootAndGetCodec({ acceptH264: false })).toBe('jpeg')
    })

    it('defaults to JPEG when acceptH264 is absent (old browser / version skew)', async () => {
      process.env.TAPFLOW_IOS_CODEC = 'h264'
      expect(await bootAndGetCodec({})).toBe('jpeg')
    })

    it('forces JPEG when env=jpeg even if the browser accepts H.264', async () => {
      process.env.TAPFLOW_IOS_CODEC = 'jpeg'
      expect(await bootAndGetCodec({ acceptH264: true })).toBe('jpeg')
    })

    // H.264 is the default: env unset + a capable browser streams H.264 without any opt-in.
    it('streams H.264 by default when env is unset and the browser accepts it', async () => {
      delete process.env.TAPFLOW_IOS_CODEC
      expect(await bootAndGetCodec({ acceptH264: true })).toBe('h264')
    })
  })

  // #271 — 원격 릴레이 인증: token 옵션이 control/stream WS 업그레이드에 Bearer 헤더로 실린다.
  describe('relay auth token (#271)', () => {
    // 업그레이드 요청 헤더를 그대로 검증하기 위해 raw WebSocketServer 사용
    async function captureAuthHeader(token?: string): Promise<string | undefined> {
      const wss = new WebSocketServer({ port: 0 })
      const wssPort = (wss.address() as { port: number }).port
      const header = new Promise<string | undefined>((resolve) => {
        wss.on('connection', (sock, req) => {
          resolve(req.headers.authorization)
          sock.on('message', () => sock.send(JSON.stringify({ type: 'agent:registered', registeredSessions: [] })))
        })
      })
      const agent = new IOSAgent(token ? { token } : {}, mockSimctl())
      await agent.connect(`ws://127.0.0.1:${wssPort}`)
      const result = await header
      agent.disconnect()
      await new Promise<void>((r) => wss.close(() => r()))
      return result
    }

    it('token 옵션이 있으면 control WS에 Authorization: Bearer 헤더가 실린다', async () => {
      expect(await captureAuthHeader('tflw_pat_test123')).toBe('Bearer tflw_pat_test123')
    })

    it('token이 없으면 Authorization 헤더를 보내지 않는다 (localhost 무인증 유지)', async () => {
      expect(await captureAuthHeader()).toBeUndefined()
    })

    it('원격 릴레이 + agent 스코프 PAT: control/stream WS 모두 인증되어 device:ready까지 도달한다', async () => {
      // 모든 연결을 비-루프백 출발지로 가장 → 무인증이면 stream WS도 1008로 거절된다
      const remoteSpy = vi
        .spyOn(relay as unknown as { remoteAddressOf: () => string }, 'remoteAddressOf')
        .mockReturnValue('192.168.0.77')
      const db = getDb()
      db.prepare(
        "INSERT OR IGNORE INTO users (id, email, display_name, role, password_hash) VALUES (9101, 'agent-e2e@test.local', 'E2E', 'Admin', 'x')",
      ).run()
      const insertPat = (scope: string): string => {
        const raw = `tflw_pat_${crypto.randomBytes(16).toString('hex')}`
        db.prepare(
          'INSERT INTO personal_access_tokens (user_id, name, token_hash, scope, expires_at) VALUES (9101, ?, ?, ?, NULL)',
        ).run(`e2e-${raw.slice(-8)}`, crypto.createHash('sha256').update(raw).digest('hex'), scope)
        return raw
      }
      // agent 소켓은 agent 스코프, browser 소켓은 view 스코프 — 실제 역할에 맞는 자격을 쓴다
      const token = insertPat('agent')
      const browserToken = insertPat('view')

      const agent = new IOSAgent({ token }, mockSimctl(true))
      await agent.connect(`ws://127.0.0.1:${port}`)

      const browser = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { authorization: `Bearer ${browserToken}` } })
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-27', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      agent.disconnect()
      browser.close()
      remoteSpy.mockRestore()
    })
  })

  // #271 — 핸드셰이크 견고성: 등록 전 close/무응답이 침묵 속에 영원히 멈추지 않는다.
  describe('handshake robustness (#271)', () => {
    async function withRawServer<T>(
      onConnection: (sock: import('ws').WebSocket) => void,
      run: (url: string) => Promise<T>,
    ): Promise<T> {
      const wss = new WebSocketServer({ port: 0 })
      // 느린 러너에서 address()가 null일 수 있으므로 listening 이후 포트를 읽는다
      await new Promise<void>((r) => wss.once('listening', r))
      const wssPort = (wss.address() as { port: number }).port
      wss.on('connection', onConnection)
      try {
        return await run(`ws://127.0.0.1:${wssPort}`)
      } finally {
        await new Promise<void>((r) => wss.close(() => r()))
      }
    }

    it('등록 전 1008 close → code/reason을 담아 reject한다 (무한 대기 없음)', async () => {
      await withRawServer(
        (sock) => sock.close(1008, 'Unauthorized: agents need a PAT'),
        async (url) => {
          const agent = new IOSAgent({}, mockSimctl())
          await expect(agent.connect(url)).rejects.toThrow(/code=1008.*Unauthorized: agents need a PAT/)
        },
      )
    })

    it('agent:registered 응답이 없으면 handshakeTimeoutMs 후 reject한다', async () => {
      await withRawServer(
        () => { /* 업그레이드만 수락하고 무응답 */ },
        async (url) => {
          const agent = new IOSAgent({ handshakeTimeoutMs: 150 }, mockSimctl())
          await expect(agent.connect(url)).rejects.toThrow(/timed out after 150ms/)
        },
      )
    })

    // CodeRabbit #272 ② — malformed 첫 프레임이 핸들러에서 throw되어 connect()가 행되지 않는다
    it('등록 전 malformed(비-JSON) 프레임 → 행 없이 reject한다', async () => {
      await withRawServer(
        (sock) => sock.on('message', () => sock.send('not-json{{{')),
        async (url) => {
          const agent = new IOSAgent({ handshakeTimeoutMs: 1000 }, mockSimctl())
          await expect(agent.connect(url)).rejects.toThrow(/malformed|handshake/i)
        },
      )
    })
  })

  describe('audio output (whole-sim tap, default-on)', () => {
    beforeEach(() => {
      MockAudioStreamer.mockClear()
      mockLaunchAudioHelper.mockClear()
      delete process.env.TAPFLOW_AUDIO
    })
    afterEach(() => { delete process.env.TAPFLOW_AUDIO })

    async function bootSession(): Promise<{ agent: IOSAgent; browser: WebSocket }> {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-28', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      return { agent, browser }
    }

    it('TAPFLOW_AUDIO=off: no helper launched at boot', async () => {
      process.env.TAPFLOW_AUDIO = 'off'
      const { agent, browser } = await bootSession()
      await new Promise((r) => setTimeout(r, 30)) // give any async audio path a tick to (not) fire
      expect(MockAudioStreamer).not.toHaveBeenCalled()
      expect(mockLaunchAudioHelper).not.toHaveBeenCalled()
      agent.disconnect(); browser.close()
    })

    it('default-on (unset): boot launches the whole-sim tap with the enumerated sim pids', async () => {
      const { agent, browser } = await bootSession()
      await vi.waitFor(() => expect(mockLaunchAudioHelper).toHaveBeenCalledTimes(1))
      const [appPath, helperPort, pids] = mockLaunchAudioHelper.mock.calls[0]
      expect(appPath).toBe('/fake/audiotap-helper.app')
      expect(helperPort).toBe(54321) // AudioCaptureStreamer.listen() mock
      expect(pids).toEqual([101, 102, 103]) // enumerateSimPids mock — whole-sim, not a single app
      agent.disconnect(); browser.close()
    })

    it('cleanup on disconnect stops the audio streamer', async () => {
      const { agent, browser } = await bootSession()
      await vi.waitFor(() => expect(MockAudioStreamer).toHaveBeenCalledTimes(1))
      const instance = MockAudioStreamer.mock.results[0].value as { stop: ReturnType<typeof vi.fn> }
      agent.disconnect()
      expect(instance.stop).toHaveBeenCalled()
      browser.close()
    })
  })

  describe('clipboard bridge', () => {
    // Every other describe resets this; without it a stale helper from an earlier test
    // satisfies the `results.length > 0` guards below and they assert nothing.
    beforeEach(() => { MockTouchHelper.mockClear() })

    async function bootWith(simctl: SimctlWrapper): Promise<{ agent: IOSAgent; browser: WebSocket }> {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-29', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      return { agent, browser }
    }

    // The viewer gates the whole bridge on this. If the agent stops advertising it, copy and
    // paste silently degrade to device-only and nothing else in the suite would notice.
    // Asserted end to end (agent → relay → browser), which is the path the dashboard reads.
    it('advertises the clipboard capability all the way to the viewer', async () => {
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, mockSimctl(true))
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      const joined = await waitForType(browser, 'session:joined')
      expect((joined as unknown as { capabilities: string[] }).capabilities).toContain('clipboard')

      agent.disconnect(); browser.close()
    })

    it('clipboard:read returns the simulator pasteboard as clipboard:data', async () => {
      const simctl = mockSimctl(true)
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockResolvedValue('한글 テスト 🎉\nline2')
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'r1' }))
      const data = await waitForType(browser, 'clipboard:data')
      expect(data.requestId).toBe('r1')
      expect((data.payload as { text: string }).text).toBe('한글 テスト 🎉\nline2')
      expect(simctl.getPasteboard).toHaveBeenCalledWith('dev-1')

      agent.disconnect(); browser.close()
    })

    // The core guarantee: the agent must not answer until the device clipboard actually
    // changed. A fixed delay cannot tell "copied" from "not copied yet"; the sentinel can.
    it('keeps watching until the pasteboard actually changes', async () => {
      const simctl = mockSimctl(true)
      let sentinel = ''
      let reads = 0
      ;(simctl.setPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async (_d: string, t: string) => { sentinel = t })
      // The app has not processed the chord yet on the first two reads.
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async () =>
        ++reads <= 3 ? sentinel : 'what the app copied')
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'p1', payload: { press: 'copy' },
      }))
      const data = await waitForType(browser, 'clipboard:data')
      expect((data.payload as { text: string }).text).toBe('what the app copied')
      expect(reads).toBeGreaterThan(2)   // a fixed delay would have answered on the first read

      agent.disconnect(); browser.close()
    })

    // Re-copying the same text produces no value change at all, which is why a plain
    // value-change watch cannot work and the sentinel has to be written first.
    it('handles re-copying the identical text', async () => {
      const simctl = mockSimctl(true)
      let current = 'same text'
      ;(simctl.setPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async (_d: string, t: string) => { current = t })
      let reads = 0
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        // after the chord, the app writes the very same text back over the sentinel
        if (++reads > 2) current = 'same text'
        return current
      })
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'p2', payload: { press: 'copy' },
      }))
      const data = await waitForType(browser, 'clipboard:data')
      expect((data.payload as { text: string }).text).toBe('same text')

      agent.disconnect(); browser.close()
    })

    it('fails and restores the original when the device never copies', async () => {
      const simctl = mockSimctl(true)
      let current = 'untouched original'
      const original = current
      ;(simctl.setPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async (_d: string, t: string) => { current = t })
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async () => current)
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'p3', payload: { press: 'copy' },
      }))
      const err = await waitForType(browser, 'clipboard:error')
      expect(err.message).toMatch(/did not copy/i)
      // the sentinel must not be left behind on the device
      expect(simctl.setPasteboard).toHaveBeenLastCalledWith('dev-1', original)
      expect(current).toBe(original)

      agent.disconnect(); browser.close()
    }, 10_000)

    // Both of these are only reachable if the per-device queue fails, but the queue is the sole
    // thing standing between them and a corrupted clipboard, so the discrimination itself is
    // pinned rather than trusted.
    it('never hands a foreign sentinel back as copied text', async () => {
      const simctl = mockSimctl(true)
      const foreign = `\u200Btapflow-clipboard-someone-else`
      pasteboard = 'ORIGINAL'
      // Let our own sentinel land and be confirmed, then swap in another operation's marker —
      // which is what the chord-wait loop would see if the queue ever let two reads overlap.
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        const v = pasteboard
        if (v.startsWith('\u200Btapflow-clipboard-')) pasteboard = foreign
        return v
      })
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'f1', payload: { press: 'copy' },
      }))
      const err = await waitForType(browser, 'clipboard:error')
      expect(err.message).toMatch(/did not copy/i)   // not clipboard:data carrying the marker

      agent.disconnect(); browser.close()
    }, 10_000)

    it('does not restore a foreign sentinel as if it were the user text', async () => {
      const simctl = mockSimctl(true)
      pasteboard = `\u200Btapflow-clipboard-someone-else`   // already parked when we arrive
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'f2', payload: { press: 'copy' },
      }))
      await waitForType(browser, 'clipboard:error')        // the guest never copies
      // Restoring the marker would leave it for the NEXT read to mistake for the original.
      await vi.waitFor(() => expect(pasteboard).toBe(''), { timeout: 2000 })

      agent.disconnect(); browser.close()
    }, 10_000)

    // Mirrors the Android test of the same name. The queue has to stay held through the
    // restore, not just through the answer: the guest applies a write late, so releasing early
    // lets the next read mistake the still-parked sentinel for "the original" and then wipe it.
    it('serialises overlapping reads so they cannot trade sentinels', async () => {
      const simctl = mockSimctl(true)
      pasteboard = 'ORIGINAL'
      pasteboardApplyDelayMs = 120                    // the guest never copies; writes land late
      const { agent, browser } = await bootWith(simctl)

      const seen: string[] = []
      browser.on('message', (d: Buffer) => {
        try {
          const m = JSON.parse(d.toString()) as RelayMessage
          if (m.type === 'clipboard:data') seen.push(`${m.requestId}:${(m.payload as { text: string }).text}`)
          if (m.type === 'clipboard:error') seen.push(`${m.requestId}:ERR`)
        } catch { /* binary frame — ignore */ }
      })

      for (const requestId of ['P1', 'P2']) {
        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId, payload: { press: 'copy' },
        }))
      }
      await vi.waitFor(() => expect(seen.length).toBe(2), { timeout: 9000 })

      // Neither may report a sentinel as copied text, and the original must survive both.
      expect(seen).toEqual(['P1:ERR', 'P2:ERR'])
      await vi.waitFor(() => expect(pasteboard).toBe('ORIGINAL'), { timeout: 2000 })

      agent.disconnect(); browser.close()
    }, 20_000)

    it('press:copy sends Cmd+C and only then reads the pasteboard', async () => {
      const simctl = mockSimctl(true)
      const order: string[] = []
      // Track ordering without breaking the sentinel handshake — the read must keep reflecting
      // the real pasteboard, or the confirm loop can never be satisfied.
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        order.push('read'); return pasteboard
      })
      const { agent, browser } = await bootWith(simctl)
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      const th = MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value
      th.sendKey.mockImplementation(() => { order.push('chord'); pasteboard = 'copied' })

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'r2', payload: { press: 'copy' },
      }))
      await waitForType(browser, 'clipboard:data')
      expect(th.sendKey).toHaveBeenCalledWith(0x06, 0x08)   // KeyC + MetaLeft
      // reads the current value, writes the sentinel, presses, then polls
      expect(order.indexOf('chord')).toBeLessThan(order.lastIndexOf('read'))

      agent.disconnect(); browser.close()
    }, 15_000)
    // B1: pbcopy exiting does not mean the pasteboard shows the sentinel. Pressing the chord
    // early lets the first poll read the pre-sentinel value and return it as the copy result.
    it('waits for the sentinel to be visible before pressing the chord', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      const th = MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value
      th.sendKey.mockClear()
      pasteboard = 'THE USER ORIGINAL'
      pasteboardApplyDelayMs = 60              // the sim lags behind the accepted write
      copyOnChord(th, 'WHAT THE APP COPIED', 80)   // and the app copies later still

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'b1', payload: { press: 'copy' },
      }))
      const data = await waitForType(browser, 'clipboard:data')
      expect((data.payload as { text: string }).text).toBe('WHAT THE APP COPIED')

      agent.disconnect(); browser.close()
    }, 10_000)

    it('restores the original before releasing the device, even when the write lags', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      pasteboard = 'UNTOUCHED ORIGINAL'
      pasteboardApplyDelayMs = 40              // both the sentinel and the restore lag

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'b2', payload: { press: 'copy' },
      }))
      await waitForType(browser, 'clipboard:error')
      // The reply now goes out BEFORE the restore (the restore is a `finally`, which runs after
      // the `catch` that answers), so the device may still hold the sentinel at this instant.
      // What must hold is that the restore completes while the queue is still held.
      await vi.waitFor(() => expect(pasteboard).toBe('UNTOUCHED ORIGINAL'), { timeout: 3000 })

      agent.disconnect(); browser.close()
    }, 15_000)

    // Restoring is cleanup, not part of answering. Making the viewer wait for it put a whole
    // deadline window inside the round trip, which is how the browser ended up giving up before
    // the agent's specific message arrived.
    it('answers before it restores, and still restores before releasing the device', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      pasteboard = 'ORIGINAL'
      // Make the restore slow enough that "reply first" cannot be an artefact of scheduling:
      // the answer has to arrive while the restore is demonstrably still running.
      let restoreDone = false
      ;(simctl.setPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async (_d: string, t: string) => {
        if (t === 'ORIGINAL') {
          await new Promise((r) => setTimeout(r, 400))
          restoreDone = true
        }
        pasteboard = t
      })

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'ord', payload: { press: 'copy' },
      }))
      await waitForType(browser, 'clipboard:error')
      expect(restoreDone).toBe(false)   // answered while the restore was still in flight
      await vi.waitFor(() => expect(restoreDone).toBe(true), { timeout: 3000 })

      agent.disconnect(); browser.close()
    }, 15_000)

    // The flag is what the viewer uses to decide whether pressing the plain chord is safe.
    // Emitting it correctly was untested on the agent side in both polarities.
    it('reports a parked sentinel when the copy failed after the marker went down', async () => {
      const simctl = mockSimctl(true)
      pasteboard = 'ORIGINAL'
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'sp1', payload: { press: 'copy' },
      }))
      const err = await waitForType(browser, 'clipboard:error')
      expect((err.payload as { sentinelParked: boolean }).sentinelParked).toBe(true)

      agent.disconnect(); browser.close()
    }, 10_000)

    it('reports no parked sentinel when it failed before writing one', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      // Reading the original is the last step before the marker goes down.
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockRejectedValue(
        new PlatformError('Could not read the device clipboard: simctl pbpaste timed out'))

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'sp2', payload: { press: 'copy' },
      }))
      const err = await waitForType(browser, 'clipboard:error')
      expect((err.payload as { sentinelParked: boolean }).sentinelParked).toBe(false)

      agent.disconnect(); browser.close()
    }, 10_000)

    // The flag describes the DEVICE, not the operation that answers. A caller that never touched
    // the clipboard must still report a marker another operation has down — the chord the viewer
    // would press in response travels as `input:key`, outside the queue that keeps them apart.
    it('reports a sentinel parked by a different in-flight operation', async () => {
      const simctl = mockSimctl(true)
      pasteboard = 'ORIGINAL'
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'hold', payload: { press: 'copy' },
      }))
      await vi.waitFor(() => expect(isSentinelish(pasteboard)).toBe(true), { timeout: 2000 })

      // Rejected up front, before the queue — so it answers while the read above still holds.
      browser.send(JSON.stringify({
        type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'big',
        payload: { text: 'x'.repeat(MAX_CLIPBOARD_BYTES + 1) },
      }))
      const err = await waitForType(browser, 'clipboard:error')
      expect(err.requestId).toBe('big')
      expect((err.payload as { sentinelParked: boolean }).sentinelParked).toBe(true)

      // Let the read finish before leaving: it still holds the device queue.
      await vi.waitFor(() => expect(pasteboard).toBe('ORIGINAL'), { timeout: 5000 })

      agent.disconnect(); browser.close()
    }, 20_000)

    it('press:cut sends Cmd+X instead', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      const th = MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value
      th.sendKey.mockClear()
      copyOnChord(th)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'r3', payload: { press: 'cut' },
      }))
      await waitForType(browser, 'clipboard:data')
      expect(th.sendKey).toHaveBeenCalledWith(0x1b, 0x08)   // KeyX + MetaLeft

      agent.disconnect(); browser.close()
    }, 15_000)
    it('hides a visible software keyboard before pressing copy', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await waitForType(browser, 'keyboard:toggled')
      ;(simctl.hideSoftwareKeyboard as ReturnType<typeof vi.fn>).mockClear()
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      copyOnChord(MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value)

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'r4', payload: { press: 'copy' },
      }))
      await waitForType(browser, 'clipboard:data')
      expect(simctl.hideSoftwareKeyboard).toHaveBeenCalledWith('dev-1')

      agent.disconnect(); browser.close()
    }, 15_000)
    it('clipboard:write sets the pasteboard and acks only after it landed', async () => {
      const simctl = mockSimctl(true)
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      ;(simctl.setPasteboard as ReturnType<typeof vi.fn>).mockReturnValue(gate)
      const { agent, browser } = await bootWith(simctl)

      let acked = false
      waitForType(browser, 'clipboard:write-done').then(() => { acked = true })
      browser.send(JSON.stringify({
        type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'r5', payload: { text: 'pasted text' },
      }))
      await vi.waitFor(() => expect(simctl.setPasteboard).toHaveBeenCalledWith('dev-1', 'pasted text'))
      await new Promise((r) => setTimeout(r, 50))
      expect(acked).toBe(false)     // the write has not settled yet
      release()
      await vi.waitFor(() => expect(acked).toBe(true))

      agent.disconnect(); browser.close()
    })

    it('pasteAfter presses Cmd+V after the write, before the ack', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      const th = MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value
      th.sendKey.mockClear()

      const done = waitForType(browser, 'clipboard:write-done')
      browser.send(JSON.stringify({
        type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'r6', payload: { text: 'x', pasteAfter: true },
      }))
      await done
      expect(th.sendKey).toHaveBeenCalledWith(0x19, 0x08)   // KeyV + MetaLeft
      expect(simctl.setPasteboard).toHaveBeenCalledWith('dev-1', 'x')

      agent.disconnect(); browser.close()
    })

    it('answers clipboard:error when the paste chord is dropped (#482)', async () => {
      // The pasteboard deadline above proves the device took the text, not that the chord
      // reached it — so a dead input channel here used to answer clipboard:write-done having
      // pasted nothing into the app.
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      const th = MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value
      th.sendKey.mockClear()
      killHelper(th)

      const errored = waitForType(browser, 'clipboard:error')
      browser.send(JSON.stringify({
        type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'r6b', payload: { text: 'x', pasteAfter: true },
      }))
      expect((await errored).message).toContain('no input channel')

      agent.disconnect(); browser.close()
    })

    it('does not press paste when pasteAfter is not asked for', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      const th = MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value
      th.sendKey.mockClear()   // shared mock across tests in this file

      const done = waitForType(browser, 'clipboard:write-done')
      browser.send(JSON.stringify({
        type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'r7', payload: { text: 'x' },
      }))
      await done
      expect(th.sendKey).not.toHaveBeenCalled()

      agent.disconnect(); browser.close()
    })

    it('rejects an oversized clipboard instead of forwarding it', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({
        type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'r8',
        payload: { text: 'x'.repeat(1024 * 1024 + 1) },
      }))
      const err = await waitForType(browser, 'clipboard:error')
      expect(err.message).toMatch(/too large/i)
      expect(simctl.setPasteboard).not.toHaveBeenCalled()

      agent.disconnect(); browser.close()
    })

    // The size ceiling is enforced inside getPasteboard (maxBuffer). Hitting it means the app
    // DID copy, so restoring the original here would overwrite the user's fresh copy.
    // The counterpart of the test below. A timed-out pbpaste says nothing about whether the app
    // copied, so treating it like the size ceiling stranded the sentinel on the device for good:
    // the user's clipboard destroyed, and an invisible marker pasted into the app under test.
    it('restores the original when a read fails for any reason other than size', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      const th = MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value
      pasteboard = 'THE USER ORIGINAL'
      let chordPressed = false
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        if (chordPressed) throw new PlatformError('Could not read the device clipboard: simctl pbpaste timed out')
        return pasteboard
      })
      th.sendKey.mockImplementation(() => { chordPressed = true })

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'slow', payload: { press: 'copy' },
      }))
      const err = await waitForType(browser, 'clipboard:error')
      expect(err.message).toMatch(/timed out/i)
      await vi.waitFor(() => expect(pasteboard).toBe('THE USER ORIGINAL'), { timeout: 2000 })
      expect(isSentinelish(pasteboard)).toBe(false)

      agent.disconnect(); browser.close()
    }, 10_000)

    it('keeps the device copy when the pasteboard is too large to read', async () => {
      const simctl = mockSimctl(true)
      const { agent, browser } = await bootWith(simctl)
      await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0), { timeout: 500 })
      const th = MockTouchHelper.mock.results[MockTouchHelper.mock.results.length - 1].value
      pasteboard = 'THE USER ORIGINAL'
      let sentinelSeen = ''
      let chordPressed = false
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        if (isSentinelish(pasteboard)) sentinelSeen = pasteboard
        // Only the post-chord read blows the buffer — the app has copied something huge by then.
        // The specific type is the point: SimctlWrapper classifies the size ceiling apart from
        // every other read failure, and only this one may skip the restore.
        if (chordPressed && !isSentinelish(pasteboard)) {
          throw new ClipboardTooLargeError('Could not read the device clipboard: stdout maxBuffer length exceeded')
        }
        return pasteboard
      })
      th.sendKey.mockImplementation(() => { chordPressed = true; pasteboard = 'HUGE COPIED TEXT' })

      browser.send(JSON.stringify({
        type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'big', payload: { press: 'copy' },
      }))
      const err = await waitForType(browser, 'clipboard:error')
      expect(err.message).toMatch(/maxBuffer|too large/i)
      expect(sentinelSeen).not.toBe('')                       // the handshake did run
      // and the restore must NOT have fired over the fresh copy
      expect(simctl.setPasteboard).not.toHaveBeenCalledWith('dev-1', 'THE USER ORIGINAL')

      agent.disconnect(); browser.close()
    }, 15_000)

    it('surfaces a pasteboard read failure as clipboard:error, not an empty string', async () => {
      const simctl = mockSimctl(true)
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Unable to connect to device pasteboard.'))
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'r9' }))
      const err = await waitForType(browser, 'clipboard:error')
      expect(err.requestId).toBe('r9')
      expect(err.message).toContain('pasteboard')

      agent.disconnect(); browser.close()
    })

    // Reading needs no TouchHelper, so unlike tap/swipe a plain read works on a session that
    // attached without going through device:boot (the H-E failure mode).
    it('a plain read works on a boot-less session', async () => {
      const simctl = mockSimctl(true)
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockResolvedValue('attached without boot')
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'r10' }))
      const data = await waitForType(browser, 'clipboard:data')
      expect((data.payload as { text: string }).text).toBe('attached without boot')

      agent.disconnect(); browser.close()
    })

    it('an empty pasteboard is data, not an error', async () => {
      const simctl = mockSimctl(true)
      ;(simctl.getPasteboard as ReturnType<typeof vi.fn>).mockResolvedValue('')
      const { agent, browser } = await bootWith(simctl)

      browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'r11' }))
      const data = await waitForType(browser, 'clipboard:data')
      expect((data.payload as { text: string }).text).toBe('')

      agent.disconnect(); browser.close()
    })
  })

})
