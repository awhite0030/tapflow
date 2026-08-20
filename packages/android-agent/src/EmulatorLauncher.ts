import { execFile, execFileSync, spawn } from 'child_process'
import { promisify } from 'util'
import { createLogger, PlatformError, ValidationError } from '@tapflowio/agent-core'

const execFileAsync = promisify(execFile)
const logger = createLogger('android-agent:emulator')

function getAdbPath(): string {
  if (process.env['ADB_PATH']) return process.env['ADB_PATH']
  const androidHome = process.env['ANDROID_HOME']
  if (!androidHome) throw new ValidationError('ANDROID_HOME not set')
  return `${androidHome}/platform-tools/adb`
}

function getEmulatorPath(): string {
  const androidHome = process.env['ANDROID_HOME']
  if (!androidHome) {
    throw new ValidationError(
      'ANDROID_HOME not set. Install Android SDK and set the environment variable.\n' +
      'Example: export ANDROID_HOME=$HOME/Library/Android/sdk',
    )
  }
  return `${androidHome}/emulator/emulator`
}

export interface EmulatorLaunchOpts {
  // Opt-in audio output; default off keeps `-no-audio` so the video-only path is unchanged.
  audio?: boolean
  // Full reset (#447) — wipe `userdata` before booting, the counterpart to iOS's `simctl erase`.
  // `-no-snapshot` below is **not** this: it is a cold boot, which skips the snapshot and keeps
  // userdata, so nothing here erased anything until this flag existed.
  wipeData?: boolean
}

/**
 * Find the running emulator's qemu PID by AVD name — the qemu process embeds `-avd <name>` in its
 * command line. Used to point the macOS mute-only audio tap at the emulator's host process so its
 * audio doesn't leak to the agent Mac's speakers (#341). Returns null when not found (not running yet,
 * or `pgrep` unavailable / exits 1 with no match). macOS only in practice; harmless elsewhere.
 */
export function findEmulatorPid(avdName: string): number | null {
  try {
    // Escape regex metacharacters so an AVD name like "Pixel.7" can't alter the pgrep -f pattern.
    const esc = avdName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const out = execFileSync('pgrep', ['-f', `qemu-system.*-avd ${esc}`], { encoding: 'utf8' })
    const pid = parseInt(out.trim().split('\n')[0] ?? '', 10)
    return Number.isFinite(pid) ? pid : null
  } catch { return null }
}

/**
 * Ask this AVD's emulator process to stop, without going through adb.
 *
 * `adb emu kill` is the graceful route and the one to prefer — but it needs a serial, and a serial
 * only exists once `adb devices` reports the emulator as `device`. An emulator that is still coming
 * up, or one whose adb server was restarted underneath it, has a live process and no serial, and
 * that is exactly the state Full reset must be able to clear (#447): a second emulator on the same
 * AVD would race the lock file.
 *
 * Only ever called on the wipe path, which is what makes SIGTERM acceptable — the user data this
 * could corrupt is being discarded in the next breath. Do not reach for this on an ordinary
 * shutdown, where a clean console stop is worth waiting for.
 *
 * Returns whether a process was signalled; `false` means there was nothing to stop.
 */
export function stopEmulatorProcess(avdName: string): boolean {
  const pid = findEmulatorPid(avdName)
  if (pid === null) return false
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    // Already gone between the lookup and the signal, or not ours to signal. `waitForExit` is what
    // decides whether the AVD is actually free, so a failure here is not the answer to that.
    return false
  }
}

/** Build the emulator CLI args. Pure + exported so the `-no-audio` gating is unit-testable. */
export function buildEmulatorArgs(avdName: string, grpcPort?: number, opts?: EmulatorLaunchOpts): string[] {
  const args = ['-avd', avdName]
  if (!opts?.audio) args.push('-no-audio')
  args.push('-no-snapshot', '-no-window', '-gpu', 'host')
  if (opts?.wipeData) args.push('-wipe-data')
  if (grpcPort !== undefined) args.push('-grpc', String(grpcPort))
  return args
}

