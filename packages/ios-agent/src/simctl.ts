import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { createLogger } from '@tapflowio/agent-core'

const logger = createLogger('ios-agent:simctl')

const execFileAsync = promisify(execFile)

// stderr is only ever read to build an error message, so a runaway one is pure waste.
const MAX_STDERR_BYTES = 64 * 1024

function isCoreSimulatorVersionMismatch(err: unknown): boolean {
  const msg = (err as { stderr?: string; message?: string }).stderr
    ?? (err as { message?: string }).message ?? ''
  return msg.includes('CoreSimulator.framework was changed') ||
    msg.includes('Service version') && msg.includes('does not match expected service version')
}

async function restartCoreSimulatorService(): Promise<void> {
  // SIGKILL (-9) guarantees the process dies even if it ignores SIGTERM
  await execFileAsync('killall', ['-9', 'com.apple.CoreSimulator.CoreSimulatorService']).catch(() => {})
  await new Promise<void>((r) => setTimeout(r, 3000))
}

/** Options for calls the plain `exec(...args)` shape cannot express. */
export interface SimctlExecOpts {
  /** Text to write to stdin — `pbcopy` takes its payload that way, not as an argument. */
  input?: string
  /** Kill the command after this long. Deliberately per-call: a blanket timeout would break
   *  legitimately slow calls like `install`. */
  timeoutMs?: number
  /** Ceiling on stdout. Exceeding it rejects rather than buffering without bound. */
  maxBuffer?: number
}

/** Thrown when a call blows its `maxBuffer`. Distinguishable on purpose: for the clipboard, an
 *  over-sized read means the app DID copy and the text simply cannot be carried, whereas a
 *  timeout means nothing is known — and the two need opposite recovery. */
export class OutputTooLargeError extends Error {}

export interface SimctlRunner {
  exec(...args: string[]): Promise<string>
  execBinary(...args: string[]): Promise<Buffer>
  /** Same CoreSimulatorService recovery as `exec`, for calls that need stdin or bounds.
   *  Kept separate so the two shapes above stay untouched for their many callers. */
  execWithOpts(opts: SimctlExecOpts, ...args: string[]): Promise<string>
}

const CORE_SIM_DOCS_URL = 'https://tapflow.dev/guide/troubleshooting#ios-simulator-service-version-mismatch'

function coreSimServiceError(): Error {
  return new Error(
    'CoreSimulatorService version mismatch — the service could not be recovered automatically.\n' +
    'Run the following command and try again:\n\n' +
    '  killall -9 com.apple.CoreSimulator.CoreSimulatorService\n\n' +
    `See ${CORE_SIM_DOCS_URL}`,
  )
}

// `input` rules out execFile (it has no stdin channel), so this spawns and pumps stdin itself.
// Everything else — timeout, stdout ceiling, exit-code handling — is reproduced here rather
// than inherited, which is the price of `pbcopy` not being expressible as arguments.
function runWithOpts(opts: SimctlExecOpts, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn('xcrun', ['simctl', ...args])
    // Accumulate BYTES and decode once at the end. Decoding each chunk as it arrives splits
    // multi-byte characters at pipe boundaries and turns them into U+FFFD — execFile avoided
    // that by running stdout through a StringDecoder, and this path has to reproduce it.
    // Keeping bytes also makes the maxBuffer accounting exact instead of measuring a string
    // that may already contain replacement characters.
    const chunks: Buffer[] = []
    let bytes = 0
    const stderrChunks: Buffer[] = []
    let stderrBytes = 0
    let over = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (err?: Error, out?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(out ?? '')
    }

    proc.stdout?.on('data', (d: Buffer) => {
      chunks.push(d)
      bytes += d.length
      if (opts.maxBuffer && bytes > opts.maxBuffer) {
        over = true
        proc.kill('SIGKILL')
        finish(new OutputTooLargeError('stdout maxBuffer length exceeded'))
      }
    })
    // Same treatment as stdout: keep bytes, decode once. Bounded like execFile bounded it.
    proc.stderr?.on('data', (d: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return
      // Slice to the remaining budget: testing before pushing the WHOLE chunk let a single
      // `data` event carry the total past the ceiling the constant names.
      const room = MAX_STDERR_BYTES - stderrBytes
      const slice = d.length > room ? d.subarray(0, room) : d
      stderrChunks.push(slice)
      stderrBytes += slice.length
    })
    proc.on('error', (e) => finish(e))
    proc.on('close', (code) => {
      if (over) return
      const stdout = Buffer.concat(chunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      finish(code === 0 ? undefined : new Error(stderr.trim() || `simctl ${args[0]} exited ${code}`), stdout)
    })

    if (opts.timeoutMs) {
      timer = setTimeout(() => { proc.kill('SIGKILL'); finish(new Error(`simctl ${args[0]} timed out`)) }, opts.timeoutMs)
    }

    if (opts.input !== undefined) {
      // An unhandled stream 'error' would take the process down, so route it to the promise.
      proc.stdin.on('error', (e) => finish(e))
      proc.stdin.write(opts.input)
      proc.stdin.end()
    }
  })
}

