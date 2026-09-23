import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('@tapflowio/relay', () => ({
  RelayServer: vi.fn().mockImplementation(function () { return ({
    start: vi.fn().mockResolvedValue(undefined),
  }) }),
  initDb: vi.fn(),
  loadedEnvPath: null,
  createCertProvider: vi.fn(),
  startTlsBackgroundTasks: vi.fn(() => () => {}),
  resolveRelayDisplayHost: vi.fn(() => 'localhost'),
  buildCorsOrigins: vi.fn(() => []),
  proxyWithoutPublicUrlWarning: vi.fn(() => null),
  resolveTunnelPort: vi.fn((explicit: number | null, relayPort: number) => explicit ?? (relayPort === 4001 ? 4002 : 4001)),
  isInitialized: vi.fn(() => true),
  assertInstallDir: vi.fn(),
  install: { dir: '/tmp/tapflow-test-install', reason: 'default', configPath: '/tmp/tapflow-test-install/tapflow.config.json', defaultDataLayout: 'data', missing: false, shadowed: [] },
  configFound: true,
  config: { local: { port: 4000, dataDir: '/tmp/tapflow-test', wsBackpressureBytes: 1048576, trustedProxies: [], tunnelPort: null }, relay: { url: null }, tunnel: null, tls: null },
}))

const mockTunnel = { setupServer: vi.fn(), start: vi.fn(), stop: vi.fn() }
vi.mock('../../lib/rathole-tunnel.js', () => ({
  RatholeTunnel: vi.fn().mockImplementation(function () { return mockTunnel }),
}))
vi.mock('../../lib/tailscale-tunnel.js', () => ({
  TailscaleTunnel: vi.fn().mockImplementation(function () { return mockTunnel }),
}))
vi.mock('../../lib/port-available.js', () => ({ refuseUnlessBindable: vi.fn() }))

import { RelayServer, initDb, config, createCertProvider, resolveRelayDisplayHost, buildCorsOrigins, proxyWithoutPublicUrlWarning, isInitialized } from '@tapflowio/relay'
import { refuseUnlessBindable } from '../../lib/port-available.js'
import { RatholeTunnel } from '../../lib/rathole-tunnel.js'
import { TailscaleTunnel } from '../../lib/tailscale-tunnel.js'
import { cmdRelayStart } from '../../commands/relay-start.js'

function agentConnectLine(output: string[]): string {
  const start = output.findIndex((entry) => entry.includes('tapflow agent start --relay'))
  expect(start).toBeGreaterThanOrEqual(0)
  const end = output.findIndex((entry, index) => index >= start && entry.includes('--token <agent-PAT>'))
  expect(end).toBeGreaterThanOrEqual(start)
  return output.slice(start, end + 1).join(' ')
}

