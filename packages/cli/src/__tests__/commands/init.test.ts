import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  text: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  cancel: vi.fn(),
}))

import * as clack from '@clack/prompts'
import { cmdInitConfig } from '../../commands/init.js'

/**
 * A whole terminal, both ends. `init` asks only when it could also be answered — see
 * `isInteractive`. This used to set stdin alone, which matched a guard that read stdin alone.
 */
function setTTY(value: boolean) {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}

const mockSelect = vi.mocked(clack.select)
const mockText = vi.mocked(clack.text)

describe('cmdInitConfig', () => {
  let output: string[]
  let exitSpy: MockInstance
  let tmpDir: string
  let tmpHome: string

  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(clack.isCancel).mockReturnValue(false)
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...args) => output.push(args.join(' ')))
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-init-test-'))
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-init-home-'))
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)
    // The install dir, which `init` writes to now. Named rather than left to `~/.tapflow`, so these
    // tests keep asserting against a directory they own.
    vi.stubEnv('TAPFLOW_HOME', tmpDir)
    vi.stubEnv('HOME', tmpHome)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('--tunnel tailscale → tailscale 섹션 포함 config 생성', async () => {
    await cmdInitConfig({ tunnel: 'tailscale' })

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel).toEqual({ provider: 'tailscale' })
    expect(output.join('\n')).toContain('CONFIG CREATED')
  })

  it('--tunnel rathole → rathole placeholder config 생성', async () => {
    await cmdInitConfig({ tunnel: 'rathole' })

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel.provider).toBe('rathole')
    expect(cfg.tunnel.serverAddr).toBe('')
    expect(cfg.tunnel.ssh).toBeNull()
  })

  it('tunnel 없음 → 기본 config 생성 (tunnel 섹션 없음)', async () => {
    setTTY(false)

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel).toBeUndefined()
    expect(cfg.local.port).toBe(4000)
  })

  it('이미 config 존재 → config는 그대로 두고 에이전트 문서만 갱신 (exit 0)', async () => {
    // Re-running is how an existing install picks up the agent docs. It used to exit 1 here.
    fs.writeFileSync(path.join(tmpDir, 'tapflow.config.json'), '{"local":{"port":4100}}', 'utf-8')

    await cmdInitConfig({})

    expect(exitSpy).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8')).toBe('{"local":{"port":4100}}')
    expect(fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')).toContain('<!-- tapflow:begin -->')
    expect(output.join('\n')).toContain('CONFIG KEPT')
    expect(output.join('\n')).toContain('--force')
  })

  it('이미 config 존재 + --tunnel → 아무것도 쓰지 않고 exit(1)', async () => {
    // The flag asks to change the config, and keeping the config would ignore it.
    fs.writeFileSync(path.join(tmpDir, 'tapflow.config.json'), '{}', 'utf-8')

    await expect(cmdInitConfig({ tunnel: 'tailscale' })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8')).toBe('{}')
    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(false)
  })

  it('이미 config 존재 + --force → 덮어쓰기', async () => {
    fs.writeFileSync(path.join(tmpDir, 'tapflow.config.json'), '{}', 'utf-8')

    await cmdInitConfig({ tunnel: 'tailscale', force: true })

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel.provider).toBe('tailscale')
  })

  it('알 수 없는 tunnel provider → exit(1)', async () => {
    await expect(cmdInitConfig({ tunnel: 'unknown' })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(output.join('\n')).toContain('INVALID TUNNEL')
  })

  it('인터랙티브 모드 tailscale 선택 → tailscale config 생성', async () => {
    setTTY(true)
    mockSelect.mockResolvedValue('tailscale')

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel.provider).toBe('tailscale')
  })

  it('인터랙티브 모드 none 선택 → tunnel 없는 config 생성', async () => {
    setTTY(true)
    mockSelect.mockResolvedValue('none')

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel).toBeUndefined()
  })

  it('인터랙티브 모드 rathole 선택 → serverAddr/publicUrl 입력 → rathole config 생성', async () => {
    setTTY(true)
    mockSelect.mockResolvedValue('rathole')
    mockText
      .mockResolvedValueOnce('vps.example.com:2333')
      .mockResolvedValueOnce('https://vps.example.com')
      .mockResolvedValueOnce('')  // ssh host blank → skip

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel.provider).toBe('rathole')
    expect(cfg.tunnel.serverAddr).toBe('vps.example.com:2333')
    expect(cfg.tunnel.publicUrl).toBe('https://vps.example.com')
    expect(cfg.tunnel.ssh).toBeNull()
  })

  it('none + Standard 성능 → tls 없음 (HTTP/WASM)', async () => {
    setTTY(true)
    mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('standard')

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tunnel).toBeUndefined()
    expect(cfg.tls).toBeUndefined()
  })

  it('none + High + Cloudflare → byo-api-token tls 생성', async () => {
    setTTY(true)
    mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('high').mockResolvedValueOnce('cloudflare')
    mockText.mockResolvedValueOnce('tap.example.com')

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tls).toEqual({ mode: 'byo-api-token', domain: 'tap.example.com', dnsProvider: 'cloudflare' })
    expect(output.join('\n')).toContain('TAPFLOW_CLOUDFLARE_TOKEN')
  })

  it('none + High + Vercel → byo-api-token(vercel) tls 생성', async () => {
    setTTY(true)
    mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('high').mockResolvedValueOnce('vercel')
    mockText.mockResolvedValueOnce('tap.example.com')

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tls).toEqual({ mode: 'byo-api-token', domain: 'tap.example.com', dnsProvider: 'vercel' })
    expect(output.join('\n')).toContain('TAPFLOW_VERCEL_TOKEN')
  })

  it('none + High + Import → import-cert tls 생성', async () => {
    setTTY(true)
    mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('high').mockResolvedValueOnce('import')
    mockText.mockResolvedValueOnce('/etc/tls/fullchain.pem').mockResolvedValueOnce('/etc/tls/privkey.pem')

    await cmdInitConfig({})

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
    expect(cfg.tls).toEqual({ mode: 'import-cert', certPath: '/etc/tls/fullchain.pem', keyPath: '/etc/tls/privkey.pem' })
  })

  describe('agent docs', () => {
    it('AGENTS.md와 CLAUDE.md를 만들고, 어디서 물어보면 되는지 안내한다', async () => {
      await cmdInitConfig({ tunnel: 'tailscale' })

      expect(fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')).toContain('https://www.tapflow.dev/llms.txt')
      expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8')).toBe('@AGENTS.md\n')
      // The banner wraps long paths, so match the sentence rather than the path in it.
      expect(output.join('\n')).toContain('Ask your coding agent')
    })

    it('설치 폴더가 앱 레포면 블록만 넣고 CLAUDE.md는 만들지 않는다', async () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}', 'utf-8')
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# House rules\n', 'utf-8')

      await cmdInitConfig({ tunnel: 'tailscale' })

      const agents = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8')
      expect(agents).toContain('# House rules')
      expect(agents).toContain('<!-- tapflow:begin -->')
      expect(fs.existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(false)
      // And its data stays wrapped, where that repo's .gitignore already covers it.
      const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
      expect(cfg.local.dataDir).toBe(path.join('.tapflow', 'data'))
    })

    it('설치 폴더가 홈 디렉터리면 AGENTS.md를 쓰지 않는다', async () => {
      vi.stubEnv('TAPFLOW_HOME', tmpHome)

      await cmdInitConfig({ tunnel: 'tailscale' })

      expect(fs.existsSync(path.join(tmpHome, 'tapflow.config.json'))).toBe(true)
      expect(fs.existsSync(path.join(tmpHome, 'AGENTS.md'))).toBe(false)
      expect(output.join('\n')).toContain('home directory')
    })
  })

  describe('TAPFLOW_HOME', () => {
    it('가리키는 폴더가 없으면 init이 만든다', async () => {
      const target = path.join(tmpDir, 'not-yet')
      vi.stubEnv('TAPFLOW_HOME', target)

      await cmdInitConfig({ tunnel: 'tailscale' })

      expect(fs.existsSync(path.join(target, 'tapflow.config.json'))).toBe(true)
      expect(fs.existsSync(path.join(target, 'AGENTS.md'))).toBe(true)
      expect(output.join('\n')).toContain('Install dir')
    })

    it('옛 ~/tapflow.config.json을 --force로 다시 쓰면 dataDir이 원래 데이터를 가리킨다', async () => {
      // An install `init` once wrote to `~`: config at ~/tapflow.config.json, data in ~/.tapflow/data.
      // The rewritten config is read relative to itself, so its dataDir has to be `.tapflow/data`
      // from `~`. Written relative to the install dir instead, it said `data` — which read back as
      // `~/data`, an empty directory.
      vi.stubEnv('TAPFLOW_HOME', '')
      fs.writeFileSync(path.join(tmpHome, 'tapflow.config.json'), '{}', 'utf-8')
      fs.mkdirSync(path.join(tmpHome, '.tapflow', 'data'), { recursive: true })

      await cmdInitConfig({ tunnel: 'tailscale', force: true })

      const cfg = JSON.parse(fs.readFileSync(path.join(tmpHome, 'tapflow.config.json'), 'utf-8'))
      expect(path.resolve(tmpHome, cfg.local.dataDir)).toBe(path.join(tmpHome, '.tapflow', 'data'))
      expect(fs.existsSync(path.join(tmpHome, '.tapflow', 'tapflow.config.json'))).toBe(false)
    })

    it('현재 폴더가 아니라 설치 폴더에 쓴다', async () => {
      const target = path.join(tmpDir, 'install')
      fs.mkdirSync(target)
      vi.stubEnv('TAPFLOW_HOME', target)

      await cmdInitConfig({ tunnel: 'tailscale' })

      expect(fs.existsSync(path.join(target, 'tapflow.config.json'))).toBe(true)
      expect(fs.existsSync(path.join(tmpDir, 'tapflow.config.json'))).toBe(false)
    })
  })

  describe('.env scaffold (#287)', () => {
    const envPath = () => path.join(tmpDir, 'data', '.env')

    it('byo-api-token → .tapflow/data/.env 를 빈 값 템플릿으로 자동 생성', async () => {
      setTTY(true)
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('high').mockResolvedValueOnce('cloudflare')
      mockText.mockResolvedValueOnce('tap.example.com')

      await cmdInitConfig({})

      const content = fs.readFileSync(envPath(), 'utf-8')
      expect(content).toContain('TAPFLOW_CLOUDFLARE_TOKEN=')
      // 비밀은 비어 있어야 한다 (프롬프트/로그로 흐르지 않음)
      expect(content).not.toMatch(/TAPFLOW_CLOUDFLARE_TOKEN=\S/)
      if (process.platform !== 'win32') {
        expect(fs.statSync(envPath()).mode & 0o777).toBe(0o600)
      }
    })

    it('기존 .env 의 실제 값은 보존하고 누락 키만 추가', async () => {
      setTTY(true)
      fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true })
      fs.writeFileSync(envPath(), 'TAPFLOW_VERCEL_TOKEN=secret_existing\n', 'utf-8')
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('high').mockResolvedValueOnce('cloudflare')
      mockText.mockResolvedValueOnce('tap.example.com')

      await cmdInitConfig({})

      const content = fs.readFileSync(envPath(), 'utf-8')
      expect(content).toContain('TAPFLOW_VERCEL_TOKEN=secret_existing')
      expect(content).toContain('TAPFLOW_CLOUDFLARE_TOKEN=')
    })

    it('기존 .tapflow/data 레이아웃이면 거기에 .env를 쓰고 config에도 그 경로를 적는다', async () => {
      // An install that already has data keeps it, whichever layout it is in.
      setTTY(true)
      fs.mkdirSync(path.join(tmpDir, '.tapflow', 'data'), { recursive: true })
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('high').mockResolvedValueOnce('cloudflare')
      mockText.mockResolvedValueOnce('tap.example.com')

      await cmdInitConfig({})

      const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tapflow.config.json'), 'utf-8'))
      expect(cfg.local.dataDir).toBe(path.join('.tapflow', 'data'))
      expect(fs.existsSync(path.join(tmpDir, '.tapflow', 'data', '.env'))).toBe(true)
      expect(fs.existsSync(path.join(tmpDir, 'data'))).toBe(false)
    })

    it('import-cert → .env 생성 없음', async () => {
      setTTY(true)
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('high').mockResolvedValueOnce('import')
      mockText.mockResolvedValueOnce('/etc/tls/fullchain.pem').mockResolvedValueOnce('/etc/tls/privkey.pem')

      await cmdInitConfig({})

      expect(fs.existsSync(envPath())).toBe(false)
    })
  })

  describe('.gitignore', () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(tmpDir, '.git'))
    })

    it('.gitignore 없음 → 새로 생성되고 런타임 디렉터리 두 줄 포함(flows 제외)', async () => {
      await cmdInitConfig({ tunnel: 'tailscale' })

      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8')
      expect(content).toContain('/data/')
      expect(content).toContain('/.tapflow/artifacts/')
      // flows는 커밋 대상이라 무시하면 안 된다
      expect(content).not.toMatch(/^\.tapflow\/$/m)
      expect(output.join('\n')).toContain('.gitignore created')
    })

    it('.gitignore 있고 항목 없음 → 런타임 두 줄 추가', async () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n', 'utf-8')

      await cmdInitConfig({ tunnel: 'tailscale' })

      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8')
      expect(content).toContain('node_modules/')
      expect(content).toContain('/data/')
      expect(content).toContain('/.tapflow/artifacts/')
      expect(output.join('\n')).toContain('Runtime dirs added to .gitignore')
    })

    it('.gitignore에 이미 런타임 항목 있음 → 중복 추가 안 됨', async () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), '/data/\n/.tapflow/artifacts/\n', 'utf-8')

      await cmdInitConfig({ tunnel: 'tailscale' })

      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8')
      expect(content.split('\n').filter((l) => l.trim() === '/data/').length).toBe(1)
      expect(content.split('\n').filter((l) => l.trim() === '/.tapflow/artifacts/').length).toBe(1)
    })

    it('앵커 없는 항목이나 **/ glob으로 이미 커버 → 중복 추가 안 됨', async () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'data/\n**/.tapflow/artifacts/\n', 'utf-8')

      await cmdInitConfig({ tunnel: 'tailscale' })

      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8')
      expect(content.split('\n').filter((l) => l.trim() === '/data/').length).toBe(0)
      expect(content.split('\n').filter((l) => l.trim() === '/.tapflow/artifacts/').length).toBe(0)
    })
  })

  describe('legacy .tapflow-data (명시 마이그레이션에 위임)', () => {
    it('레거시 존재 → init은 이동/생성 안 하고 migrate 안내만', async () => {
      fs.mkdirSync(path.join(tmpDir, '.tapflow-data'), { recursive: true })
      fs.writeFileSync(path.join(tmpDir, '.tapflow-data', 'tapflow.db'), 'DB')

      await cmdInitConfig({ tunnel: 'tailscale' })

      // 레거시는 그대로, .tapflow/data는 만들지 않는다 (만들면 migrate가 conflict 트랩)
      expect(fs.readFileSync(path.join(tmpDir, '.tapflow-data', 'tapflow.db'), 'utf-8')).toBe('DB')
      expect(fs.existsSync(path.join(tmpDir, '.tapflow', 'data'))).toBe(false)
      expect(output.join('\n')).toContain('tapflow migrate data-dir')
    })

    it('레거시 존재 → .gitignore에 .tapflow-data/도 추가(마이그레이션 전 secrets 보호)', async () => {
      fs.mkdirSync(path.join(tmpDir, '.git'))
      fs.mkdirSync(path.join(tmpDir, '.tapflow-data'), { recursive: true })

      await cmdInitConfig({ tunnel: 'tailscale' })

      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8')
      // The data dir it pinned, which is the legacy one until `migrate data-dir` moves it.
      expect(content).toContain('/.tapflow-data/')
      expect(content.split('\n').filter((l) => l.trim() === '/.tapflow-data/').length).toBe(1)
      expect(content).not.toContain('/data/\n')
    })

    it('레거시 존재 + DNS 자동발급 → .env scaffold 생략(.tapflow/data 미생성)', async () => {
      fs.mkdirSync(path.join(tmpDir, '.tapflow-data'), { recursive: true })
      setTTY(true)
      mockSelect.mockResolvedValueOnce('none').mockResolvedValueOnce('high').mockResolvedValueOnce('cloudflare')
      mockText.mockResolvedValueOnce('tap.example.com')

      await cmdInitConfig({})

      expect(fs.existsSync(path.join(tmpDir, '.tapflow', 'data', '.env'))).toBe(false)
      expect(output.join('\n')).toContain('tapflow migrate data-dir')
    })
  })
})
