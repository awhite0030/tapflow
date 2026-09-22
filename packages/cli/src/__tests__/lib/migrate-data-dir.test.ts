import fs from 'fs'
import path from 'path'
import os from 'os'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { probeBind } from '../../../src/lib/port-available.js'
import { migrateDataDir } from '../../../src/lib/migrate-data-dir.js'

vi.mock('../../../src/lib/port-available.js', () => ({
  probeBind: vi.fn().mockResolvedValue(null),
}))

const cwds: string[] = []

function makeCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-migrate-'))
}

function track(cwd: string) {
  cwds.push(cwd)
  return cwd
}

describe('migrateDataDir', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    for (const d of cwds.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('레거시만 존재 → .tapflow/data로 이동, 내용 보존', async () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data', 'uploads'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.tapflow-data', 'tapflow.db'), 'DB')
    fs.writeFileSync(path.join(cwd, '.tapflow-data', 'uploads', 'a.apk'), 'BIN')

    const result = await migrateDataDir(cwd)

    expect(result.status).toBe('migrated')
    expect(fs.existsSync(path.join(cwd, '.tapflow-data'))).toBe(false)
    expect(fs.readFileSync(path.join(cwd, '.tapflow', 'data', 'tapflow.db'), 'utf-8')).toBe('DB')
    expect(fs.readFileSync(path.join(cwd, '.tapflow', 'data', 'uploads', 'a.apk'), 'utf-8')).toBe('BIN')
  })

  it('config.json이 옛 기본값을 고정 → .tapflow/data로 재작성', async () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, 'tapflow.config.json'),
      JSON.stringify({ local: { port: 4000, dataDir: '.tapflow-data' }, relay: { url: '' } }, null, 2) + '\n',
    )

    const result = await migrateDataDir(cwd)

    expect(result).toMatchObject({ status: 'migrated', configUpdated: true })
    const config = JSON.parse(fs.readFileSync(path.join(cwd, 'tapflow.config.json'), 'utf-8'))
    expect(config.local.dataDir).toBe('.tapflow/data')
  })

  it('config.json이 커스텀 dataDir → 건드리지 않음', async () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, 'tapflow.config.json'),
      JSON.stringify({ local: { port: 4000, dataDir: '/custom/path' } }, null, 2) + '\n',
    )

    const result = await migrateDataDir(cwd)

    expect(result).toMatchObject({ status: 'migrated', configUpdated: false })
    const config = JSON.parse(fs.readFileSync(path.join(cwd, 'tapflow.config.json'), 'utf-8'))
    expect(config.local.dataDir).toBe('/custom/path')
  })

  it('이동 시 기존 .gitignore에 런타임 경로 추가(secrets 보호)', async () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.gitignore'), 'node_modules\n', 'utf-8')

    await migrateDataDir(cwd)

    const gitignore = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf-8')
    expect(gitignore).toBe('node_modules\n.tapflow/data/\n.tapflow/artifacts/\n')
  })

  it('.gitignore 없고 git repo → 생성해서 secrets 보호', async () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.git'), { recursive: true })
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })

    await migrateDataDir(cwd)

    const gitignore = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('.tapflow/data/\n')
  })

  it('.gitignore 없고 git repo 아님 → 생성 안 함', async () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })

    await migrateDataDir(cwd)

    expect(fs.existsSync(path.join(cwd, '.gitignore'))).toBe(false)
  })

  it('.gitignore가 이미 **/ glob으로 커버 → 중복 추가 안 함', async () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.gitignore'), '**/.tapflow/data/\n', 'utf-8')

    await migrateDataDir(cwd)

    const gitignore = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf-8')
    // artifacts는 추가되지만 data는 중복 추가 안 됨
    expect(gitignore).toBe('**/.tapflow/data/\n.tapflow/artifacts/\n')
  })

  it('레거시 없음 + 통합 경로 있음 → noop-already (멱등)', async () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow', 'data'), { recursive: true })
    expect((await migrateDataDir(cwd)).status).toBe('noop-already')
  })

  it('둘 다 없음 → noop-no-legacy', async () => {
    const cwd = track(makeCwd())
    expect((await migrateDataDir(cwd)).status).toBe('noop-no-legacy')
  })

  it('레거시·통합 둘 다 존재 → conflict, 데이터 무손상', async () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.tapflow-data', 'tapflow.db'), 'LEGACY')
    fs.mkdirSync(path.join(cwd, '.tapflow', 'data'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.tapflow', 'data', 'tapflow.db'), 'NEW')

    const result = await migrateDataDir(cwd)

    expect(result.status).toBe('conflict')
    expect(fs.readFileSync(path.join(cwd, '.tapflow-data', 'tapflow.db'), 'utf-8')).toBe('LEGACY')
    expect(fs.readFileSync(path.join(cwd, '.tapflow', 'data', 'tapflow.db'), 'utf-8')).toBe('NEW')
  })

  it('rename가 EXDEV → exdev 상태, 레거시 원위치(수동 이동 안내)', async () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.tapflow-data', 'tapflow.db'), 'DB')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      const e = new Error('cross-device link not permitted') as NodeJS.ErrnoException
      e.code = 'EXDEV'
      throw e
    })

    const result = await migrateDataDir(cwd)

    expect(result.status).toBe('exdev')
    expect(fs.readFileSync(path.join(cwd, '.tapflow-data', 'tapflow.db'), 'utf-8')).toBe('DB')
  })

  it('returns relay-running if probeBind fails with EADDRINUSE', async () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data', 'uploads'), { recursive: true })

    // Using vi.mocked since we imported probeBind
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(probeBind).mockResolvedValueOnce({ code: 'EADDRINUSE' } as any)

    const result = await migrateDataDir(cwd)
    expect(result.status).toBe('relay-running')
    expect(fs.existsSync(path.join(cwd, '.tapflow-data'))).toBe(true)
  })

  it('reverts rename if repointConfig throws', async () => {
    const cwd = track(makeCwd())
    fs.mkdirSync(path.join(cwd, '.tapflow-data'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'tapflow.config.json'), JSON.stringify({ local: { dataDir: '.tapflow-data' } }) + '\n')

    vi.spyOn(fs, 'writeFileSync').mockImplementation((p) => {
      if (p.toString().endsWith('tapflow.config.json')) throw new Error('EACCES')
    })

    await expect(migrateDataDir(cwd)).rejects.toThrow('EACCES')

    expect(fs.existsSync(path.join(cwd, '.tapflow', 'data'))).toBe(false)
    expect(fs.existsSync(path.join(cwd, '.tapflow-data'))).toBe(true)
  })
})
