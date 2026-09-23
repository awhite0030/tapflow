import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import type { AgentConnectOpts } from '@tapflowio/agent-core'

vi.mock('node:child_process')
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

  config: { local: { port: 4000, dataDir: '/tmp/tapflow-test', wsBackpressureBytes: 1048576, trustedProxies: [], tunnelPort: null }, relay: { url: null }, tunnel: null, tls: undefined },
}))
vi.mock('@tapflowio/ios-agent', () => ({ requestAudioPermission: vi.fn(), isAudioSupported: vi.fn(() => true) }))
vi.mock('@tapflowio/android-agent', () => ({}))

const mockTunnel = { stop: vi.fn() }
vi.mock('../../lib/tunnel-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tunnel-runner.js')>()),
  startConfiguredTunnel: vi.fn(),
}))
vi.mock('../../lib/port-available.js', () => ({ refuseUnlessBindable: vi.fn() }))

import { execSync } from 'node:child_process'
import { RelayServer, initDb, config, createCertProvider, resolveRelayDisplayHost, buildCorsOrigins, proxyWithoutPublicUrlWarning, isInitialized } from '@tapflowio/relay'
import { AgentRegistry } from '@tapflowio/agent-core'
import { startConfiguredTunnel } from '../../lib/tunnel-runner.js'
import { refuseUnlessBindable } from '../../lib/port-available.js'
import { cmdStart } from '../../commands/start.js'

const mockExecSync = vi.mocked(execSync)

function agentConnectLine(output: string[]): string {
  const start = output.findIndex((entry) => entry.includes('tapflow agent start --relay'))
  expect(start).toBeGreaterThanOrEqual(0)
  const end = output.findIndex((entry, index) => index >= start && entry.includes('--token <agent-PAT>'))
  expect(end).toBeGreaterThanOrEqual(start)
  return output.slice(start, end + 1).join(' ')
}

function testHasAdb(): boolean {
  try {
    return String(mockExecSync('which adb', { encoding: 'utf8', stdio: 'pipe' })).trim().length > 0
  } catch {
    return false
  }
}

class DummyAgent {}