export class EmulatorLauncher {
  /** `grpcPort`, when set, opens the emulator's unprotected localhost gRPC endpoint
   *  (`-grpc <port>`) for host-side screen capture + input — the same trust boundary as
   *  scrcpy's localhost ADB. Verified to work under `-no-window` headless. */
  launch(avdName: string, grpcPort?: number, opts?: EmulatorLaunchOpts): void {
    const args = buildEmulatorArgs(avdName, grpcPort, opts)
    const proc = spawn(getEmulatorPath(), args, {
      detached: true,
      stdio: 'ignore',
    })
    proc.on('error', (err) => logger.error(`emulator launch failed: ${err.message}`))
    proc.unref()
  }

  async findSerial(avdName: string, timeoutMs = 30_000): Promise<string> {
    const adb = getAdbPath()
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      try {
        const { stdout } = await execFileAsync(adb, ['devices'])
        const serials = stdout
          .split('\n')
          .slice(1)
          .map((l) => l.split('\t'))
          .filter(([s, state]) => s?.startsWith('emulator-') && state?.trim() === 'device')
          .map(([s]) => s.trim())

        for (const serial of serials) {
          const { stdout: name } = await execFileAsync(adb, [
            '-s', serial, 'emu', 'avd', 'name',
          ])
          if (name.split('\n')[0].trim() === avdName) return serial
        }
      } catch { /* not ready yet */ }

      await new Promise((r) => setTimeout(r, 2_000))
    }

    throw new PlatformError(`Could not find emulator serial for AVD "${avdName}" within ${timeoutMs / 1000}s`)
  }

  /** How long a `sys.boot_completed` poll may run. Named rather than inline **so a check can read it**:
   *  a relay client that gives up before this does reports a bare timeout for a boot that was proceeding
   *  normally (#549), and the two numbers live in different packages. A caller may still pass its own —
   *  which the check cannot see, and says so. */
  static readonly BOOT_READY_TIMEOUT_MS = 120_000

  /** How long to wait for a stopped emulator's qemu process to actually exit. */
  static readonly EXIT_TIMEOUT_MS = 30_000

  /**
   * Wait until no qemu process is holding this AVD.
   *
   * `adb emu kill` returns as soon as the emulator console accepts it, and the process dies some
   * time after — so a relaunch issued immediately races the AVD directory's lock file. Only Full
   * reset (#447) needs this, because it is the one path that stops an emulator to start it again.
   *
   * **Throws on timeout, and that is the whole point.** Proceeding to launch looks like the
   * forgiving choice and is the dangerous one: the second emulator loses the lock and exits, and
   * nothing here notices — `launch` spawns `detached` with `stdio: 'ignore'` and reads no exit
   * code, while `findSerial` scans `adb devices` for **any** emulator answering to this AVD name,
   * so it returns the survivor. `waitForBoot` then passes instantly against a device that is
   * already up, and the session reports Full reset complete on a device that was never wiped.
   * A failed boot the tester can see beats a silent lie about erasing their data.
   *
   * `findEmulatorPid` answers `null` when `pgrep` finds nothing **and** when it cannot run at all,
   * so on a host without `pgrep` this returns immediately rather than blocking a boot — the same
   * shape the audio tap relies on, and the reason this is a wait rather than a proof.
   */
  async waitForExit(avdName: string, timeoutMs = EmulatorLauncher.EXIT_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (findEmulatorPid(avdName) === null) return
      if (Date.now() >= deadline) {
        throw new PlatformError(
          `Emulator "${avdName}" was still running ${timeoutMs / 1000}s after being asked to stop, ` +
          'so it could not be wiped and relaunched.',
        )
      }
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  async waitForBoot(serial: string, timeoutMs = EmulatorLauncher.BOOT_READY_TIMEOUT_MS): Promise<void> {
    const adb = getAdbPath()

    // Wait for device to appear in ADB
    await execFileAsync(adb, ['-s', serial, 'wait-for-device'])

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const { stdout } = await execFileAsync(adb, [
          '-s', serial, 'shell', 'getprop', 'sys.boot_completed',
        ])
        if (stdout.trim() === '1') return
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 3_000))
    }

    throw new PlatformError(`Emulator ${serial} did not finish booting within ${timeoutMs / 1000}s`)
  }
}