describe('cmdRelayStart', () => {
  let output: string[]
  let exitSpy: MockInstance

  beforeEach(() => {
    vi.resetAllMocks()
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    vi.mocked(RelayServer).mockImplementation(function () { return ({
      start: vi.fn().mockResolvedValue(undefined),
    } as never) })
    mockTunnel.setupServer.mockResolvedValue(undefined)
    mockTunnel.start.mockResolvedValue({ publicUrl: 'https://vps.example.com' })
    mockTunnel.stop.mockResolvedValue(undefined)
    vi.mocked(RatholeTunnel).mockImplementation(function () { return mockTunnel as never })
    vi.mocked(TailscaleTunnel).mockImplementation(function () { return mockTunnel as never })
    vi.mocked(config).tunnel = null
    vi.mocked(config).tls = null
    vi.mocked(config).local.tunnelPort = null
    vi.mocked(refuseUnlessBindable).mockResolvedValue(undefined)
  })

  afterEach(() => vi.restoreAllMocks())

  it('기본 포트 4000으로 RelayServer 기동', async () => {
    await cmdRelayStart({})
    expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ port: 4000 }))
    expect(vi.mocked(RelayServer).mock.results[0]?.value.start).toHaveBeenCalled()
  })

  it('프록시 옵션(trustedProxies/corsOrigins)을 RelayServer에 전달', async () => {
    vi.mocked(buildCorsOrigins).mockReturnValue(['http://localhost:4000'])
    await cmdRelayStart({})
    expect(buildCorsOrigins).toHaveBeenCalled()
    expect(proxyWithoutPublicUrlWarning).toHaveBeenCalled()
    expect(RelayServer).toHaveBeenCalledWith(
      expect.objectContaining({ trustedProxies: [], corsOrigins: ['http://localhost:4000'] }),
    )
  })

  it('initDb가 RelayServer 생성 전에 호출됨', async () => {
    const callOrder: string[] = []
    vi.mocked(initDb).mockImplementation(() => { callOrder.push('initDb') })
    vi.mocked(RelayServer).mockImplementation(function () {
      callOrder.push('RelayServer')
      return { start: vi.fn().mockResolvedValue(undefined) } as never
    })

    await cmdRelayStart({})

    expect(callOrder.indexOf('initDb')).toBeLessThan(callOrder.indexOf('RelayServer'))
  })

  it('--port 옵션으로 포트 변경', async () => {
    await cmdRelayStart({ port: 8080 })
    expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ port: 8080 }))
  })

  it('SIGINT 시 process.exit(0) 호출', async () => {
    const onSpy = vi.spyOn(process, 'on')
    await cmdRelayStart({})
    const call = onSpy.mock.calls.find(([event]) => event === 'SIGINT')
    expect(call).toBeDefined()
    const handler = call![1] as () => void
    expect(() => handler()).toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('기동 완료 후 포트 번호가 출력에 포함됨', async () => {
    await cmdRelayStart({ port: 9999 })
    expect(output.join('\n')).toContain('9999')
  })

  it('기본 포트 출력에 localhost:4000 포함', async () => {
    await cmdRelayStart({})
    expect(output.join('\n')).toContain('localhost:4000')
  })

  it('import-cert 인증서의 DNS host를 출력', async () => {
    vi.mocked(config).tls = { mode: 'import-cert', certPath: '/cert.pem', keyPath: '/key.pem' }
    vi.mocked(createCertProvider).mockReturnValue({
      ensureCert: vi.fn().mockResolvedValue({ cert: 'CERT', key: 'KEY' }),
    } as never)
    vi.mocked(resolveRelayDisplayHost).mockReturnValue('relay.example.com')

    await cmdRelayStart({})

    expect(resolveRelayDisplayHost).toHaveBeenCalledWith(config.tls, 'CERT', expect.any(Function))
    expect(output.join('\n')).toContain('https://relay.example.com:4000')
  })

  it('TLS agent-connect 안내에 인증서 host를 사용', async () => {
    vi.mocked(config).tls = { mode: 'import-cert', certPath: '/cert.pem', keyPath: '/key.pem' }
    vi.mocked(createCertProvider).mockReturnValue({
      ensureCert: vi.fn().mockResolvedValue({ cert: 'CERT', key: 'KEY' }),
    } as never)
    vi.mocked(resolveRelayDisplayHost).mockReturnValue('relay.example.com')

    await cmdRelayStart({ port: 4321 })

    const line = agentConnectLine(output)
    expect(line).toContain('wss://relay.example.com:4321')
    expect(line).not.toContain('<host>')
  })

  it('HTTP agent-connect 안내는 host placeholder를 유지', async () => {
    await cmdRelayStart({})

    const line = agentConnectLine(output)
    expect(line).toContain('ws://<host>:4000')
    expect(line).not.toContain('ws://localhost:4000')
  })

  it.each(['localhost', 'Localhost'])('TLS host가 %s로 fallback되면 agent-connect 안내는 placeholder를 유지', async (displayHost) => {
    vi.mocked(config).tls = { mode: 'import-cert', certPath: '/cert.pem', keyPath: '/key.pem' }
    vi.mocked(createCertProvider).mockReturnValue({
      ensureCert: vi.fn().mockResolvedValue({ cert: 'CERT', key: 'KEY' }),
    } as never)
    vi.mocked(resolveRelayDisplayHost).mockReturnValue(displayHost)

    await cmdRelayStart({})

    const line = agentConnectLine(output)
    expect(line).toContain('wss://<host>:4000')
    expect(line).not.toContain(`wss://${displayHost}:4000`)
  })

  it('Connect Mac agents 안내에 --token PAT와 발급처가 포함됨', async () => {
    await cmdRelayStart({})
    const out = output.join('\n')
    expect(out).toContain('--token <agent-PAT>')
    expect(out).toContain('Settings → Tokens')
  })

  it('포트 범위 초과(99999) → exit(1)', async () => {
    await expect(cmdRelayStart({ port: 99999 })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('포트 0 → exit(1)', async () => {
    await expect(cmdRelayStart({ port: 0 })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('NaN 포트 → exit(1)', async () => {
    await expect(cmdRelayStart({ port: NaN })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  describe('--tunnel 옵션', () => {
    beforeEach(() => {
      vi.stubEnv('TAPFLOW_TUNNEL_TOKEN', 'secret-token')
      vi.mocked(config).tunnel = { provider: 'rathole', serverAddr: 'vps.example.com:2333', publicUrl: 'https://vps.example.com', ssh: null }
    })

    afterEach(() => vi.unstubAllEnvs())

    it('config.tunnel 설정 → setupServer → start 순서 + 공개 URL 출력', async () => {
      const order: string[] = []
      mockTunnel.setupServer.mockImplementation(async () => { order.push('setupServer') })
      mockTunnel.start.mockImplementation(async () => { order.push('start'); return { publicUrl: 'https://vps.example.com' } })
      await cmdRelayStart({})
      expect(RatholeTunnel).toHaveBeenCalledWith(expect.objectContaining({ serverAddr: 'vps.example.com:2333', token: 'secret-token' }))
      expect(order).toEqual(['setupServer', 'start'])
      expect(output.join('\n')).toContain('https://vps.example.com')
    })

    it('--tunnel 플래그 없고 config.tunnel도 없음 → 터널 기동 안 함', async () => {
      vi.mocked(config).tunnel = null
      await cmdRelayStart({})
      expect(RatholeTunnel).not.toHaveBeenCalled()
    })

    it('TAPFLOW_TUNNEL_TOKEN 없음 → 터널 없이 relay 계속 (exit 안 함)', async () => {
      vi.unstubAllEnvs()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await cmdRelayStart({})
      expect(exitSpy).not.toHaveBeenCalled()
      expect(RatholeTunnel).not.toHaveBeenCalled()
      expect(RelayServer).toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('TAPFLOW_TUNNEL_TOKEN'))
    })

    it('SIGINT 시 relay + tunnel 모두 종료', async () => {
      const onSpy = vi.spyOn(process, 'on')
      await cmdRelayStart({})
      const call = onSpy.mock.calls.find(([event]) => event === 'SIGINT')
      const handler = call![1] as () => void
      expect(() => handler()).toThrow('process.exit')
      expect(mockTunnel.stop).toHaveBeenCalled()
    })

    it('터널 기동 실패 → relay는 계속 동작', async () => {
      mockTunnel.start.mockRejectedValue(new Error('connection refused'))
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await cmdRelayStart({})
      expect(RelayServer).toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('connection refused'))
    })

    it('터널이 RelayServer 생성보다 먼저 시작된다', async () => {
      await cmdRelayStart({})
      expect(mockTunnel.start.mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(RelayServer).mock.invocationCallOrder[0])
    })

    it('터널 결과와 그 결과로 계산한 CORS 목록이 RelayServer에 도착한다', async () => {
      vi.mocked(buildCorsOrigins).mockImplementation((_cfg, _port, tunnel) => (tunnel ? ['sentinel'] : []))
      await cmdRelayStart({})
      const runtime = { publicUrl: 'https://vps.example.com' }
      expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ tunnel: runtime, corsOrigins: ['sentinel'] }))
      expect(proxyWithoutPublicUrlWarning).toHaveBeenCalledWith(config, runtime)
    })

    it('토큰이 없어 터널이 시작되지 않으면 publicUrl null을 넘긴다', async () => {
      vi.unstubAllEnvs()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      await cmdRelayStart({})
      expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ tunnel: { publicUrl: null } }))
    })

    it('relay 시작이 실패하면 터널을 멈추고 원래 오류를 전파한다', async () => {
      const failure = new Error('Port 4000 is already in use. Stop the existing process and try again.')
      vi.mocked(RelayServer).mockImplementation(function () { return { start: vi.fn().mockRejectedValue(failure) } as never })
      await expect(cmdRelayStart({})).rejects.toBe(failure)
      expect(mockTunnel.stop).toHaveBeenCalled()
    })

    it('RelayServer 생성자가 던져도 터널을 멈춘다', async () => {
      const failure = new Error('key values mismatch')
      vi.mocked(RelayServer).mockImplementation(function () { throw failure })
      await expect(cmdRelayStart({})).rejects.toBe(failure)
      expect(mockTunnel.stop).toHaveBeenCalled()
    })

    // The relay port counts loopback as local; the tunnel client has to land somewhere that does not.
    it('opens the tunnel listener and hands the tunnel both ports', async () => {
      await cmdRelayStart({ port: 5000 })
      expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ port: 5000, tunnelPort: 4001 }))
      expect(mockTunnel.start).toHaveBeenCalledWith({ relayPort: 5000, tunnelPort: 4001 })
      expect(refuseUnlessBindable).toHaveBeenCalledWith(4001, 'tunnel', '127.0.0.1')
    })

    it('moves the default tunnel port off a relay started on it', async () => {
      await cmdRelayStart({ port: 4001 })
      expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ port: 4001, tunnelPort: 4002 }))
    })

    it('names the tunnel port in the banner', async () => {
      await cmdRelayStart({})
      expect(output.join('\n')).toContain('127.0.0.1:4001')
    })

    it('refuses a tunnel port equal to the relay port before the VPS side is touched', async () => {
      vi.mocked(config).local.tunnelPort = 4000
      await expect(cmdRelayStart({})).rejects.toThrow(/must differ from the relay port/)
      expect(mockTunnel.setupServer).not.toHaveBeenCalled()
      expect(refuseUnlessBindable).not.toHaveBeenCalled()
    })

    it('a taken tunnel port stops everything before the VPS side is touched', async () => {
      vi.mocked(refuseUnlessBindable).mockImplementation(async (port, role) => {
        if (role === 'tunnel') throw new Error(`Tunnel port ${port} is already in use. Stop the process holding it, or set TAPFLOW_TUNNEL_PORT to a free port.`)
      })
      await expect(cmdRelayStart({})).rejects.toThrow(/4001.*TAPFLOW_TUNNEL_PORT/)
      expect(mockTunnel.setupServer).not.toHaveBeenCalled()
      expect(RelayServer).not.toHaveBeenCalled()
    })

    // Setup refuses anything that arrives through the tunnel, so the public URL cannot be where it starts.
    it('on a relay with no admin yet, says setup happens on this machine', async () => {
      vi.mocked(isInitialized).mockReturnValue(false)
      await cmdRelayStart({})
      expect(output.join('\n')).toContain('tapflow admin init')
    })

    it('says nothing about setup once an admin exists', async () => {
      await cmdRelayStart({})
      expect(output.join('\n')).not.toContain('tapflow admin init')
    })

    it('포트가 이미 쓰이면 터널도 relay도 시작하지 않는다', async () => {
      vi.mocked(refuseUnlessBindable).mockRejectedValue(new Error('Port 4321 is already in use. Stop the existing process and try again.'))
      await expect(cmdRelayStart({ port: 4321 })).rejects.toThrow('already in use')
      expect(refuseUnlessBindable).toHaveBeenCalledWith(4321, 'relay')
      expect(mockTunnel.setupServer).not.toHaveBeenCalled()
      expect(RelayServer).not.toHaveBeenCalled()
    })
  })

  describe('터널 설정 오류는 relay를 띄우기 전에 낸다', () => {
    it('지원하지 않는 --tunnel 값', async () => {
      await expect(cmdRelayStart({ tunnel: 'foo' })).rejects.toThrow('process.exit')
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(RelayServer).not.toHaveBeenCalled()
    })

    it('--tunnel인데 tunnel 섹션이 없음', async () => {
      vi.mocked(config).tunnel = null
      await expect(cmdRelayStart({ tunnel: 'rathole' })).rejects.toThrow('process.exit')
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(RelayServer).not.toHaveBeenCalled()
    })
  })

  // A tunnel or proxy tapflow does not manage (cloudflared, nginx) still needs somewhere to point.
  it('opens the tunnel listener without a tunnel when its port is named', async () => {
    vi.mocked(config).local.tunnelPort = 4100
    await cmdRelayStart({})
    expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ tunnelPort: 4100 }))
    expect(RatholeTunnel).not.toHaveBeenCalled()
  })

  it('터널이 없으면 tunnel 옵션을 넘기지 않고 포트도 따로 확인하지 않는다', async () => {
    await cmdRelayStart({})
    expect(vi.mocked(RelayServer).mock.calls[0][0].tunnel).toBeUndefined()
    expect(vi.mocked(RelayServer).mock.calls[0][0].tunnelPort).toBeUndefined()
    expect(refuseUnlessBindable).not.toHaveBeenCalled()
  })

  describe('tailscale 터널', () => {
    beforeEach(() => {
      vi.mocked(config).tunnel = { provider: 'tailscale' }
      mockTunnel.start.mockResolvedValue({ publicUrl: 'http://my-mac.tailnet.ts.net:4000' })
    })

    it('provider tailscale → TailscaleTunnel 생성, 토큰 불필요', async () => {
      await cmdRelayStart({})
      expect(TailscaleTunnel).toHaveBeenCalledWith({ publicUrl: undefined })
      expect(RatholeTunnel).not.toHaveBeenCalled()
      expect(output.join('\n')).toContain('my-mac.tailnet.ts.net')
    })

    it('TAPFLOW_TUNNEL_TOKEN 없어도 Tailscale 정상 기동', async () => {
      await expect(cmdRelayStart({})).resolves.toBeUndefined()
      expect(TailscaleTunnel).toHaveBeenCalled()
    })

    it('TLS relay에는 http:// 터널 주소를 넘기지 않고 배너에도 싣지 않는다', async () => {
      vi.mocked(config).tls = { mode: 'import-cert', certPath: '/cert.pem', keyPath: '/key.pem' }
      vi.mocked(createCertProvider).mockReturnValue({
        ensureCert: vi.fn().mockResolvedValue({ cert: 'CERT', key: 'KEY' }),
      } as never)
      vi.mocked(resolveRelayDisplayHost).mockReturnValue('relay.example.com')
      const warnings: string[] = []
      vi.spyOn(console, 'warn').mockImplementation((...args) => { warnings.push(args.join(' ')) })

      await cmdRelayStart({})

      expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ tunnel: { publicUrl: null } }))
      // "Tunnel ready" still names the URL the tunnel reported; the banner must not offer it.
      expect(output.filter((line) => line.includes('Public :'))).toEqual([])
      expect(warnings.join('\n')).toContain('Not advertising http://my-mac.tailnet.ts.net:4000')
    })
  })
})
