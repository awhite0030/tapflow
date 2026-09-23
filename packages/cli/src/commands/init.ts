import fs from 'fs'
import os from 'os'
import path from 'path'
import { select, text, isCancel, cancel } from '@clack/prompts'
import { dnsProviders, resolveInstallDir, resolveDefaultDataDir, OWN_DATA_DIR, UNIFIED_DATA_DIR, type InstallDir } from '@tapflowio/relay'
import { banner, warn } from '../lib/print.js'
import { isInteractive } from '../lib/interactive.js'
import { scaffoldAgentDocs, isTapflowOwned } from '../lib/agentDocs.js'

export interface InitConfigOptions {
  tunnel?: string
  force?: boolean
}

const BASE_CONFIG = {
  local: { port: 4000 },
  relay: { url: '' },
  smtp: { host: '', port: 587, secure: false, user: '', pass: '' },
}

type TunnelConfig =
  | { provider: 'tailscale'; publicUrl?: string }
  | { provider: 'rathole'; serverAddr: string; publicUrl: string; ssh: { host: string; user: string; keyPath: string } | null }

type TlsConfig =
  | { mode: 'byo-api-token'; domain: string; dnsProvider: string }
  | { mode: 'import-cert'; certPath: string; keyPath: string }

function isInsideGitRepo(dir: string): boolean {
  let current = dir
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return true
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

// Ignore the install's runtime dirs — .tapflow/flows/ stays committed.
//
// **Anchored**, so `/data/` means this directory's data and not every `data/` in the repository.
// An install can sit inside an app repo, and an unanchored entry there would quietly stop tracking
// the app's own `src/**/data/`.
function addToGitignore(dir: string, entries: string[]): 'created' | 'appended' | 'already-present' {
  const gitignorePath = path.join(dir, '.gitignore')
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8')
    const present = new Set(content.split('\n').map((line) => line.trim()))
    // An unanchored or `**/`-prefixed line (how the monorepo root ignores these) already covers it.
    const missing = entries.filter((e) => {
      const bare = e.replace(/^\//, '')
      return !present.has(e) && !present.has(bare) && !present.has(`**/${bare}`)
    })
    if (missing.length === 0) return 'already-present'
    const separator = content.endsWith('\n') ? '' : '\n'
    fs.appendFileSync(gitignorePath, `${separator}\n# tapflow runtime data\n${missing.join('\n')}\n`, 'utf-8')
    return 'appended'
  }
  fs.writeFileSync(gitignorePath, `# tapflow runtime data\n${entries.join('\n')}\n`, 'utf-8')
  return 'created'
}

// #287 — 자격 증명 env 파일을 빈 값 템플릿으로 스캠폴드(사용자가 토큰 붙여넣음). 기존 값은 보존, 누락 키만 추가.
function scaffoldEnvFile(dataDir: string, envVars: string[]): 'created' | 'appended' | 'already-present' {
  const envPath = path.join(dataDir, '.env')
  fs.mkdirSync(dataDir, { recursive: true })
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8')
    const present = new Set(
      content.split('\n').map((l) => l.split('=')[0]?.trim()).filter(Boolean),
    )
    const missing = envVars.filter((v) => !present.has(v))
    if (missing.length === 0) return 'already-present'
    const separator = content.endsWith('\n') || content === '' ? '' : '\n'
    fs.appendFileSync(envPath, `${separator}${missing.map((v) => `${v}=`).join('\n')}\n`, 'utf-8')
    return 'appended'
  }
  const header = '# tapflow DNS/ACME credentials — do not commit. Paste each token after the =.\n'
  fs.writeFileSync(envPath, header + envVars.map((v) => `${v}=`).join('\n') + '\n', { mode: 0o600 })
  try {
    fs.chmodSync(envPath, 0o600)
  } catch {
    // best-effort on platforms without POSIX permissions
  }
  return 'created'
}

