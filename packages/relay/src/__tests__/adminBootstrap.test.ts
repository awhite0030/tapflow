import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, getDb, closeDb } from '../db'
import { bootstrapAdminFromEnv, type BootstrapLogger } from '../lib/adminBootstrap'
import { verifyPassword } from '../lib/adminAccount'

// The first account for an install that cannot reach `POST /api/v1/auth/init`.
//
// That endpoint requires `resolveClient(req).isLocal`, which a container never satisfies — it is
// always behind its bridge gateway. Measured against the published image, the call answers 403 from
// the host's own browser and from the LAN alike, and the image carries no CLI to run instead
// (relay-only, by design). So a Docker install had no way to create an owner at all.

const PASSWORD = 'correct-horse-battery'

/** Both channels as one list, which is what the leak assertion has to search. */
function makeLogger() {
  const lines: { level: 'info' | 'warn'; message: string }[] = []
  const logger: BootstrapLogger = {
    info: (message) => lines.push({ level: 'info', message }),
    warn: (message) => lines.push({ level: 'warn', message }),
  }
  return {
    logger,
    lines,
    info: () => lines.filter((l) => l.level === 'info').map((l) => l.message),
    warn: () => lines.filter((l) => l.level === 'warn').map((l) => l.message),
    all: () => lines.map((l) => l.message).join('\n'),
  }
}

const users = () => getDb().prepare('SELECT email, role, password_hash FROM users').all() as
  { email: string; role: string; password_hash: string | null }[]

describe('bootstrapAdminFromEnv', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-admin-bootstrap-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    getDb().prepare('DELETE FROM users').run()
  })

  it('creates the first admin and names the email it used', () => {
    const log = makeLogger()
    bootstrapAdminFromEnv({ TAPFLOW_ADMIN_EMAIL: 'owner@example.com', TAPFLOW_ADMIN_PASSWORD: PASSWORD }, log.logger)

    const rows = users()
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe('owner@example.com')
    expect(rows[0].role).toBe('Admin')
    expect(log.info()).toHaveLength(1)
    expect(log.info()[0]).toContain('owner@example.com')
  })

  it('produces a password that logs in, so the boot path and the HTTP path make the same account', () => {
    bootstrapAdminFromEnv({ TAPFLOW_ADMIN_EMAIL: 'owner@example.com', TAPFLOW_ADMIN_PASSWORD: PASSWORD }, makeLogger().logger)
    const hash = users()[0].password_hash
    expect(hash).toBeTruthy()
    expect(verifyPassword(PASSWORD, hash!)).toBe(true)
    expect(verifyPassword('not the password', hash!)).toBe(false)
  })

  it('does nothing at all when an owner already exists', () => {
    bootstrapAdminFromEnv({ TAPFLOW_ADMIN_EMAIL: 'first@example.com', TAPFLOW_ADMIN_PASSWORD: PASSWORD }, makeLogger().logger)
    const before = users()

    // Second boot, different values: the account must not be replaced, and nothing may be logged —
    // otherwise a long-running install accumulates one line per restart.
    const log = makeLogger()
    bootstrapAdminFromEnv({ TAPFLOW_ADMIN_EMAIL: 'second@example.com', TAPFLOW_ADMIN_PASSWORD: 'another-password' }, log.logger)

    expect(users()).toEqual(before)
    expect(log.lines).toHaveLength(0)
  })

  it('is silent when neither variable is set, which is every non-container install', () => {
    const log = makeLogger()
    bootstrapAdminFromEnv({}, log.logger)
    expect(users()).toHaveLength(0)
    expect(log.lines).toHaveLength(0)
  })

  const INCOMPLETE = {
    'only the email': { TAPFLOW_ADMIN_EMAIL: 'owner@example.com' },
    'only the password': { TAPFLOW_ADMIN_PASSWORD: PASSWORD },
    'a password under 8 characters': { TAPFLOW_ADMIN_EMAIL: 'owner@example.com', TAPFLOW_ADMIN_PASSWORD: 'short12' },
    'an email that is only whitespace': { TAPFLOW_ADMIN_EMAIL: '   ', TAPFLOW_ADMIN_PASSWORD: PASSWORD },
  }
  for (const [what, env] of Object.entries(INCOMPLETE)) {
    it(`warns and keeps booting given ${what}`, () => {
      const log = makeLogger()
      // The call returning at all is the "keeps booting" half: `server.ts` runs this inline before
      // it starts listening, so a throw here would take the relay down.
      expect(() => bootstrapAdminFromEnv(env, log.logger)).not.toThrow()
      expect(users()).toHaveLength(0)
      expect(log.warn()).toHaveLength(1)
      expect(log.info()).toHaveLength(0)
    })
  }

  it('never writes the password to the log, on any path', () => {
    // **The one assertion here that is about absence**, so it is the one that can pass while broken.
    // Verified by mutation: adding the password to the success line in `adminBootstrap.ts` fails
    // this test and nothing else in this file.
    const cases = [
      { TAPFLOW_ADMIN_EMAIL: 'owner@example.com', TAPFLOW_ADMIN_PASSWORD: PASSWORD },
      { TAPFLOW_ADMIN_PASSWORD: PASSWORD },
      { TAPFLOW_ADMIN_EMAIL: 'owner@example.com', TAPFLOW_ADMIN_PASSWORD: 'short12' },
    ]
    for (const env of cases) {
      getDb().prepare('DELETE FROM users').run()
      const log = makeLogger()
      bootstrapAdminFromEnv(env, log.logger)
      expect(log.all(), JSON.stringify(env)).not.toContain(env.TAPFLOW_ADMIN_PASSWORD!)
    }
  })

  it('trims the email, so a stray newline from an env file does not become part of it', () => {
    bootstrapAdminFromEnv({ TAPFLOW_ADMIN_EMAIL: '  owner@example.com\n', TAPFLOW_ADMIN_PASSWORD: PASSWORD }, makeLogger().logger)
    expect(users()[0].email).toBe('owner@example.com')
  })
})
