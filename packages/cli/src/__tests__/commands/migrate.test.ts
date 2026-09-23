import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('@clack/prompts', async (actual) => ({
  ...(await actual<typeof import('@clack/prompts')>()),
  confirm: vi.fn(),
}))
vi.mock('../../lib/interactive.js', () => ({ isInteractive: vi.fn() }))
vi.mock('../../lib/net-filter.js', async (actual) => ({
  ...(await actual<typeof import('../../lib/net-filter.js')>()),
  readNetFilterState: vi.fn(),
  isFilterEnforcing: vi.fn(),
}))

import { confirm } from '@clack/prompts'
import { cmdMigrate, MIGRATIONS, type Migration, type MigrationCheck, type StepResult } from '../../commands/migrate.js'
import { isInteractive } from '../../lib/interactive.js'
import { readNetFilterState, isFilterEnforcing, type NetFilterState } from '../../lib/net-filter.js'

const mockConfirm = vi.mocked(confirm)
const mockInteractive = vi.mocked(isInteractive)
const mockState = vi.mocked(readNetFilterState)
const mockEnforcing = vi.mocked(isFilterEnforcing)

function fake(id: string, check: MigrationCheck, result: StepResult = 'ok'): Migration & { run: ReturnType<typeof vi.fn> } {
  return { id, check: () => check, run: vi.fn(async () => result) }
}
const pending = (summary = 'something') => ({ state: 'pending', summary }) as const

