import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SimctlWrapper, isDeviceMissingError } from '../SimctlWrapper'
import type { SimctlRunner, SimctlExecOpts } from '../simctl'

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (err: null, stdout: string, stderr: string) => void) => {
    cb(null, '', '')
    return { on: vi.fn() }
  }),
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      unlink: vi.fn().mockResolvedValue(undefined),
    },
  }
})

const SIMCTL_LIST_OUTPUT = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
      { udid: 'device-1', name: 'iPhone 15', state: 'Booted', isAvailable: true },
      { udid: 'device-2', name: 'iPhone 15 Pro', state: 'Shutdown', isAvailable: true },
      { udid: 'device-3', name: 'iPhone 14', state: 'Shutdown', isAvailable: false },
    ],
  },
})

function mockRunner(outputs: Record<string, string> = {}): SimctlRunner {
  return {
    exec: vi.fn(async (...args: string[]) => outputs[args[0]] ?? ''),
    execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    execWithOpts: vi.fn(async (_opts: SimctlExecOpts, ...args: string[]) => outputs[args[0]] ?? ''),
  }
}

describe('SimctlWrapper', () => {
  describe('listDevices', () => {
    it('returns only available devices', async () => {
      const runner = mockRunner({ list: SIMCTL_LIST_OUTPUT })
      const wrapper = new SimctlWrapper(runner)
      const devices = await wrapper.listDevices()
      expect(devices).toHaveLength(2)
    })

    it('maps state to DeviceStatus correctly', async () => {
      const runner = mockRunner({ list: SIMCTL_LIST_OUTPUT })
      const wrapper = new SimctlWrapper(runner)
      const devices = await wrapper.listDevices()
      expect(devices.find((d) => d.id === 'device-1')?.status).toBe('booted')
      expect(devices.find((d) => d.id === 'device-2')?.status).toBe('shutdown')
    })

    it('sets platform to ios', async () => {
      const runner = mockRunner({ list: SIMCTL_LIST_OUTPUT })
      const wrapper = new SimctlWrapper(runner)
      const [device] = await wrapper.listDevices()
      expect(device.platform).toBe('ios')
    })
  })

  describe('boot', () => {
    it('calls simctl boot with the deviceId', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.boot('device-1')
      expect(runner.exec).toHaveBeenCalledWith('boot', 'device-1')
    })

    it('does not throw if device is already booted', async () => {
      const runner: SimctlRunner = {
        exec: vi.fn().mockRejectedValue(
          Object.assign(new Error(), { stderr: 'Unable to boot device in current state: Booted' })
        ),
      }
      const wrapper = new SimctlWrapper(runner)
      await expect(wrapper.boot('device-1')).resolves.toBeUndefined()
    })

    it('rethrows unexpected errors', async () => {
      const runner: SimctlRunner = {
        exec: vi.fn().mockRejectedValue(new Error('xcrun not found')),
      }
      const wrapper = new SimctlWrapper(runner)
      await expect(wrapper.boot('device-1')).rejects.toThrow('xcrun not found')
    })
  })

  describe('shutdown', () => {
    it('calls simctl shutdown with the deviceId', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.shutdown('device-1')
      expect(runner.exec).toHaveBeenCalledWith('shutdown', 'device-1')
    })
  })

  describe('installApp', () => {
    it('calls simctl install booted with the app path', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.installApp('/path/to/App.app')
      expect(runner.exec).toHaveBeenCalledWith('install', 'booted', '/path/to/App.app')
    })
  })

  describe('launchApp', () => {
    it('calls simctl launch booted with the bundleId', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.launchApp('com.example.app')
      expect(runner.exec).toHaveBeenCalledWith('launch', 'booted', 'com.example.app')
    })

    it('parses the launched host PID from simctl output (for the audiotap-helper)', async () => {
      const runner = mockRunner({ launch: 'com.example.app: 90210\n' })
      const wrapper = new SimctlWrapper(runner)
      await expect(wrapper.launchApp('com.example.app')).resolves.toBe(90210)
    })

    it('returns null when no PID can be parsed', async () => {
      const runner = mockRunner({ launch: '' })
      const wrapper = new SimctlWrapper(runner)
      await expect(wrapper.launchApp('com.example.app')).resolves.toBeNull()
    })
  })

  describe('openUrl', () => {
    it('calls simctl openurl with the device udid and url', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.openUrl('device-1', 'myapp://home')
      expect(runner.exec).toHaveBeenCalledWith('openurl', 'device-1', 'myapp://home')
    })
  })

  describe('rotate', () => {
    it('calls rotation-helper with landscapeRight', async () => {
      const { execFile } = await import('child_process')
      const wrapper = new SimctlWrapper()
      await wrapper.rotate('device-1', 'landscapeRight')
      expect(vi.mocked(execFile)).toHaveBeenCalledWith(
        expect.stringContaining('rotation-helper'),
        ['landscapeRight', 'device-1'],
        expect.any(Function),
      )
    })

    it('calls rotation-helper with portrait', async () => {
      const { execFile } = await import('child_process')
      const wrapper = new SimctlWrapper()
      await wrapper.rotate('device-1', 'portrait')
      expect(vi.mocked(execFile)).toHaveBeenCalledWith(
        expect.stringContaining('rotation-helper'),
        ['portrait', 'device-1'],
        expect.any(Function),
      )
    })
  })

  describe('syncKeyboardsFromLanguages', () => {
    it('writes AppleKeyboards with hw=Automatic entries matching AppleLanguages', async () => {
      const runner: SimctlRunner = {
        exec: vi.fn()
          .mockResolvedValueOnce('(\n    "ko-KR",\n    "en-US"\n)')  // defaults read
          .mockResolvedValue(''),                                       // write + kickstart
        execBinary: vi.fn(),
      }
      const wrapper = new SimctlWrapper(runner)
      await wrapper.syncKeyboardsFromLanguages('device-1')

      expect(runner.exec).toHaveBeenCalledWith(
        'spawn', 'device-1', 'defaults', 'write', '-g', 'AppleKeyboards', '-array',
        'ko_KR@sw=Korean;hw=Automatic',
        'en_US@sw=QWERTY;hw=Automatic',
        'emoji@sw=Emoji',
      )
    })

    it('appends en_US fallback when English is not in AppleLanguages', async () => {
      const runner: SimctlRunner = {
        exec: vi.fn()
          .mockResolvedValueOnce('(\n    "ko-KR"\n)')
          .mockResolvedValue(''),
        execBinary: vi.fn(),
      }
      const wrapper = new SimctlWrapper(runner)
      await wrapper.syncKeyboardsFromLanguages('device-1')

      const writeCall = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: string[]) => c[2] === 'defaults' && c[3] === 'write',
      ) as string[]
      expect(writeCall).toContain('en_US@sw=QWERTY;hw=Automatic')
    })

    it('does nothing when AppleLanguages is empty or unset', async () => {
      const runner: SimctlRunner = {
        exec: vi.fn().mockRejectedValue(new Error('Domain does not exist')),
        execBinary: vi.fn(),
      }
      const wrapper = new SimctlWrapper(runner)
      await wrapper.syncKeyboardsFromLanguages('device-1')

      // No write call should have been made
      expect(runner.exec).toHaveBeenCalledTimes(1)
    })

    it('ignores kickstart failure gracefully', async () => {
      const runner: SimctlRunner = {
        exec: vi.fn()
          .mockResolvedValueOnce('(\n    "en-US"\n)')  // read
          .mockResolvedValueOnce('')                    // write
          .mockRejectedValueOnce(new Error('kbd not found')), // kickstart fails
        execBinary: vi.fn(),
      }
      const wrapper = new SimctlWrapper(runner)
      await expect(wrapper.syncKeyboardsFromLanguages('device-1')).resolves.toBeUndefined()
    })
  })

  describe('screenshot', () => {
    beforeEach(() => vi.clearAllMocks())

    it('saves to temp file and returns PNG buffer', async () => {
      const { promises: fsMock } = await import('fs')
      const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      vi.mocked(fsMock.readFile as (path: string) => Promise<Buffer>).mockResolvedValue(pngMagic)

      const runner: SimctlRunner = {
        exec: vi.fn().mockResolvedValue(''),
        execBinary: vi.fn(),
      }
      const wrapper = new SimctlWrapper(runner)
      const buf = await wrapper.screenshot()

      expect(runner.exec).toHaveBeenCalledWith(
        'io', 'booted', 'screenshot', '--type', 'png',
        expect.stringMatching(/tapflow-.+\.png$/)
      )
      expect(buf).toEqual(pngMagic)
    })
  })

  describe('isDeviceMissingError', () => {
    it('matches the "cannot be located on disk" signature', () => {
      expect(isDeviceMissingError(new Error(
        'Unable to boot device because it cannot be located on disk.',
      ))).toBe(true)
    })

    it('matches the "data is no longer present" signature', () => {
      expect(isDeviceMissingError(new Error(
        "The device's data is no longer present at /Users/x/.../data.",
      ))).toBe(true)
    })

    it('reads the signature from the error stderr field too', () => {
      expect(isDeviceMissingError(
        Object.assign(new Error('Command failed: xcrun simctl boot'), {
          stderr: 'Unable to boot device because it cannot be located on disk.',
        }),
      )).toBe(true)
    })

    it('does NOT match unrelated boot failures (guards against erasing healthy devices)', () => {
      expect(isDeviceMissingError(new Error('Unable to boot device in current state: Booted'))).toBe(false)
      expect(isDeviceMissingError(new Error('operation timed out'))).toBe(false)
      expect(isDeviceMissingError(new Error('xcrun: command not found'))).toBe(false)
    })

    it('returns false for non-error values', () => {
      expect(isDeviceMissingError(undefined)).toBe(false)
      expect(isDeviceMissingError(null)).toBe(false)
      expect(isDeviceMissingError('cannot be located on disk')).toBe(false)
    })
  })

  describe('clearAppData', () => {
    it('wipes Documents/Library/tmp contents but keeps the container structure', async () => {
      const os = await import('os')
      const path = await import('path')
      const realFs = (await vi.importActual<typeof import('fs')>('fs')).promises
      const container = await realFs.mkdtemp(path.join(os.tmpdir(), 'tapflow-container-'))
      await realFs.mkdir(path.join(container, 'Documents'))
      await realFs.mkdir(path.join(container, 'Library', 'Caches'), { recursive: true })
      await realFs.mkdir(path.join(container, 'tmp'))
      await realFs.writeFile(path.join(container, 'Documents', 'user.db'), 'data')
      await realFs.writeFile(path.join(container, 'Library', 'Caches', 'c.bin'), 'cache')
      await realFs.writeFile(path.join(container, 'tmp', 'scratch.dat'), 'tmp')
      await realFs.writeFile(path.join(container, '.metadata.plist'), 'meta')

      const runner = mockRunner({ get_app_container: `${container}\n` })
      const wrapper = new SimctlWrapper(runner)
      await wrapper.clearAppData('com.example.app')

      expect(runner.exec).toHaveBeenCalledWith('terminate', 'booted', 'com.example.app')
      expect(await realFs.readdir(path.join(container, 'Documents'))).toEqual([])
      expect(await realFs.readdir(path.join(container, 'Library'))).toEqual([])
      expect(await realFs.readdir(path.join(container, 'tmp'))).toEqual([])
      // container root structure and metadata survive (unlike uninstall)
      expect(await realFs.readdir(container)).toContain('.metadata.plist')
      expect(await realFs.readdir(container)).toContain('Documents')

      await realFs.rm(container, { recursive: true, force: true })
    })

    it('throws PlatformError when the data container cannot be resolved', async () => {
      const runner = mockRunner({ get_app_container: 'No such file or directory\n' })
      const wrapper = new SimctlWrapper(runner)
      await expect(wrapper.clearAppData('com.unknown')).rejects.toThrow(/data container/)
    })
  })

  // Routed through the runner (rather than spawning directly) so the clipboard gets the same
  // CoreSimulatorService recovery as every other simctl call — and so it is testable at all.
  describe('pasteboard', () => {
    it('reads through the runner, bounded by a timeout and a size ceiling', async () => {
      const runner = mockRunner({ pbpaste: 'on the device' })
      const wrapper = new SimctlWrapper(runner)

      await expect(wrapper.getPasteboard('dev-1')).resolves.toBe('on the device')
      const [opts, ...args] = vi.mocked(runner.execWithOpts).mock.calls[0]
      expect(args).toEqual(['pbpaste', 'dev-1'])
      expect(opts.timeoutMs).toBeGreaterThan(0)
      // The ceiling lives here, which is why callers do not re-check the length.
      expect(opts.maxBuffer).toBeGreaterThan(0)
    })

    it('writes the text on stdin — pbcopy cannot take it as an argument', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)

      await wrapper.setPasteboard('dev-1', '한글 🎉\nline2')
      const [opts, ...args] = vi.mocked(runner.execWithOpts).mock.calls[0]
      expect(args).toEqual(['pbcopy', 'dev-1'])
      expect(opts.input).toBe('한글 🎉\nline2')
      expect(opts.timeoutMs).toBeGreaterThan(0)
    })

    it('returns the pasteboard verbatim — a trailing newline can be part of the copied text', async () => {
      const runner = mockRunner({ pbpaste: 'text\n' })
      await expect(new SimctlWrapper(runner).getPasteboard('dev-1')).resolves.toBe('text\n')
    })

    // These messages reach a user-facing toast, so they must not be Node's argv line.
    it('condenses a read failure and never surfaces the argv line', async () => {
      const runner = mockRunner()
      vi.mocked(runner.execWithOpts).mockRejectedValue(
        new Error('Command failed: xcrun simctl pbpaste UDID\nUnable to connect to device pasteboard.'),
      )
      await expect(new SimctlWrapper(runner).getPasteboard('dev-1'))
        .rejects.toThrow(/Unable to connect to device pasteboard/)
      await expect(new SimctlWrapper(runner).getPasteboard('dev-1'))
        .rejects.not.toThrow(/Command failed:/)
    })

    // The timeout path produces no stderr, which used to fall through to the argv line.
    it('condenses a bare failure with no usable line', async () => {
      const runner = mockRunner()
      vi.mocked(runner.execWithOpts).mockRejectedValue(new Error('Command failed: xcrun simctl pbcopy UDID'))
      await expect(new SimctlWrapper(runner).setPasteboard('dev-1', 'x'))
        .rejects.toThrow(/did not respond/)
    })

    it('wraps write failures too, not just reads', async () => {
      const runner = mockRunner()
      vi.mocked(runner.execWithOpts).mockRejectedValue(new Error('boom'))
      await expect(new SimctlWrapper(runner).setPasteboard('dev-1', 'x'))
        .rejects.toThrow(/Could not write the device clipboard/)
    })
  })
})
