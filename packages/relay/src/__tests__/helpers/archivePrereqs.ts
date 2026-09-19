import { spawnSync } from 'child_process'

export type ArchiveTool = 'unzip' | 'tar'

function isExecutable(tool: ArchiveTool): boolean {
  const args = tool === 'unzip' ? ['-v'] : ['--version']
  const result = spawnSync(tool, args, { stdio: 'ignore' })
  return !result.error && result.status === 0
}

/**
 * Fail fast when the archive tools production shells to are missing.
 *
 * Production extraction calls `unzip -l` / `unzip -p` and `tar -tzf` /
 * `tar -xzOf` (packages/relay/src/api/builds.ts, unchanged here). When the
 * binary is absent those calls return null, which reads as a broken fixture
 * rather than a missing prerequisite. Call this in beforeAll of the suites
 * that exercise those paths so a local run names the install instead.
 */
export function assertArchiveTools(tools: readonly ArchiveTool[] = ['unzip', 'tar']): void {
  const missing = tools.filter((tool) => !isExecutable(tool))
  if (missing.length === 0) return
  throw new Error(
    `Missing required archive tools for relay tests: ${missing.join(', ')} not found on PATH. ` +
      `Production extraction shells to 'unzip -l'/'unzip -p' and 'tar -tzf'/'tar -xzOf' ` +
      `(packages/relay/src/api/builds.ts), so the suite cannot pass without them. ` +
      `On Windows, install Git for Windows (https://git-scm.com/download/win) and ensure its ` +
      `usr/bin ('C:\\Program Files\\Git\\usr\\bin' or '%LocalAppData%\\Programs\\Git\\usr\\bin') is on PATH for unzip; ` +
      `tar.exe ships with Windows in C:\\Windows\\System32. On macOS, run 'brew install unzip gnu-tar'; ` +
      `on Debian/Ubuntu, run 'sudo apt-get install unzip tar'.`,
  )
}