describe('cmdStart', () => {
  type ConnectHook = (relayUrl: string, opts?: AgentConnectOpts) => Promise<{ disconnect(): void }>
  let iosConnectSpy: Mock<ConnectHook>
  let androidConnectSpy: Mock<ConnectHook>
  let iosDisconnectSpy: Mock<() => void>
  let androidDisconnectSpy: Mock<() => void>

  beforeEach(() => {
    vi.resetAllMocks()
    AgentRegistry.clear()

    iosDisconnectSpy = vi.fn<() => void>()
    androidDisconnectSpy = vi.fn<() => void>()
    iosConnectSpy = vi.fn<ConnectHook>().mockResolvedValue({ disconnect: iosDisconnectSpy })
    androidConnectSpy = vi.fn<ConnectHook>().mockResolvedValue({ disconnect: androidDisconnectSpy })

    AgentRegistry.register('ios', DummyAgent as never, {
      canRun: () => process.platform === 'darwin',
      connect: iosConnectSpy,
    })
    AgentRegistry.register('android', DummyAgent as never, {
      canRun: testHasAdb,
      connect: androidConnectSpy,
    })

    vi.mocked(RelayServer).mockImplementation(function () { return ({
      start: vi.fn().mockResolvedValue(undefined),
    } as never) })

    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'on').mockImplementation(() => process)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') return '/usr/local/bin/adb\n'
      return ''
    })

    vi.mocked(config).tunnel = null
    vi.mocked(config).tls = null
    vi.mocked(config).local.tunnelPort = null
    vi.mocked(isInitialized).mockReturnValue(true)
    vi.mocked(startConfiguredTunnel).mockResolvedValue({ tunnel: mockTunnel as never, publicUrl: 'http://my-mac.tailnet.ts.net:4000' })
    vi.mocked(refuseUnlessBindable).mockResolvedValue(undefined)
  })

  afterEach(() => {
    AgentRegistry.clear()
    vi.restoreAllMocks()
  })

  it('relay URL 없으면 RelayServer를 포트 4000으로 기동', async () => {
    await cmdStart({})
    expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ port: 4000 }))
    expect(vi.mocked(RelayServer).mock.results[0]?.value.start).toHaveBeenCalled()
  })

  it('initDb가 RelayServer 생성 전에 호출됨', async () => {
    const callOrder: string[] = []
    vi.mocked(initDb).mockImplementation(() => { callOrder.push('initDb') })
    vi.mocked(RelayServer).mockImplementation(function () {
      callOrder.push('RelayServer')
      return { start: vi.fn().mockResolvedValue(undefined) } as never
    })

    await cmdStart({})

    expect(callOrder.indexOf('initDb')).toBeLessThan(callOrder.indexOf('RelayServer'))
  })

  it('import-cert 인증서의 DNS host를 출력', async () => {
    vi.mocked(config).tls = { mode: 'import-cert', certPath: '/cert.pem', keyPath: '/key.pem' }
    vi.mocked(createCertProvider).mockReturnValue({
      ensureCert: vi.fn().mockResolvedValue({ cert: 'CERT', key: 'KEY' }),
    } as never)
    vi.mocked(resolveRelayDisplayHost).mockReturnValue('relay.example.com')
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))

    await cmdStart({})

    expect(resolveRelayDisplayHost).toHaveBeenCalledWith(config.tls, 'CERT', expect.any(Function))
    expect(output.join('\n')).toContain('https://relay.example.com:4000')
  })

  it('TLS relay-only agent-connect 안내에 인증서 host를 사용', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') throw new Error('not found')
      return ''
    })
    vi.mocked(config).tls = { mode: 'import-cert', certPath: '/cert.pem', keyPath: '/key.pem' }
    vi.mocked(createCertProvider).mockReturnValue({
      ensureCert: vi.fn().mockResolvedValue({ cert: 'CERT', key: 'KEY' }),
    } as never)
    vi.mocked(resolveRelayDisplayHost).mockReturnValue('relay.example.com')
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))

    await cmdStart({})

    const line = agentConnectLine(output)
    expect(line).toContain('wss://relay.example.com:4000')
    expect(line).not.toContain('<this-ip>')
  })

  it('HTTP relay-only agent-connect 안내는 host placeholder를 유지', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') throw new Error('not found')
      return ''
    })
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))

    await cmdStart({})

    const line = agentConnectLine(output)
    expect(line).toContain('ws://<this-ip>:4000')
    expect(line).not.toContain('ws://localhost:4000')
  })

  it.each(['localhost', 'Localhost'])('TLS host가 %s로 fallback되면 relay-only agent-connect 안내는 placeholder를 유지', async (displayHost) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') throw new Error('not found')
      return ''
    })
    vi.mocked(config).tls = { mode: 'import-cert', certPath: '/cert.pem', keyPath: '/key.pem' }
    vi.mocked(createCertProvider).mockReturnValue({
      ensureCert: vi.fn().mockResolvedValue({ cert: 'CERT', key: 'KEY' }),
    } as never)
    vi.mocked(resolveRelayDisplayHost).mockReturnValue(displayHost)
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))

    await cmdStart({})

    const line = agentConnectLine(output)
    expect(line).toContain('wss://<this-ip>:4000')
    expect(line).not.toContain(`wss://${displayHost}:4000`)
  })

  it('macOS + adb 있으면 iOS와 Android 모두 연결', async () => {
    await cmdStart({})
    expect(iosConnectSpy).toHaveBeenCalled()
    expect(androidConnectSpy).toHaveBeenCalled()
  })

  it('--platform ios 이면 iOS만 연결', async () => {
    await cmdStart({ platform: 'ios' })
    expect(iosConnectSpy).toHaveBeenCalled()
    expect(androidConnectSpy).not.toHaveBeenCalled()
  })

  it('--platform android 이면 Android만 연결', async () => {
    await cmdStart({ platform: 'android' })
    expect(iosConnectSpy).not.toHaveBeenCalled()
    expect(androidConnectSpy).toHaveBeenCalled()
  })

  it('adb 없으면 iOS만 연결', async () => {
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') throw new Error('not found')
      return ''
    })

    await cmdStart({})
    expect(iosConnectSpy).toHaveBeenCalled()
    expect(androidConnectSpy).not.toHaveBeenCalled()
  })

  it('--device 로 특정 디바이스 지정', async () => {
    await cmdStart({ platform: 'ios', device: 'iPhone 16 Pro' })
    expect(iosConnectSpy).toHaveBeenCalledWith('ws://localhost:4000', { deviceFilter: 'iPhone 16 Pro' })
  })

  it('존재하지 않는 --device 지정 시 exit(1)', async () => {
    iosConnectSpy.mockRejectedValue(new Error('Device "NonExistent" not found'))
    AgentRegistry.register('ios', DummyAgent as never, { canRun: () => true, connect: iosConnectSpy })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })

    await expect(cmdStart({ platform: 'ios', device: 'NonExistent' })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('connect 실패 시 exit(1)', async () => {
    iosConnectSpy.mockRejectedValue(new Error('connection refused'))
    AgentRegistry.register('ios', DummyAgent as never, { canRun: () => true, connect: iosConnectSpy })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    await expect(cmdStart({ platform: 'ios' })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('비-Mac + adb 없음 → 릴레이 기동 후 relay-only 모드 (exit 없음)', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string) === 'which adb') throw new Error('not found')
      return ''
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })

    await cmdStart({})

    expect(RelayServer).toHaveBeenCalled()
    expect(iosConnectSpy).not.toHaveBeenCalled()
    expect(androidConnectSpy).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('--platform 미등록 플랫폼 → exit(1)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    await expect(cmdStart({ platform: 'web' })).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  describe('터널', () => {
    it('config.tunnel 없으면 터널 기동 안 함', async () => {
      await cmdStart({})
      expect(startConfiguredTunnel).not.toHaveBeenCalled()
    })

    it('config.tunnel 있으면 터널 기동 + 공개 URL이 배너에 출력', async () => {
      vi.mocked(config).tunnel = { provider: 'tailscale' }
      const output: string[] = []
      vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))

      await cmdStart({})

      expect(startConfiguredTunnel).toHaveBeenCalledWith({ provider: 'tailscale' }, { relayPort: 4000, tunnelPort: 4001 })
      expect(output.join('\n')).toContain('my-mac.tailnet.ts.net')
    })

    it('SIGINT 시 에이전트와 터널 모두 종료', async () => {
      vi.mocked(config).tunnel = { provider: 'tailscale' }
      const onSpy = vi.spyOn(process, 'on')
      vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

      await cmdStart({ platform: 'ios' })

      const call = onSpy.mock.calls.find(([event]) => event === 'SIGINT')
      const handler = call![1] as () => void
      handler()
      expect(iosDisconnectSpy).toHaveBeenCalled()
      expect(mockTunnel.stop).toHaveBeenCalled()
    })

    it('터널 기동 실패(publicUrl null)면 localhost 배너 유지', async () => {
      vi.mocked(config).tunnel = { provider: 'tailscale' }
      vi.mocked(startConfiguredTunnel).mockResolvedValue({ tunnel: null, publicUrl: null })
      const output: string[] = []
      vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))

      await cmdStart({ platform: 'ios' })

      expect(output.join('\n')).toContain('localhost:4000')
      expect(output.join('\n')).not.toContain('Public :')
    })

    it('터널이 없으면 tunnel 옵션을 넘기지 않고 포트도 따로 확인하지 않는다', async () => {
      await cmdStart({ platform: 'ios' })
      expect(vi.mocked(RelayServer).mock.calls[0][0].tunnel).toBeUndefined()
      expect(vi.mocked(RelayServer).mock.calls[0][0].tunnelPort).toBeUndefined()
      expect(refuseUnlessBindable).not.toHaveBeenCalled()
    })

    it('opens the tunnel listener without a tunnel when its port is named', async () => {
      vi.mocked(config).local.tunnelPort = 4100
      await cmdStart({ platform: 'ios' })
      expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ tunnelPort: 4100 }))
      expect(startConfiguredTunnel).not.toHaveBeenCalled()
    })

    // The co-located agent keeps the relay port: it is the one connection that is local by design.
    it('with a tunnel, opens the tunnel listener and keeps the agent on the relay port', async () => {
      vi.mocked(config).tunnel = { provider: 'tailscale' }
      await cmdStart({ platform: 'ios' })
      expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ port: 4000, tunnelPort: 4001 }))
      expect(refuseUnlessBindable).toHaveBeenCalledWith(4001, 'tunnel', '127.0.0.1')
      expect(iosConnectSpy).toHaveBeenCalledWith('ws://localhost:4000', expect.anything())
    })

    it('refuses a tunnel port equal to the relay port before the tunnel starts', async () => {
      vi.mocked(config).tunnel = { provider: 'tailscale' }
      vi.mocked(config).local.tunnelPort = 4000
      await expect(cmdStart({ platform: 'ios' })).rejects.toThrow(/must differ from the relay port/)
      expect(startConfiguredTunnel).not.toHaveBeenCalled()
      expect(refuseUnlessBindable).not.toHaveBeenCalled()
    })

    it('a taken tunnel port stops everything before the tunnel starts', async () => {
      vi.mocked(config).tunnel = { provider: 'tailscale' }
      vi.mocked(refuseUnlessBindable).mockImplementation(async (port, role) => {
        if (role === 'tunnel') throw new Error(`Tunnel port ${port} is already in use. Stop the process holding it, or set TAPFLOW_TUNNEL_PORT to a free port.`)
      })
      await expect(cmdStart({ platform: 'ios' })).rejects.toThrow(/4001.*TAPFLOW_TUNNEL_PORT/)
      expect(startConfiguredTunnel).not.toHaveBeenCalled()
      expect(RelayServer).not.toHaveBeenCalled()
    })

    it('on a relay with no admin yet, points setup at this Mac rather than the public URL', async () => {
      vi.mocked(config).tunnel = { provider: 'tailscale' }
      vi.mocked(isInitialized).mockReturnValue(false)
      const output: string[] = []
      vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
      await cmdStart({ platform: 'ios' })
      const text = output.join('\n')
      expect(text).toContain('tapflow admin init')
      expect(text).toContain('localhost:4000')
    })

    // #794: the relay reads config, and config names a tunnel without saying whether it came up or at
    // which address. The CLI knows, so it starts the tunnel first and hands the outcome over.
    describe('실제 터널 결과를 relay에 넘긴다', () => {
      beforeEach(() => {
        vi.mocked(config).tunnel = { provider: 'tailscale' }
      })

      it('터널이 RelayServer 생성보다 먼저 시작된다', async () => {
        await cmdStart({ platform: 'ios' })
        expect(vi.mocked(startConfiguredTunnel).mock.invocationCallOrder[0])
          .toBeLessThan(vi.mocked(RelayServer).mock.invocationCallOrder[0])
      })

      it('터널 결과와 그 결과로 계산한 CORS 목록이 RelayServer에 도착한다', async () => {
        vi.mocked(buildCorsOrigins).mockImplementation((_cfg, _port, tunnel) => (tunnel ? ['sentinel'] : []))
        await cmdStart({ platform: 'ios' })
        const runtime = { publicUrl: 'http://my-mac.tailnet.ts.net:4000' }
        expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ tunnel: runtime, corsOrigins: ['sentinel'] }))
        expect(proxyWithoutPublicUrlWarning).toHaveBeenCalledWith(config, runtime)
      })

      it('터널이 시작을 보고하지 못하면 publicUrl null을 넘긴다', async () => {
        vi.mocked(startConfiguredTunnel).mockResolvedValue({ tunnel: null, publicUrl: null })
        await cmdStart({ platform: 'ios' })
        expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ tunnel: { publicUrl: null } }))
      })

      it('TLS relay에는 http:// 터널 주소를 넘기지 않는다', async () => {
        vi.mocked(config).tls = { mode: 'import-cert', certPath: '/cert.pem', keyPath: '/key.pem' }
        vi.mocked(createCertProvider).mockReturnValue({
          ensureCert: vi.fn().mockResolvedValue({ cert: 'CERT', key: 'KEY' }),
        } as never)
        vi.mocked(resolveRelayDisplayHost).mockReturnValue('relay.example.com')
        const output: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
        const warnings: string[] = []
        vi.spyOn(console, 'warn').mockImplementation((...args) => { warnings.push(args.join(' ')) })
        await cmdStart({ platform: 'ios' })
        expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ tunnel: { publicUrl: null } }))
        // The banner advertises only what the relay hands out, and says why it dropped the rest.
        expect(output.join('\n')).not.toContain('my-mac.tailnet.ts.net')
        expect(warnings.join('\n')).toContain('Not advertising http://my-mac.tailnet.ts.net:4000')
      })

      it('relay 시작이 실패하면 터널을 멈추고 원래 오류를 전파한다', async () => {
        const failure = new Error('Port 4000 is already in use. Stop the existing process and try again.')
        vi.mocked(RelayServer).mockImplementation(function () { return { start: vi.fn().mockRejectedValue(failure) } as never })
        await expect(cmdStart({ platform: 'ios' })).rejects.toBe(failure)
        expect(mockTunnel.stop).toHaveBeenCalled()
      })

      it('RelayServer 생성자가 던져도 터널을 멈춘다', async () => {
        const failure = new Error('key values mismatch')
        vi.mocked(RelayServer).mockImplementation(function () { throw failure })
        await expect(cmdStart({ platform: 'ios' })).rejects.toBe(failure)
        expect(mockTunnel.stop).toHaveBeenCalled()
      })

      it('포트가 이미 쓰이면 터널도 relay도 시작하지 않는다', async () => {
        vi.mocked(refuseUnlessBindable).mockRejectedValue(new Error('Port 4000 is already in use. Stop the existing process and try again.'))
        await expect(cmdStart({ platform: 'ios' })).rejects.toThrow('already in use')
        expect(refuseUnlessBindable).toHaveBeenCalledWith(4000, 'relay')
        expect(startConfiguredTunnel).not.toHaveBeenCalled()
        expect(RelayServer).not.toHaveBeenCalled()
      })
    })
  })
})
