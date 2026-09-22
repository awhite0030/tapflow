import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { cmdMigrateDataDir } from '../../commands/migrate.js'

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
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    for (const d of [install, elsewhere]) fs.rmSync(d, { recursive: true, force: true })
  })

  it('moves the legacy directory of the install, run from anywhere', () => {
    fs.mkdirSync(path.join(install, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(path.join(install, '.tapflow-data', 'tapflow.db'), 'DB')

    cmdMigrateDataDir()

    expect(fs.readFileSync(path.join(install, '.tapflow', 'data', 'tapflow.db'), 'utf-8')).toBe('DB')
    expect(fs.existsSync(path.join(install, '.tapflow-data'))).toBe(false)
    expect(fs.readdirSync(elsewhere)).toEqual([])
    expect(output.join('\n')).toContain('DATA DIRECTORY MIGRATED')
  })

  it('does not migrate a legacy directory that belongs to the current directory instead', () => {
    // Someone else's `.tapflow-data` in the cwd is not this install's data.
    fs.mkdirSync(path.join(elsewhere, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(path.join(elsewhere, '.tapflow-data', 'tapflow.db'), 'DB')

    cmdMigrateDataDir()

    expect(fs.existsSync(path.join(elsewhere, '.tapflow-data', 'tapflow.db'))).toBe(true)
    expect(fs.existsSync(path.join(elsewhere, '.tapflow', 'data'))).toBe(false)
    expect(output.join('\n')).toContain('NOTHING TO MIGRATE')
  })
})
