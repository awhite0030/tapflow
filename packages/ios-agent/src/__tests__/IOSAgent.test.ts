import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { ValidationError, PlatformError, MAX_CLIPBOARD_BYTES } from '@tapflowio/agent-core'
import { ClipboardTooLargeError } from '../SimctlWrapper.js'

vi.mock('../TouchHelper', () => ({
  TouchHelper: vi.fn(function () { return ({
    start: vi.fn(),
    stop: vi.fn(),
    touchStart: vi.fn(),
    touchMove: vi.fn(),
    touchEnd: vi.fn(),
    pressButton: vi.fn(),
    pressButtonDown: vi.fn(),
    pressButtonUp: vi.fn(),
    pressLegacyButton: vi.fn(),
    pinchStart: vi.fn(),
    pinchMove: vi.fn(),
    pinchEnd: vi.fn(),
    sendKey: vi.fn(),
  }) }),
}))

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

const waitForOpen = (ws: WebSocket) =>
  new Promise<void>((r) => ws.once('open', r))

const waitForType = (ws: WebSocket, type: string) =>
  new Promise<Record<string, unknown>>((r) => {
    const listener = (d: Buffer) => {
      try {
        const msg = JSON.parse(d.toString())
        if (msg.type === type) {
          ws.off('message', listener)
          r(msg)
        }
      } catch { /* binary frame — ignore */ }
    }
    ws.on('message', listener)
  })

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
  return {
    listDevices: vi.fn().mockResolvedValue([
      { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status, osVersion: 'iOS 18.3' },
    ]),
    boot: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    erase: vi.fn().mockResolvedValue(undefined),
    uninstallApp: vi.fn().mockResolvedValue(undefined),
    clearAppData: vi.fn().mockResolvedValue(undefined),
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
      browser.send(JSON.stringify({ type: 'input:touch:end', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))

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
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      const done = waitForType(browser, 'input:done')
      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      browser.send(JSON.stringify({ type: 'input:touch:end', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      expect((await done).sessionId).toBe(agent.sessionId)

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
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      // Power the device off: shutdown clears the booted flag, and simctl now reports it shut down.
      ;(simctl.listDevices as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'dev-1', name: 'iPhone 15', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.3' },
      ])
      browser.send(JSON.stringify({ type: 'device:shutdown', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:shutdown-done')

      const errored = waitForType(browser, 'input:error')
      browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      browser.send(JSON.stringify({ type: 'input:touch:end', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
      const e = await errored
      expect(e.sessionId).toBe(agent.sessionId)
      expect(e.message).toBe('device not booted')

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

      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
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
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(1), { timeout: 500 })
      const thInstance = MockTouchHelper.mock.results[0].value

      // register the ack listener before sending — the done can arrive before
      // the assertions below finish awaiting
      const done = waitForType(browser, 'input:type-done')
      browser.send(JSON.stringify({ type: 'input:type', sessionId: agent.sessionId, payload: { text: '안녕 hi' } }))
      // the ack must arrive AFTER the work completed — so once done lands, the
      // pasteboard write and Cmd+V (KeyV 0x19, MetaLeft 0x08) are already done.
      // (a synchronous check here, not waitFor, so moving .then(done) ahead of
      // the paste would fail this test — the ordering is what's under guard)
      expect((await done).sessionId).toBe(agent.sessionId)
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
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(1), { timeout: 500 })

      // bring the software keyboard up first
      browser.send(JSON.stringify({ type: 'input:keyboard:toggle', sessionId: agent.sessionId }))
      await waitForType(browser, 'keyboard:toggled')

      const typed = waitForType(browser, 'input:type-done')
      browser.send(JSON.stringify({ type: 'input:type', sessionId: agent.sessionId, payload: { text: 'hi' } }))
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
      browser.send(JSON.stringify({ type: 'input:pinch:end', sessionId: agent.sessionId }))
      await vi.waitFor(() => expect(thInstance.pinchEnd).toHaveBeenCalled(), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    // home has no HID down/up split — a down+up pair from the dashboard must not fire it twice.
    it('input:button home (no phase) presses the legacy button once', async () => {
      const { browser, agent, thInstance } = await setupPinchSession()
      browser.send(JSON.stringify({ type: 'input:button', sessionId: agent.sessionId, payload: { name: 'home' } }))
      await vi.waitFor(() => expect(thInstance.pressLegacyButton).toHaveBeenCalledWith(0), { timeout: 500 })
      expect(thInstance.pressLegacyButton).toHaveBeenCalledTimes(1)
      agent.disconnect()
      browser.close()
    })

    it('input:button home fires only on the up phase, not on down', async () => {
      const { browser, agent, thInstance } = await setupPinchSession()
      browser.send(JSON.stringify({ type: 'input:button', sessionId: agent.sessionId, payload: { name: 'home', phase: 'down' } }))
      browser.send(JSON.stringify({ type: 'input:button', sessionId: agent.sessionId, payload: { name: 'home', phase: 'up' } }))
      await vi.waitFor(() => expect(thInstance.pressLegacyButton).toHaveBeenCalledWith(0), { timeout: 500 })
      expect(thInstance.pressLegacyButton).toHaveBeenCalledTimes(1)
      agent.disconnect()
      browser.close()
    })
  })

  describe('device:boot handler', () => {
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
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))

      await bootingPromise
      const ready = await readyPromise
      expect((ready.payload as { deviceId: string }).deviceId).toBe('dev-1')
      expect(simctl.boot).toHaveBeenCalledWith('dev-1')

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
          type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' },
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
          type: 'device:boot', sessionId: second[0], payload: { deviceId: 'dev-2' },
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
          sessionId: second[0],
          payload: { filePath: '/tmp/x.app', bundleId: 'com.example.app' },
        })
        await vi.waitFor(() => expect(simctl.installApp).toHaveBeenCalled())

        expect(simctl.installApp).toHaveBeenCalledWith('dev-2', '/tmp/x.app')

        agent.disconnect()
      })

      it('install carries the udid', async () => {
        const { simctl, agent, browser } = await bootedAgent()

        deliver(agent, {
          type: 'app:install',
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
          sessionId: agent.sessionId,
          payload: { bundleId: 'com.example.app' },
        })
        await vi.waitFor(() => expect(simctl.launchApp).toHaveBeenCalled())

        expect(simctl.launchApp).toHaveBeenCalledWith('dev-1', 'com.example.app')

        agent.disconnect(); browser.close()
      })

      it('clear-state carries the udid', async () => {
        const { simctl, agent, browser } = await bootedAgent()

        deliver(agent, {
          type: 'app:clear-state',
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

      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')

      expect(simctl.erase).not.toHaveBeenCalled()
      expect(simctl.boot).toHaveBeenCalledWith('dev-1')

      agent.disconnect()
      browser.close()
    })

    it('skips boot call for already-booted device', async () => {
      const simctl = mockSimctl(true)
      const agent = new IOSAgent({ intervalMs: 50 }, simctl)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const readyPromise = waitForType(browser, 'device:ready')
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await readyPromise
      expect(simctl.boot).not.toHaveBeenCalled()

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
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
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
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
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
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
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

      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
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
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
      await waitForType(browser, 'device:ready')
      await vi.waitFor(() => expect(MockTouchHelper.mock.results).toHaveLength(1), { timeout: 500 })
      const thInstance = MockTouchHelper.mock.results[0].value
      return { browser, agent, thInstance }
    }

    it('input:key Backspace calls touchHelper.sendKey with HID usage 0x2A', async () => {
      const { browser, agent, thInstance } = await setupSession()
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'Backspace', modifiers: 0 } }))
      await vi.waitFor(() => expect(thInstance.sendKey).toHaveBeenCalledWith(HID_BACKSPACE, 0), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    it('input:key KeyA calls touchHelper.sendKey with HID usage 0x04', async () => {
      const { browser, agent, thInstance } = await setupSession()
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
      await vi.waitFor(() => expect(thInstance.sendKey).toHaveBeenCalledWith(HID_KEY_A, 0), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    it('input:key with Shift modifier forwards modifier bits', async () => {
      const { browser, agent, thInstance } = await setupSession()
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0x02 } }))
      await vi.waitFor(() => expect(thInstance.sendKey).toHaveBeenCalledWith(HID_KEY_A, 0x02), { timeout: 500 })
      agent.disconnect()
      browser.close()
    })

    it('input:key unknown code is silently dropped', async () => {
      const { browser, agent, thInstance } = await setupSession()
      // Send unknown key first, then a known key as a sentinel.
      // WebSocket messages are ordered — when KeyA is processed, UnknownKey was already processed.
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'UnknownKey', modifiers: 0 } }))
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
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
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
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
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
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
      browser.send(JSON.stringify({ type: 'input:key', sessionId: agent.sessionId, payload: { code: 'KeyA', modifiers: 0 } }))
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
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
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
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
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
      browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, payload: { deviceId: 'dev-1' } }))
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
