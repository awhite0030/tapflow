import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// `launch` spawns and `findEmulatorPid` pgreps; both go through child_process, and both are
// **production code no test reached before** — the seam between `buildEmulatorArgs` and the process
// that receives its argv had nothing covering it, so dropping `opts` from the call inside `launch`
// left the whole suite green while killing `-wipe-data` (#447) and `-no-audio` (#341) together.
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
  execFile: vi.fn(),
  execFileSync: vi.fn(() => ''),
}))

import { spawn, execFileSync } from 'child_process'
import { buildEmulatorArgs, EmulatorLauncher, findEmulatorPid, stopEmulatorProcess } from '../EmulatorLauncher'

describe('buildEmulatorArgs', () => {
  it('includes -no-audio by default (audio off — video path unchanged)', () => {
    const args = buildEmulatorArgs('Pixel', 8554)
    expect(args).toContain('-no-audio')
    expect(args).toEqual(['-avd', 'Pixel', '-no-audio', '-no-snapshot', '-no-window', '-gpu', 'host', '-grpc', '8554'])
  })

  it('drops -no-audio when audio is enabled, leaving all other args intact', () => {
    const args = buildEmulatorArgs('Pixel', 8554, { audio: true })
    expect(args).not.toContain('-no-audio')
    expect(args).toEqual(['-avd', 'Pixel', '-no-snapshot', '-no-window', '-gpu', 'host', '-grpc', '8554'])
  })

  it('omits -grpc when no port given', () => {
    const args = buildEmulatorArgs('Pixel')
    expect(args).not.toContain('-grpc')
    expect(args).toContain('-no-audio')
  })

  it('explicit audio:false keeps -no-audio (parity with default)', () => {
    expect(buildEmulatorArgs('Pixel', 8554, { audio: false })).toContain('-no-audio')
  })

  // #447: the counterpart to iOS's `simctl erase`. `-no-snapshot` above is a **cold boot** — it skips
  // the snapshot and keeps `userdata`, so nothing here wiped anything before this flag.
  describe('wipeData', () => {
    it('adds -wipe-data, leaving every other arg where it was', () => {
      const args = buildEmulatorArgs('Pixel', 8554, { wipeData: true })
      expect(args).toEqual(
        ['-avd', 'Pixel', '-no-audio', '-no-snapshot', '-no-window', '-gpu', 'host', '-wipe-data', '-grpc', '8554'],
      )
    })

    it('is absent by default, so an ordinary boot keeps userdata', () => {
      expect(buildEmulatorArgs('Pixel', 8554)).not.toContain('-wipe-data')
      expect(buildEmulatorArgs('Pixel', 8554, { wipeData: false })).not.toContain('-wipe-data')
    })

    // The two options are independent knobs and a session can arm both — asserted because the
    // obvious implementation (one `if/else` over `opts`) passes each of the tests above alone.
    it('composes with audio rather than replacing it', () => {
      const args = buildEmulatorArgs('Pixel', 8554, { wipeData: true, audio: true })
      expect(args).toContain('-wipe-data')
      expect(args).not.toContain('-no-audio')
    })
  })
})

describe('EmulatorLauncher.launch', () => {
  beforeEach(() => vi.mocked(spawn).mockClear())

  /** The argv the emulator process is actually given. */
  function argvOf(): string[] {
    return vi.mocked(spawn).mock.calls[0]?.[1] as string[]
  }

  it('hands buildEmulatorArgs output to the spawned process, options included', () => {
    new EmulatorLauncher().launch('Pixel', 8554, { wipeData: true })
    expect(argvOf()).toEqual(buildEmulatorArgs('Pixel', 8554, { wipeData: true }))
    expect(argvOf()).toContain('-wipe-data')
  })

  // Named separately from the case above because they fail to different mutations: dropping `opts`
  // from the `buildEmulatorArgs` call inside `launch` kills both flags at once, and each of these
  // is the only assertion in the package that would say so for its own flag.
  it('still gates audio through the same call', () => {
    new EmulatorLauncher().launch('Pixel', 8554)
    expect(argvOf()).toContain('-no-audio')
    vi.mocked(spawn).mockClear()
    new EmulatorLauncher().launch('Pixel', 8554, { audio: true })
    expect(argvOf()).not.toContain('-no-audio')
  })
})