async function promptTunnel(): Promise<TunnelConfig | null> {
  const provider = await select({
    message: 'Tunnel provider',
    options: [
      { value: 'none', label: 'None', hint: 'local only' },
      { value: 'tailscale', label: 'Tailscale', hint: 'recommended — E2E encrypted, no VPS required' },
      { value: 'rathole', label: 'rathole', hint: 'VPS required' },
    ],
  })

  if (isCancel(provider)) { cancel('Cancelled.'); process.exit(0) }
  if (provider === 'tailscale') return { provider: 'tailscale' }
  if (provider !== 'rathole') return null

  const serverAddr = await text({
    message: 'VPS server address',
    placeholder: 'example.com:2333',
    validate: (v) => !v?.trim() ? 'Required' : undefined,
  })
  if (isCancel(serverAddr)) { cancel('Cancelled.'); process.exit(0) }

  const publicUrl = await text({
    message: 'Public URL',
    placeholder: 'https://example.com',
    validate: (v) => !v?.trim() ? 'Required' : undefined,
  })
  if (isCancel(publicUrl)) { cancel('Cancelled.'); process.exit(0) }

  const sshHost = await text({
    message: 'SSH host',
    placeholder: 'example.com  (leave blank to skip)',
  })
  if (isCancel(sshHost)) { cancel('Cancelled.'); process.exit(0) }

  let ssh: { host: string; user: string; keyPath: string } | null = null
  if (sshHost && sshHost.trim()) {
    const sshUser = await text({
      message: 'SSH user',
      placeholder: 'ubuntu',
      defaultValue: 'ubuntu',
    })
    if (isCancel(sshUser)) { cancel('Cancelled.'); process.exit(0) }

    const sshKeyPath = await text({
      message: 'SSH key path',
      placeholder: '~/.ssh/id_ed25519',
      defaultValue: '~/.ssh/id_ed25519',
    })
    if (isCancel(sshKeyPath)) { cancel('Cancelled.'); process.exit(0) }

    ssh = { host: sshHost.trim(), user: sshUser || 'ubuntu', keyPath: sshKeyPath || '~/.ssh/id_ed25519' }
  }

  return { provider: 'rathole', serverAddr: serverAddr.trim(), publicUrl: publicUrl.trim(), ssh }
}

// LAN(=no tunnel) HTTPS 선택. WebCodecs(빠른 영상)는 secure context(HTTPS)에서만 동작.
// 도메인 없으면 Standard(HTTP/WASM)로 충분히 동작하므로 강요하지 않는다.
async function promptTls(): Promise<TlsConfig | null> {
  const perf = await select({
    message: 'Streaming performance',
    options: [
      { value: 'standard', label: 'Standard', hint: 'HTTP, software decode — instant, no domain needed' },
      { value: 'high', label: 'Smooth', hint: 'HTTPS, hardware decode (WebCodecs) — needs a domain' },
    ],
  })
  if (isCancel(perf)) { cancel('Cancelled.'); process.exit(0) }
  if (perf !== 'high') return null

  const method = await select({
    message: 'Certificate method',
    options: [
      ...dnsProviders.list().map((p) => ({ value: p.name, label: p.label, hint: p.hint })),
      { value: 'import', label: 'Existing certificate', hint: 'bring your own cert & key files' },
    ],
  })
  if (isCancel(method)) { cancel('Cancelled.'); process.exit(0) }

  if (method === 'import') {
    const certPath = await text({
      message: 'Certificate path (fullchain PEM)',
      placeholder: '/path/to/fullchain.pem',
      validate: (v) => (!v?.trim() ? 'Required' : undefined),
    })
    if (isCancel(certPath)) { cancel('Cancelled.'); process.exit(0) }
    const keyPath = await text({
      message: 'Private key path (PEM)',
      placeholder: '/path/to/privkey.pem',
      validate: (v) => (!v?.trim() ? 'Required' : undefined),
    })
    if (isCancel(keyPath)) { cancel('Cancelled.'); process.exit(0) }
    return { mode: 'import-cert', certPath: certPath.trim(), keyPath: keyPath.trim() }
  }

  const domain = await text({
    message: 'Domain for tapflow (its A record points to this Mac on the LAN)',
    placeholder: 'tap.yourcompany.com',
    validate: (v) => (!v?.trim() ? 'Required' : undefined),
  })
  if (isCancel(domain)) { cancel('Cancelled.'); process.exit(0) }
  return { mode: 'byo-api-token', domain: domain.trim(), dnsProvider: method }
}

