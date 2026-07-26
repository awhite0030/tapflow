import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { createLogger } from '@tapflowio/agent-core'

const logger = createLogger('ios-agent:simctl')

const execFileAsync = promisify(execFile)

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
    let stdout = ''
    let stderr = ''
    let over = false
    let settled = false
    const finish = (err?: Error, out?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(out ?? '')
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => { proc.kill('SIGKILL'); finish(new Error(`simctl ${args[0]} timed out`)) }, opts.timeoutMs)
      : (undefined as unknown as ReturnType<typeof setTimeout>)

    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
      if (opts.maxBuffer && Buffer.byteLength(stdout, 'utf8') > opts.maxBuffer) {
        over = true
        proc.kill('SIGKILL')
        finish(new Error('stdout maxBuffer length exceeded'))
      }
    })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('error', (e) => finish(e))
    proc.on('close', (code) => {
      if (over) return
      finish(code === 0 ? undefined : new Error(stderr.trim() || `simctl ${args[0]} exited ${code}`), stdout)
    })

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
      } catch {
        throw coreSimServiceError()
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
      } catch {
        throw coreSimServiceError()
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
      } catch {
        throw coreSimServiceError()
      }
    }
  },
}
