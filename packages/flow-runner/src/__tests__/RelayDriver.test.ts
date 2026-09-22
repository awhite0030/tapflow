import { describe, it, expect, vi } from 'vitest'
import { PlatformError } from '@tapflowio/agent-core'
import { RelayDriver } from '../RelayDriver.js'
import { runFlow } from '../engine.js'
import { parseFlow } from '../schema.js'
import { EnvironmentStepError, isEnvironmentStepFailure, TransientQueryError } from '../errors.js'
import {
  InputRefusedError,
  InputUnconfirmedError,
  type RelayClient,
  RelayClosedError,
  RelayHttpError,
  RequestTimeoutError,
  RelayUnavailableError,
  SessionEndedError,
  SessionUnavailableError,
} from '../RelayClient.js'

// RelayDriver takes the concrete client; the fake below satisfies the methods
// the driver calls, cast once at construction rather than per test.
function driverWith(client: Record<string, (...args: never[]) => Promise<unknown>>) {
  return new RelayDriver(client as unknown as RelayClient, 's1', 7)
}

describe('RelayDriver failure-kind mapping (#543)', () => {
  it('retypes relay/agent/session failures as EnvironmentStepError, message and cause preserved', async () => {
    const cases: Array<() => Error> = [
      () => new SessionEndedError('app install failed: gone (agent-disconnected)', 'agent-disconnected'),
      () => new SessionUnavailableError('ui-tree query failed - the relay ended this session (gone)'),
      () => new InputRefusedError('not-booted', new PlatformError('tap was refused by the device (not-booted): down')),
      () => new InputRefusedError('channel-unavailable', new PlatformError('tap was refused (channel-unavailable): x')),
      () => new InputRefusedError('channel-starting', new PlatformError('tap was refused (channel-starting): x')),
      () => new InputRefusedError('dispatch-failed', new PlatformError('tap was refused (dispatch-failed): x')),
      () => new InputRefusedError('not-session-owner', new PlatformError('tap was refused (not-session-owner): x')),
      () => new InputUnconfirmedError('tap was not confirmed'),
      () => new RelayClosedError('relay connection closed'),
      () => new RequestTimeoutError('tap timed out'),
      () => new RelayUnavailableError('not connected to relay'),
      () => new RelayHttpError('session not found', 404),
      () => new SessionUnavailableError('device boot failed — the relay ended this session (gone)'),
    ]
    for (const make of cases) {
      const original = make()
      const driver = driverWith({ tap: vi.fn(async () => { throw original }) })
      const err = await driver.tap(0.5, 0.5).catch((e: unknown) => e)
      expect(err).toBe(original)
      expect(isEnvironmentStepFailure(err)).toBe(true)
      expect(err).toBeInstanceOf(PlatformError)
      expect((err as Error).message).toBe(original.message)
    }
  })

  it('rethrows product failures untouched, same instance', async () => {
    const cases: Array<() => Error> = [
      () => new InputRefusedError('malformed', new PlatformError('tap was refused (malformed): bad frame')),
      () => new InputRefusedError('unsupported', new PlatformError('tap was refused (unsupported): no')),
      () => new InputRefusedError('no-gesture', new PlatformError('tap was refused (no-gesture): unsure')),
      () => new Error('launchApp needs a build under test'),
      // A launch failure on a healthy session is a broken build, not infra:
      // failed() returns a plain PlatformError when no session note applies.
      () => new PlatformError('launch failed'),
    ]
    for (const make of cases) {
      const original = make()
      const driver = driverWith({ tap: vi.fn(async () => { throw original }) })
      const err = await driver.tap(0.5, 0.5).catch((e: unknown) => e)
      expect(err).toBe(original)
    }
  })

  it('lets TransientQueryError through unwrapped so the poll loop keeps retrying it', async () => {
    const original = new TransientQueryError('agent blip')
    const driver = driverWith({ queryUITree: vi.fn(async () => { throw original }) })
    const err = await driver.queryUITree().catch((e: unknown) => e)
    expect(err).toBe(original)
  })

  it('launchApp without a build is an environment configuration failure', async () => {
    const driver = new RelayDriver({} as unknown as RelayClient, 's1')
    const err = await driver.launchApp().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EnvironmentStepError)
    expect(isEnvironmentStepFailure(err)).toBe(true)
    expect((err as Error).message).toContain('--build')
  })

  it('carries a marked relay failure through the engine as environmental', async () => {
    const client = {
      queryUITree: vi.fn(async () => { throw new RelayHttpError('relay unavailable', 503) }),
      screenshot: vi.fn(async () => Buffer.from('PNG')),
    } as unknown as RelayClient
    const result = await runFlow(parseFlow('steps:\n  - assertVisible: "OK"\n', 'test.yaml'), new RelayDriver(client, 's1'), {
      defaultTimeoutMs: 20,
      pollIntervalMs: 1,
    })
    expect(result.failureKind).toBe('environment')
  })
})
