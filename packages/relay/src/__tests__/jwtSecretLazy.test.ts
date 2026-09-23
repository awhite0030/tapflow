import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * **Importing the config writes nothing.** It used to: the secret was created at module scope, and
 * the CLI imports every command's module at startup, so `tapflow --version` in any directory left a
 * `.tapflow/data/jwt-secret` behind — six of them are sitting in this repo. An agent-only Mac and a
 * CI runner got one too, for a relay they never start.
 *
 * `RelayServer.start()` calls `getJwtSecret()`, so a booting relay still creates and logs it, and a
 * data dir it cannot write to still fails the boot rather than the first sign-in.
 */
describe('the JWT secret is created on first use', () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-lazy-secret-'))
    vi.resetModules()
    vi.stubEnv('TAPFLOW_HOME', home)
    // undefined deletes it: an empty JWT_SECRET is a value, and a too-short one is refused.
    vi.stubEnv('JWT_SECRET', undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('writes no secret when the config module is imported', async () => {
    const { config } = await import('../lib/config.js')
    expect(config.local.dataDir).toBe(path.join(home, 'data'))
    expect(fs.existsSync(path.join(home, 'data', 'jwt-secret'))).toBe(false)
    expect(fs.readdirSync(home)).toEqual([])
  })

  it('writes it when something signs or verifies for the first time', async () => {
    const { getJwtSecret } = await import('../lib/config.js')
    const secret = getJwtSecret()
    expect(secret.length).toBeGreaterThanOrEqual(32)
    expect(fs.readFileSync(path.join(home, 'data', 'jwt-secret'), 'utf-8').trim()).toBe(secret)
  })

  it('reuses it across calls, so restarts keep sessions signed in', async () => {
    const { getJwtSecret } = await import('../lib/config.js')
    expect(getJwtSecret()).toBe(getJwtSecret())
  })

  it('still refuses a JWT_SECRET that is too short, at import', async () => {
    vi.stubEnv('JWT_SECRET', 'x'.repeat(31))
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(import('../lib/config.js')).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
