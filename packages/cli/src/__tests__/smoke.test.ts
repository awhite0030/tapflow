import { describe, it, expect } from 'vitest'
import { spawnSync, spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(__dirname, '../..')
const entry = path.resolve(__dirname, '../index.ts')
const tsx = path.resolve(pkgRoot, 'node_modules/.bin/tsx')

function run(...args: string[]) {
  return spawnSync(tsx, [entry, ...args], { encoding: 'utf-8', cwd: pkgRoot })
}

describe('CLI smoke tests', () => {
  it('tapflow --version → semver 출력, exit 0', () => {
    const { stdout, status } = run('--version')
    expect(status).toBe(0)
    expect(stdout).toMatch(/\d+\.\d+\.\d+/)
  })

  it('tapflow --help → 사용법 출력, exit 0', () => {
    const { stdout, status } = run('--help')
    expect(status).toBe(0)
    expect(stdout).toContain('tapflow')
    expect(stdout).toContain('--help')
  })

  it('tapflow relay start → 배너 출력 후 대기 (즉시 종료하지 않음)', () => {
    return new Promise<void>((resolve, reject) => {
      const dataDir = path.join(os.tmpdir(), `tapflow-smoke-${Date.now()}`)
      const proc = spawn(tsx, [entry, 'relay', 'start', '--port', '14321'], {
        cwd: pkgRoot,
        env: { ...process.env, TAPFLOW_DATA_DIR: dataDir },
      })

      const startedAt = Date.now()
      let stdout = ''
      let stderr = ''
      let listening = false
      let settled = false
      let deadline: ReturnType<typeof setTimeout>
      let grace: ReturnType<typeof setTimeout>

      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        clearTimeout(grace)
        proc.kill()
        if (err) reject(err)
        else resolve()
      }

      // Wait for the readiness line: a cold tsx start can outlast any fixed window on CI.
      proc.stdout.on('data', (d: Buffer) => {
        stdout += d.toString()
        if (listening || !stdout.includes('localhost:14321')) return
        listening = true
        // Keep the ~2s of liveness the fixed window used to observe, floored at 500ms.
        grace = setTimeout(finish, Math.max(500, 2_000 - (Date.now() - startedAt)))
      })
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

      // 즉시 종료하면 실패 (a signal kill reports code === null, so check both)
      proc.on('exit', (code, signal) => {
        if (code !== null || signal !== null) {
          finish(new Error(`relay start exited early (code ${code}, signal ${signal})\n${stderr}`))
        }
      })

      deadline = setTimeout(() => {
        finish(new Error(`relay start never reported listening within 15s\nstdout: ${stdout}\nstderr: ${stderr}`))
      }, 15_000)
    })
  }, 20_000)
})