export const defaultRunner: SimctlRunner = {
  async exec(...args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('xcrun', ['simctl', ...args])
      return stdout
    } catch (err) {
      if (!isCoreSimulatorVersionMismatch(err)) throw err
      logger.warn('CoreSimulatorService version mismatch — restarting service and retrying')
      await restartCoreSimulatorService()
      try {
        const { stdout } = await execFileAsync('xcrun', ['simctl', ...args])
        return stdout
      } catch (retryErr) {
        // Only claim the version mismatch if that is still what failed. Reporting it for an
        // unrelated failure hides the real cause — and erases `OutputTooLargeError`, which
        // `getPasteboard` needs to distinguish "the app copied something too big to carry"
        // from "the read failed", the two having opposite recovery.
        throw isCoreSimulatorVersionMismatch(retryErr) ? coreSimServiceError() : retryErr
      }
    }
  },
  async execWithOpts(opts: SimctlExecOpts, ...args: string[]): Promise<string> {
    try {
      return await runWithOpts(opts, args)
    } catch (err) {
      // Same self-healing every other simctl call gets. Before this existed the clipboard was
      // the one path that could not recover from a service version mismatch.
      if (!isCoreSimulatorVersionMismatch(err)) throw err
      logger.warn('CoreSimulatorService version mismatch — restarting service and retrying')
      await restartCoreSimulatorService()
      try {
        return await runWithOpts(opts, args)
      } catch (retryErr) {
        // Only claim the version mismatch if that is still what failed. Reporting it for an
        // unrelated failure hides the real cause — and erases `OutputTooLargeError`, which
        // `getPasteboard` needs to distinguish "the app copied something too big to carry"
        // from "the read failed", the two having opposite recovery.
        throw isCoreSimulatorVersionMismatch(retryErr) ? coreSimServiceError() : retryErr
      }
    }
  },
  async execBinary(...args: string[]): Promise<Buffer> {
    try {
      const { stdout } = await execFileAsync('xcrun', ['simctl', ...args], { encoding: 'buffer' })
      return stdout
    } catch (err) {
      if (!isCoreSimulatorVersionMismatch(err)) throw err
      logger.warn('CoreSimulatorService version mismatch — restarting service and retrying')
      await restartCoreSimulatorService()
      try {
        const { stdout } = await execFileAsync('xcrun', ['simctl', ...args], { encoding: 'buffer' })
        return stdout
      } catch (retryErr) {
        // Only claim the version mismatch if that is still what failed. Reporting it for an
        // unrelated failure hides the real cause — and erases `OutputTooLargeError`, which
        // `getPasteboard` needs to distinguish "the app copied something too big to carry"
        // from "the read failed", the two having opposite recovery.
        throw isCoreSimulatorVersionMismatch(retryErr) ? coreSimServiceError() : retryErr
      }
    }
  },
}
