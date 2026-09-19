import { spawnSync } from 'child_process'

export type ArchiveTool = 'unzip' | 'tar'

type ToolProbe =
  | { tool: ArchiveTool; state: 'ok' }
  | { tool: ArchiveTool; state: 'missing'; detail: string }
  | { tool: ArchiveTool; state: 'broken'; detail: string }

function versionArgs(tool: ArchiveTool): string[] {
  return tool === 'unzip' ? ['-v'] : ['--version']
}

// A missing binary (spawn ENOENT) and a binary that resolves but fails its
// version check are different problems with different fixes, so probe them
// separately: the first names an install, the second names the failure.
function probeTool(tool: ArchiveTool): ToolProbe {
  const args = versionArgs(tool)
  const result = spawnSync(tool, args, { encoding: 'utf8' })
  if (result.error) {
    const detail = result.error instanceof Error ? result.error.message : String(result.error)
    // Only ENOENT means "not on PATH". Other startup failures (EACCES, EPERM)
    // resolve to something that cannot start, so they belong with `broken`.
    const code = (result.error as NodeJS.ErrnoException).code
    return { tool, state: code === 'ENOENT' ? 'missing' : 'broken', detail }
  }
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : ''
    const output = stderr || stdout
    const signal = result.signal ? ` (signal ${result.signal})` : ''
    const versionCheck = `'${tool} ${args.join(' ')}'`
    const outcome = `exited with status ${String(result.status)}${signal}`
    return {
      tool,
      state: 'broken',
      detail: `${versionCheck} ${outcome}${output ? `: ${output.slice(0, 200)}` : ''}`,
    }
  }
  return { tool, state: 'ok' }
}

/**
 * Fail fast when the archive tools production shells to are missing or broken.
 *
 * Production extraction calls `unzip -l` / `unzip -p` and `tar -tzf` /
 * `tar -xzOf` (packages/relay/src/api/builds.ts, unchanged here). When the
 * binary is absent those calls return null, which reads as a broken fixture
 * rather than a missing prerequisite; when the binary resolves but does not
 * run, the same null misdirects toward the fixture instead of the tool. Call
 * this in beforeAll of the suites that exercise those paths so a local run
 * names the install (or the version-check failure) instead.
 */
export function assertArchiveTools(tools: readonly ArchiveTool[] = ['unzip', 'tar']): void {
  const missingDetails: string[] = []
  const brokenDetails: string[] = []
  for (const probe of tools.map(probeTool)) {
    if (probe.state === 'missing') missingDetails.push(`${probe.tool} (${probe.detail})`)
    else if (probe.state === 'broken') brokenDetails.push(`${probe.tool} (${probe.detail})`)
  }
  if (missingDetails.length === 0 && brokenDetails.length === 0) return
  const failures: string[] = []
  if (missingDetails.length > 0) {
    failures.push(`missing executables (not found on PATH): ${missingDetails.join(', ')}`)
  }
  if (brokenDetails.length > 0) {
    failures.push(`executables that fail to start or fail their version check: ${brokenDetails.join('; ')}`)
  }
  throw new Error(
    `Missing required archive tools for relay tests: ${failures.join('; ')}. ` +
      `Production extraction shells to 'unzip -l'/'unzip -p' and 'tar -tzf'/'tar -xzOf' ` +
      `(packages/relay/src/api/builds.ts), so the suite cannot pass without them. ` +
      `On Windows, install Git for Windows (https://git-scm.com/download/win) and ensure its ` +
      `usr/bin ('C:\\Program Files\\Git\\usr\\bin' or '%LocalAppData%\\Programs\\Git\\usr\\bin') is on PATH for unzip; ` +
      `tar.exe ships with Windows in C:\\Windows\\System32. On macOS, run 'brew install unzip gnu-tar'; ` +
      `on Debian/Ubuntu, run 'sudo apt-get install unzip tar'.`,
  )
}
