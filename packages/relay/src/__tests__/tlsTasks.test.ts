import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WebSocket } from 'ws'
import type { TapflowConfig } from '../lib/config.js'

const { startCertRenewal, startAddressPublisher, stopRenewal, stopPublish } = vi.hoisted(() => {
  const stopRenewal = vi.fn()
  const stopPublish = vi.fn()
  return {
    stopRenewal,
    stopPublish,
    startCertRenewal: vi.fn(() => stopRenewal),
    startAddressPublisher: vi.fn(() => stopPublish),
  }
})

vi.mock('../lib/cert/index.js', () => ({ startCertRenewal, startAddressPublisher }))

import { startTlsBackgroundTasks } from '../lib/tlsTasks'

const provider = {} as never
const server = { updateTlsContext: vi.fn() } as never
// `as never` made this assignable to anything and spreadable to nothing — `satisfies` keeps the
// literal narrow while still checking it against the config union.
const byoToken = { mode: 'byo-api-token', domain: 'x.example.com', dnsProvider: 'cloudflare' } satisfies TapflowConfig['tls']

describe('startTlsBackgroundTasks', () => {
  beforeEach(() => vi.clearAllMocks())

  it('always starts cert renewal', () => {
    startTlsBackgroundTasks(provider, server, null)
    expect(startCertRenewal).toHaveBeenCalledOnce()
  })

  it('publishes the address for byo-api-token (publishAddress not false)', () => {
    startTlsBackgroundTasks(provider, server, byoToken)
    expect(startAddressPublisher).toHaveBeenCalledWith(byoToken)
  })

  it('does not publish for import-cert', () => {
    startTlsBackgroundTasks(provider, server, { mode: 'import-cert', certPath: 'c', keyPath: 'k' } as never)
    expect(startAddressPublisher).not.toHaveBeenCalled()
  })

  it('does not publish when publishAddress is false', () => {
    startTlsBackgroundTasks(provider, server, { ...byoToken, publishAddress: false })
    expect(startAddressPublisher).not.toHaveBeenCalled()
  })

  it('stop() stops both renewal and publish', () => {
    const stop = startTlsBackgroundTasks(provider, server, byoToken)
    stop()
    expect(stopRenewal).toHaveBeenCalledOnce()
    expect(stopPublish).toHaveBeenCalledOnce()
  })

  it('stop() is safe when there is no publisher (import-cert)', () => {
    const stop = startTlsBackgroundTasks(provider, server, { mode: 'import-cert', certPath: 'c', keyPath: 'k' } as never)
    expect(() => stop()).not.toThrow()
    expect(stopRenewal).toHaveBeenCalledOnce()
  })
})
