import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  initDb: vi.fn(),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  ensureCert: vi.fn().mockResolvedValue({ cert: 'CERT', key: 'KEY' }),
  resolveRelayDisplayHost: vi.fn(() => 'relay.example.com'),
  tls: { mode: 'import-cert', certPath: '/cert.pem', keyPath: '/key.pem' } as const,
  containerWarning: vi.fn((): string | null => null),
  inContainer: vi.fn(() => false),
  // Hoisted so the same mock survives `vi.resetModules()` between imports of the entry point.
  RelayServer: vi.fn(function (_options: { port: number; tunnelPort?: number }): { start: () => Promise<unknown>; stop: () => Promise<unknown> } {
    return { start: mocks.start, stop: mocks.stop }
  }),
  local: { port: 4000, dataDir: '/tmp/tapflow-test', wsBackpressureBytes: 1048576, trustedProxies: [] as string[], tunnelPort: null as number | null },
}))

vi.mock('@tapflowio/agent-core', () => ({
  createLogger: vi.fn(() => ({ info: mocks.info, warn: mocks.warn, error: mocks.error })),
}))
vi.mock('../db.js', () => ({ initDb: mocks.initDb }))
vi.mock('../RelayServer.js', () => ({
  RelayServer: mocks.RelayServer,
}))
vi.mock('../lib/config.js', () => ({
  config: {
    local: mocks.local,
    relay: { url: null },
    tunnel: null,
    tls: mocks.tls,
  },
  loadedEnvPath: null,
  // server.ts refuses a TAPFLOW_HOME naming a directory nobody created; these tests name none.
  assertInstallDir: vi.fn(),
}))
vi.mock('../lib/proxyConfig.js', () => ({
  buildCorsOrigins: vi.fn(() => []),
  proxyWithoutPublicUrlWarning: vi.fn(() => null),
  containerWithoutPublicUrlWarning: mocks.containerWarning,
}))
vi.mock('../lib/lanAddress.js', () => ({ runningInContainer: mocks.inContainer }))
vi.mock('../lib/cert/index.js', () => ({
  createCertProvider: vi.fn(() => ({ ensureCert: mocks.ensureCert })),
  resolveRelayDisplayHost: mocks.resolveRelayDisplayHost,
}))
vi.mock('../lib/tlsTasks.js', () => ({ startTlsBackgroundTasks: vi.fn(() => () => {}) }))

describe('relay server startup output', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.inContainer.mockReturnValue(false)
    mocks.containerWarning.mockReturnValue(null)
    mocks.local.tunnelPort = null
    vi.resetModules()
    vi.spyOn(process, 'on').mockImplementation(() => process)
  })

  afterEach(() => vi.restoreAllMocks())

  it('uses the imported certificate host in the advertised URL', async () => {
    await import('../server.js')

    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled())
    expect(mocks.resolveRelayDisplayHost).toHaveBeenCalledWith(mocks.tls, 'CERT', expect.any(Function))
    expect(mocks.info).toHaveBeenCalledWith('tapflow relay running at https://relay.example.com:4000')
  })

  it('logs the container warning, deciding with the real container check', async () => {
    mocks.inContainer.mockReturnValue(true)
    mocks.containerWarning.mockReturnValue('Running in a container with no public URL')

    await import('../server.js')

    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled())
    expect(mocks.containerWarning).toHaveBeenCalledWith(expect.objectContaining({ relay: { url: null } }), true)
    expect(mocks.warn).toHaveBeenCalledWith('Running in a container with no public URL')
  })

  // This entry point starts no tunnel, so a configured `tunnel` block alone does not open the listener —
  // only a port named on purpose does, for a tunnel or proxy sharing the relay's network namespace.
  it('opens the tunnel listener only when a tunnel port is named', async () => {
    await import('../server.js')
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled())
    expect(mocks.RelayServer.mock.calls[0]![0]).toMatchObject({ port: 4000 })
    expect(mocks.RelayServer.mock.calls[0]![0].tunnelPort).toBeUndefined()

    vi.clearAllMocks()
    vi.resetModules()
    mocks.local.tunnelPort = 4100
    await import('../server.js')
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled())
    expect(mocks.RelayServer).toHaveBeenCalledWith(expect.objectContaining({ tunnelPort: 4100 }))
  })
})
