import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// The probe is replaced so a relay a developer left running on this machine cannot decide these tests.
// The probe itself is `port-available.test.ts`'s subject; what matters here is what the command does
// with each answer.
vi.mock('../../lib/port-available.js', () => ({ probeBind: vi.fn() }))

import { config } from '@tapflowio/relay'
import { cmdMigrateDataDir } from '../../commands/migrate.js'
import { probeBind } from '../../lib/port-available.js'

const mockProbe = vi.mocked(probeBind)
const bindError = (code: string) => Object.assign(new Error(code), { code }) as NodeJS.ErrnoException

/**
 * **`migrate data-dir` moves the install's legacy directory, not the one you are standing in.**
 *
 * It read the current directory until the install dir existed. The self-hosting guide tells a
 * server operator to set `TAPFLOW_HOME` and run tapflow commands from wherever they are, so the old
 * behaviour answered "nothing to migrate" while the install's `.tapflow-data/` stayed put and the
 * relay went on warning about it at every start.
 */
describe('cmdMigrateDataDir', () => {
  let install: string
  let elsewhere: string
  let output: string[]

  beforeEach(() => {
    install = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-migrate-install-'))
    elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-migrate-cwd-'))
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    vi.spyOn(process, 'cwd').mockReturnValue(elsewhere)
    vi.stubEnv('TAPFLOW_HOME', install)
    mockProbe.mockReset().mockResolvedValue(null)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    for (const d of [install, elsewhere]) fs.rmSync(d, { recursive: true, force: true })
  })

  it('moves the legacy directory of the install, run from anywhere', async () => {
    fs.mkdirSync(path.join(install, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(path.join(install, '.tapflow-data', 'tapflow.db'), 'DB')

    await cmdMigrateDataDir()

    expect(fs.readFileSync(path.join(install, '.tapflow', 'data', 'tapflow.db'), 'utf-8')).toBe('DB')
    expect(fs.existsSync(path.join(install, '.tapflow-data'))).toBe(false)
    expect(fs.readdirSync(elsewhere)).toEqual([])
    expect(output.join('\n')).toContain('DATA DIRECTORY MIGRATED')
  })

  it('does not migrate a legacy directory that belongs to the current directory instead', async () => {
    // Someone else's `.tapflow-data` in the cwd is not this install's data.
    fs.mkdirSync(path.join(elsewhere, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(path.join(elsewhere, '.tapflow-data', 'tapflow.db'), 'DB')

    await cmdMigrateDataDir()

    expect(fs.existsSync(path.join(elsewhere, '.tapflow-data', 'tapflow.db'))).toBe(true)
    expect(fs.existsSync(path.join(elsewhere, '.tapflow', 'data'))).toBe(false)
    expect(output.join('\n')).toContain('NOTHING TO MIGRATE')
  })

  describe('what `tapflow migrate data-dir` prints and exits with', () => {
    // Captured before the command was split into a result-returning step and a banner, so the split
    // cannot change what someone running the subcommand on its own sees.
    const run = () => Promise.resolve().then(() => cmdMigrateDataDir())
    let exitSpy: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit') }) as never)
    })

    it('reports a conflict and exits 1', async () => {
      fs.mkdirSync(path.join(install, '.tapflow-data'), { recursive: true })
      fs.mkdirSync(path.join(install, '.tapflow', 'data'), { recursive: true })

      await expect(run()).rejects.toThrow('process.exit')

      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(output.join('\n')).toContain('MIGRATION BLOCKED')
    })

    it('reports a cross-filesystem move and exits 1', async () => {
      fs.mkdirSync(path.join(install, '.tapflow-data'), { recursive: true })
      vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        const e = new Error('cross-device') as NodeJS.ErrnoException
        e.code = 'EXDEV'
        throw e
      })

      await expect(run()).rejects.toThrow('process.exit')

      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(output.join('\n')).toContain('CROSS-FILESYSTEM MOVE')
    })

    it('reports nothing to migrate and exits 0', async () => {
      await run()

      expect(exitSpy).not.toHaveBeenCalled()
      expect(output.join('\n')).toContain('NOTHING TO MIGRATE')
    })
  })

  describe('refused while the relay is running (#836)', () => {
    // A relay holds its uploads directory in memory: a build uploaded after the move lands back in a
    // recreated .tapflow-data/, outside the data the relay reads after its restart.
    let exitSpy: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit') }) as never)
      fs.mkdirSync(path.join(install, '.tapflow-data'), { recursive: true })
      fs.writeFileSync(path.join(install, '.tapflow-data', 'tapflow.db'), 'DB')
    })

    it('refuses, moves nothing and exits 1 when the relay port is taken', async () => {
      // Not the default, so a probe of a hardcoded 4000 cannot pass. The relay's resolved port is the
      // one that counts: `TAPFLOW_PORT` from the shell or the data dir's `.env` lands there.
      vi.spyOn(config.local, 'port', 'get').mockReturnValue(4777)
      mockProbe.mockResolvedValue(bindError('EADDRINUSE'))

      await expect(cmdMigrateDataDir()).rejects.toThrow('process.exit')

      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(mockProbe).toHaveBeenCalledWith(4777)
      expect(fs.readFileSync(path.join(install, '.tapflow-data', 'tapflow.db'), 'utf-8')).toBe('DB')
      expect(fs.existsSync(path.join(install, '.tapflow', 'data'))).toBe(false)
      const out = output.join('\n')
      expect(out).toContain('STOP THE RELAY FIRST')
      expect(out).toContain('port 4777')
    })

    it('does not read a bind error other than EADDRINUSE as a running relay', async () => {
      // EACCES on a port under 1024 says nothing about whether a relay is there.
      mockProbe.mockResolvedValue(bindError('EACCES'))

      await cmdMigrateDataDir()

      expect(exitSpy).not.toHaveBeenCalled()
      expect(output.join('\n')).toContain('DATA DIRECTORY MIGRATED')
    })

    it('does not probe when there is nothing to move', async () => {
      fs.rmSync(path.join(install, '.tapflow-data'), { recursive: true })
      mockProbe.mockResolvedValue(bindError('EADDRINUSE'))

      await cmdMigrateDataDir()

      expect(mockProbe).not.toHaveBeenCalled()
      expect(output.join('\n')).toContain('NOTHING TO MIGRATE')
    })
  })
})