describe('tapflow migrate — the runner', () => {
  let output: string[]
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    vi.spyOn(console, 'warn').mockImplementation((...args) => output.push(args.join(' ')))
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit') }) as never)
    mockInteractive.mockReturnValue(false)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('says there is nothing to migrate and exits 0 when nothing is due', async () => {
    const a = fake('a', { state: 'none' })

    await cmdMigrate([a])

    expect(a.run).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
    expect(output.join('\n')).toContain('NOTHING TO MIGRATE')
  })

  it('runs every pending migration in order without asking when no terminal is attached', async () => {
    const order: string[] = []
    const a = fake('a', pending('first thing'))
    const b = fake('b', pending('second thing'))
    a.run.mockImplementation(async () => { order.push('a'); return 'ok' })
    b.run.mockImplementation(async () => { order.push('b'); return 'ok' })

    await cmdMigrate([a, fake('skip', { state: 'none' }), b])

    expect(order).toEqual(['a', 'b'])
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
    const out = output.join('\n')
    expect(out).toContain('first thing')
    expect(out).toContain('second thing')
    expect(out).not.toContain('skip')
  })

  it('asks once in a terminal, and runs nothing when the answer is no', async () => {
    mockInteractive.mockReturnValue(true)
    mockConfirm.mockResolvedValue(false)
    const a = fake('a', pending())
    const b = fake('b', pending())

    await cmdMigrate([a, b])

    expect(mockConfirm).toHaveBeenCalledTimes(1)
    expect(a.run).not.toHaveBeenCalled()
    expect(b.run).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('runs them all on a yes', async () => {
    mockInteractive.mockReturnValue(true)
    mockConfirm.mockResolvedValue(true)
    const a = fake('a', pending())
    const b = fake('b', pending())

    await cmdMigrate([a, b])

    expect(a.run).toHaveBeenCalled()
    expect(b.run).toHaveBeenCalled()
  })

  it('stops at the first failure with exit 1 and names what did not run', async () => {
    const a = fake('a', pending(), 'failed')
    const b = fake('b', pending())

    await expect(cmdMigrate([a, b])).rejects.toThrow('process.exit')

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(b.run).not.toHaveBeenCalled()
    expect(output.join('\n')).toContain('Not run: b')
  })

  it('stops with exit 0 when a step is backed out of', async () => {
    const a = fake('a', pending(), 'cancelled')
    const b = fake('b', pending())

    await cmdMigrate([a, b])

    expect(exitSpy).not.toHaveBeenCalled()
    expect(b.run).not.toHaveBeenCalled()
    expect(output.join('\n')).toContain('Not run: b')
  })

  it('reports a blocked migration without running it or failing', async () => {
    // A migration that would fail on every run cannot be fixed by running it; counting it would stop
    // the list on the same refusal forever.
    const blocked = fake('a', { state: 'blocked', reason: 'two directories' })
    const b = fake('b', pending())

    await cmdMigrate([blocked, b])

    expect(blocked.run).not.toHaveBeenCalled()
    expect(b.run).toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
    expect(output.join('\n')).toContain('two directories')
  })
})

describe('tapflow migrate — which migrations are due', () => {
  const dataDir = MIGRATIONS.find((m) => m.id === 'data-dir')!
  const netFilter = MIGRATIONS.find((m) => m.id === 'net-filter')!

  describe('data-dir', () => {
    let install: string
    beforeEach(() => {
      install = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-migrate-list-'))
      vi.stubEnv('TAPFLOW_HOME', install)
    })
    afterEach(() => {
      vi.unstubAllEnvs()
      fs.rmSync(install, { recursive: true, force: true })
    })

    it('is due when the install has a .tapflow-data with data in it', () => {
      fs.mkdirSync(path.join(install, '.tapflow-data'))
      fs.writeFileSync(path.join(install, '.tapflow-data', 'tapflow.db'), 'DB')

      expect(dataDir.check().state).toBe('pending')
    })

    it('is not due for a .tapflow-data holding only a jwt-secret', () => {
      // What an older CLI left wherever it ran — not an install's data.
      fs.mkdirSync(path.join(install, '.tapflow-data'))
      fs.writeFileSync(path.join(install, '.tapflow-data', 'jwt-secret'), 'x')

      expect(dataDir.check().state).toBe('none')
    })

    it('is not due when there is no .tapflow-data', () => {
      expect(dataDir.check().state).toBe('none')
    })

    it('is blocked, not due, when .tapflow/data exists beside it', () => {
      fs.mkdirSync(path.join(install, '.tapflow-data'))
      fs.writeFileSync(path.join(install, '.tapflow-data', 'tapflow.db'), 'DB')
      fs.mkdirSync(path.join(install, '.tapflow', 'data'), { recursive: true })

      expect(dataDir.check().state).toBe('blocked')
    })
  })

  describe('net-filter', () => {
    const CURRENT: NetFilterState = { shippedHost: '200', installedHost: '200', shippedExt: '20', activatedExt: '20' }
    let platform: PropertyDescriptor

    beforeEach(() => {
      vi.clearAllMocks()
      platform = Object.getOwnPropertyDescriptor(process, 'platform')!
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockEnforcing.mockReturnValue(true)
    })
    afterEach(() => { Object.defineProperty(process, 'platform', platform) })

    it('is not due when the filter was never installed — it is optional', () => {
      mockState.mockReturnValue({ ...CURRENT, installedHost: null, activatedExt: null })

      expect(netFilter.check().state).toBe('none')
    })

    it('is due when the installed filter is older than this package', () => {
      mockState.mockReturnValue({ ...CURRENT, installedHost: '100', activatedExt: '10' })

      expect(netFilter.check()).toEqual({ state: 'pending', summary: expect.stringContaining('100 → 200') })
    })

    it('is due when the filter is current but not filtering', () => {
      mockState.mockReturnValue(CURRENT)
      mockEnforcing.mockReturnValue(false)

      expect(netFilter.check().state).toBe('pending')
    })

    it('is not due when the filter is current and filtering', () => {
      mockState.mockReturnValue(CURRENT)

      expect(netFilter.check().state).toBe('none')
    })

    it('is not due when the installed filter is newer — the installer would refuse the downgrade', () => {
      mockState.mockReturnValue({ ...CURRENT, installedHost: '300' })

      expect(netFilter.check().state).toBe('none')
    })

    it('is not due when the activated extension is newer than this package', () => {
      mockState.mockReturnValue({ ...CURRENT, installedHost: '100', activatedExt: '30' })

      expect(netFilter.check().state).toBe('none')
    })

    it('is not due when this package carries no filter', () => {
      mockState.mockReturnValue({ ...CURRENT, shippedHost: null, shippedExt: null })

      expect(netFilter.check().state).toBe('none')
    })

    it('is blocked, not up to date, when the app is gone but its extension still runs', () => {
      // The installer refuses this state (`refused-host-unknown`); calling it "up to date" would hide it.
      mockState.mockReturnValue({ ...CURRENT, installedHost: null })

      expect(netFilter.check().state).toBe('blocked')
    })

    it('is not due when this package ships an app whose extension cannot be read', () => {
      // The installer answers `no-artifact` here, so offering it would promise a step that fails.
      mockState.mockReturnValue({ ...CURRENT, installedHost: '100', shippedExt: null })

      expect(netFilter.check().state).toBe('none')
    })

    it('says activate, not update, when only the extension is behind', () => {
      mockState.mockReturnValue({ ...CURRENT, activatedExt: '10' })

      expect(netFilter.check()).toEqual({ state: 'pending', summary: expect.stringContaining('Activate') })
    })

    it('does not look at the filter at all off macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })

      expect(netFilter.check().state).toBe('none')
      expect(mockState).not.toHaveBeenCalled()
    })
  })
})