describe('waitForExit', () => {
  beforeEach(() => vi.mocked(execFileSync).mockReset())
  afterEach(() => vi.useRealTimers())

  /** `findEmulatorPid` parses `pgrep` stdout; no match parses to NaN, which it reports as null.
   *  (`pgrep` also exits 1 on no match — that path is the function's own `catch`, covered by the
   *  `findEmulatorPid` describe below rather than by re-throwing through every wait test.) */
  const NONE = ''
  const pgrepReturns = (...results: string[]) => {
    let i = 0
    vi.mocked(execFileSync).mockImplementation(
      () => results[Math.min(i++, results.length - 1)]!,
    )
  }

  it('returns as soon as no process holds the AVD', async () => {
    pgrepReturns(NONE)
    await expect(new EmulatorLauncher().waitForExit('Pixel', 1_000)).resolves.toBeUndefined()
  })

  // The direction matters more than the wait: inverted, this returns while the emulator is alive
  // and hands the relaunch the lock race it exists to prevent.
  it('keeps waiting while a process is still there, then returns when it goes', async () => {
    pgrepReturns('4321\n', '4321\n', NONE)
    await expect(new EmulatorLauncher().waitForExit('Pixel', 5_000)).resolves.toBeUndefined()
    expect(vi.mocked(execFileSync).mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  // Throwing is the whole contract. Returning here would let the caller launch a second emulator
  // on a locked AVD, and nothing downstream can tell that apart from a successful wipe — `launch`
  // reads no exit code and `findSerial` would return the survivor's serial.
  it('throws when the emulator outlives the deadline, naming the AVD', async () => {
    pgrepReturns('4321\n')
    await expect(new EmulatorLauncher().waitForExit('Pixel', 300))
      .rejects.toThrow(/Pixel/)
  })
})

describe('stopEmulatorProcess', () => {
  beforeEach(() => vi.mocked(execFileSync).mockReset())

  it('signals the pid it found', () => {
    vi.mocked(execFileSync).mockReturnValue('4321\n')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect(stopEmulatorProcess('Pixel')).toBe(true)
    expect(kill).toHaveBeenCalledWith(4321, 'SIGTERM')
    kill.mockRestore()
  })

  it('reports false when nothing is running, without signalling', () => {
    vi.mocked(execFileSync).mockReturnValue('')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect(stopEmulatorProcess('Pixel')).toBe(false)
    expect(kill).not.toHaveBeenCalled()
    kill.mockRestore()
  })

  // A pid that died between the lookup and the signal is not a failure to stop it.
  it('reports false rather than throwing when the signal is refused', () => {
    vi.mocked(execFileSync).mockReturnValue('4321\n')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH') })
    expect(stopEmulatorProcess('Pixel')).toBe(false)
    kill.mockRestore()
  })
})

describe('findEmulatorPid', () => {
  beforeEach(() => vi.mocked(execFileSync).mockReset())

  // `pgrep` exiting non-zero (no match, or not installed) reaches the same `return null` as the
  // empty-output case above, and that outcome is what every caller depends on — it is why
  // `waitForExit` is safe to call on a host that cannot look. **Not covered directly**: an error
  // thrown from inside `vi.fn().mockImplementation` is reported as a test failure by this runner
  // even when the production `catch` swallows it (verified — `expect(...).not.toThrow()` passes and
  // the error is still raised alongside it), so the exit-1 branch cannot be exercised here without
  // asserting on the harness instead of the code.

  it('escapes regex metacharacters in the AVD name', () => {
    vi.mocked(execFileSync).mockReturnValue('1\n')
    findEmulatorPid('Pixel.7')
    const pattern = (vi.mocked(execFileSync).mock.calls[0]?.[1] as string[])[1]
    expect(pattern).toContain('Pixel\\.7')
  })
})