// Forward slashes in anything written for another tool to parse. On Windows `path` joins with `\`,
// which a .gitignore reads as an escape — `/.tapflow\data/` ignores nothing, and the secrets in it
// would be committed. Node reads either separator back, so the config gets the same form.
function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

/** The data layout `init` writes into a config it creates, relative to the install dir. */
function dataDirFor(install: InstallDir, home: string): string {
  const found = resolveDefaultDataDir(install.dir, install.defaultDataLayout)
  // Pinned rather than left to the default, so the layout cannot change later under an install
  // that is found by a different rule — and so a dir that is also an app repo keeps its secrets
  // under `.tapflow/data/`, where that repo's .gitignore already covers them.
  if (found.existing) return path.relative(install.dir, found.dataDir)
  return isTapflowOwned(install.dir, home) ? OWN_DATA_DIR : UNIFIED_DATA_DIR
}

function agentDocsLines(dir: string, home: string): string[] {
  try {
    const report = scaffoldAgentDocs(dir, home)
    const lines: string[] = []
    if (report.agents === 'created') lines.push('AGENTS.md created for your coding agent.')
    else if (report.agents === 'appended') lines.push('tapflow section added to AGENTS.md.')
    else if (report.agents === 'updated') lines.push('tapflow section in AGENTS.md updated.')
    if (report.claude === 'created') lines.push('CLAUDE.md created (imports AGENTS.md).')
    return [...lines, ...report.notes]
  } catch (err) {
    warn(`Could not write the agent docs: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

export async function cmdInitConfig(opts: InitConfigOptions): Promise<void> {
  // Resolved here rather than read from the relay's import-time value: this runs in-process in
  // tests that point it at another directory, and `init` is also what creates a TAPFLOW_HOME dir.
  const install = resolveInstallDir()
  const home = os.homedir()
  const configPath = install.configPath
  const where = `Install dir: ${install.dir} (${install.reason})`

  if (fs.existsSync(configPath) && !opts.force) {
    // Re-running is how an existing install picks up the agent docs, so it is not an error — but a
    // flag that asks to change the config is, because keeping the config would ignore it.
    if (opts.tunnel) {
      banner('error', 'CONFIG EXISTS', [
        where,
        `${configPath} already exists, so --tunnel has nothing to write to.`,
        'Use --force to recreate the config, or edit the file.',
      ])
      process.exit(1)
    }
    const kept = [where, `${path.basename(configPath)} kept — use --force to recreate it.`]
    kept.push(...agentDocsLines(install.dir, home))
    kept.push(`Ask your coding agent about tapflow from here: cd ${install.dir}`)
    banner('success', 'CONFIG KEPT', kept)
    return
  }

  const SUPPORTED = ['tailscale', 'rathole']
  if (opts.tunnel && !SUPPORTED.includes(opts.tunnel)) {
    banner('error', 'INVALID TUNNEL', [
      `Unknown tunnel provider: "${opts.tunnel}". Supported: tailscale, rathole`,
    ])
    process.exit(1)
  }

  let tunnel: TunnelConfig | null = null

  if (opts.tunnel === 'tailscale') {
    tunnel = { provider: 'tailscale' }
  } else if (opts.tunnel === 'rathole') {
    tunnel = { provider: 'rathole', serverAddr: '', publicUrl: '', ssh: null }
  } else if (isInteractive()) {
    tunnel = await promptTunnel()
  }

  // HTTPS(WebCodecs)는 LAN(=no tunnel) 경로에서만 위저드로 묻는다. tailscale/rathole의 HTTPS는 후속.
  let tls: TlsConfig | null = null
  if (tunnel == null && isInteractive()) {
    tls = await promptTls()
  }

  const dataDir = dataDirFor(install, home)
  const absoluteDataDir = path.join(install.dir, dataDir)
  const configOut = {
    ...BASE_CONFIG,
    // Relative to the config file, which is how the relay reads it — and which is not the install
    // dir when the file being rewritten is an older install's `~/tapflow.config.json`. Written
    // relative to the install dir, `--force` there pinned `data`, which read back as `~/data`.
    local: { ...BASE_CONFIG.local, dataDir: toPosix(path.relative(path.dirname(configPath), absoluteDataDir)) },
    ...(tunnel != null ? { tunnel } : {}),
    ...(tls != null ? { tls } : {}),
  }
  try {
    fs.mkdirSync(install.dir, { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(configOut, null, 2) + '\n', 'utf-8')
  } catch (err) {
    banner('error', 'WRITE FAILED', [
      `Could not write ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    ])
    process.exit(1)
  }

  // Legacy .tapflow-data/ moves only via `tapflow migrate data-dir`; until then don't scaffold a fresh data dir (it would trap that command with a both-dirs conflict).
  const hasLegacyDataDir = dataDir === '.tapflow-data'

  // byo-api-token: 토큰 재export 없이 재시작 가능하도록 자격 증명 env 파일을 스캠폴드(빈 변수명만 작성).
  let envScaffold: 'created' | 'appended' | 'already-present' | 'skipped' = 'skipped'
  if (tls?.mode === 'byo-api-token' && !hasLegacyDataDir) {
    const envVars = dnsProviders.get(tls.dnsProvider)?.envVars ?? []
    try {
      envScaffold = scaffoldEnvFile(absoluteDataDir, envVars)
    } catch (err) {
      warn(`Could not write ${path.join(dataDir, '.env')}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  let gitignoreUpdated: 'created' | 'appended' | 'already-present' | 'skipped' = 'skipped'
  if (isInsideGitRepo(install.dir)) {
    // Ignore the legacy dir too while it awaits migration, so its secrets aren't committed meanwhile.
    const ignoreEntries = [`/${toPosix(dataDir)}/`, '/.tapflow/artifacts/']
    if (dataDir !== '.tapflow-data' && fs.existsSync(path.join(install.dir, '.tapflow-data'))) ignoreEntries.push('/.tapflow-data/')
    try {
      gitignoreUpdated = addToGitignore(install.dir, ignoreEntries)
    } catch (err) {
      warn(`Could not update .gitignore: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const lines: string[] = [where, `${path.basename(configPath)} created.`]
  if (gitignoreUpdated === 'created') lines.push('.gitignore created (runtime dirs added).')
  else if (gitignoreUpdated === 'appended') lines.push('Runtime dirs added to .gitignore.')
  if (tunnel?.provider === 'rathole' && (!tunnel.serverAddr || !tunnel.publicUrl)) {
    lines.push('Fill in tunnel.serverAddr and tunnel.publicUrl in tapflow.config.json.')
  }
  if (tunnel) lines.push(`Tunnel: ${tunnel.provider}`)
  if (tls?.mode === 'byo-api-token') {
    const envVars = dnsProviders.get(tls.dnsProvider)?.envVars.join(', ') ?? 'the provider credentials'
    lines.push(`HTTPS: ${tls.dnsProvider} DNS-01 for ${tls.domain}.`)
    if (!hasLegacyDataDir) {
      if (envScaffold === 'created' || envScaffold === 'appended') {
        lines.push(`Paste ${envVars} into ${path.join(dataDir, '.env')} (the relay reads it on start).`)
      } else {
        lines.push(`Set ${envVars} (the relay auto-publishes the A record on start).`)
      }
    }
  } else if (tls?.mode === 'import-cert') {
    lines.push('HTTPS: import-cert. Ensure the cert/key paths exist on this Mac.')
  }
  if (hasLegacyDataDir) {
    lines.push(`Legacy .tapflow-data/ found — run \`tapflow migrate data-dir\` first, then add any DNS tokens to ${path.join(UNIFIED_DATA_DIR, '.env')}.`)
  }
  lines.push(...agentDocsLines(install.dir, home))
  lines.push(`Ask your coding agent about tapflow from here: cd ${install.dir}`)
  lines.push('Next: tapflow start')

  banner('success', 'CONFIG CREATED', lines)
}
