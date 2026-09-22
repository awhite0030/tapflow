import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveInstallDir, resolveDefaultDataDir, holdsInstallData, CONFIG_FILE } from '../lib/dataDir.js'

/**
 * **The install dir rule, against real directories.** Every case here is a shape someone already
 * has on disk — an install in its own folder, a Docker image's empty volume mount, an install
 * `tapflow init` wrote to `~` before the home existed — so the resolution is exercised the way the
 * relay meets it, with `env`, `cwd` and `home` passed in rather than mocked globally.
 */

const dirs: string[] = []
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-install-'))
  dirs.push(d)
  return fs.realpathSync(d)
}
const write = (file: string, body = '{}'): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  return file
}
const dir = (p: string): string => {
  fs.mkdirSync(p, { recursive: true })
  return p
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('holdsInstallData', () => {
  it('counts an empty dir — Docker and the systemd docs create it before the first boot', () => {
    expect(holdsInstallData(dir(path.join(tmp(), '.tapflow', 'data')))).toBe(true)
  })

  it('counts a dir with a database', () => {
    const d = dir(path.join(tmp(), '.tapflow', 'data'))
    write(path.join(d, 'tapflow.db'), 'DB')
    expect(holdsInstallData(d)).toBe(true)
  })

  it('does not count a dir holding only the jwt-secret an older CLI dropped', () => {
    const d = dir(path.join(tmp(), '.tapflow', 'data'))
    write(path.join(d, 'jwt-secret'), 'x'.repeat(48))
    write(path.join(d, '.DS_Store'), '')
    expect(holdsInstallData(d)).toBe(false)
  })

  it('does not count a dir that is not there', () => {
    expect(holdsInstallData(path.join(tmp(), 'nothing'))).toBe(false)
  })
})

describe('resolveInstallDir', () => {
  it('defaults to ~/.tapflow when nothing else says otherwise', () => {
    const home = tmp()
    const install = resolveInstallDir({ env: {}, cwd: tmp(), home })
    expect(install).toMatchObject({
      dir: path.join(home, '.tapflow'),
      reason: 'default',
      configPath: path.join(home, '.tapflow', CONFIG_FILE),
      missing: false,
    })
  })

  it('takes the current directory when it holds a config', () => {
    const cwd = tmp()
    write(path.join(cwd, CONFIG_FILE))
    expect(resolveInstallDir({ env: {}, cwd, home: tmp() })).toMatchObject({
      dir: cwd,
      reason: 'config in the current directory',
    })
  })

  it('takes the current directory when it holds data — a Docker or systemd install has no config', () => {
    const cwd = tmp()
    dir(path.join(cwd, '.tapflow', 'data'))
    expect(resolveInstallDir({ env: {}, cwd, home: tmp() }).dir).toBe(cwd)
  })

  it('takes the current directory for a legacy .tapflow-data', () => {
    const cwd = tmp()
    write(path.join(cwd, '.tapflow-data', 'tapflow.db'), 'DB')
    expect(resolveInstallDir({ env: {}, cwd, home: tmp() }).dir).toBe(cwd)
  })

  it('ignores a data dir holding only a stray jwt-secret', () => {
    const cwd = tmp()
    const home = tmp()
    write(path.join(cwd, '.tapflow', 'data', 'jwt-secret'), 'x'.repeat(48))
    expect(resolveInstallDir({ env: {}, cwd, home }).dir).toBe(path.join(home, '.tapflow'))
  })

  it('lets TAPFLOW_HOME win over the current directory', () => {
    const cwd = tmp()
    const named = tmp()
    write(path.join(cwd, CONFIG_FILE))
    expect(resolveInstallDir({ env: { TAPFLOW_HOME: named }, cwd, home: tmp() })).toMatchObject({
      dir: named,
      reason: 'TAPFLOW_HOME',
      missing: false,
    })
  })

  it('treats an empty TAPFLOW_HOME as unset and a relative one as relative to the cwd', () => {
    const home = tmp()
    const cwd = tmp()
    expect(resolveInstallDir({ env: { TAPFLOW_HOME: '' }, cwd, home }).dir).toBe(path.join(home, '.tapflow'))
    expect(resolveInstallDir({ env: { TAPFLOW_HOME: '.' }, cwd, home }).dir).toBe(cwd)
  })

  it('reports a TAPFLOW_HOME that does not exist rather than failing here', () => {
    const named = path.join(tmp(), 'not-yet')
    const install = resolveInstallDir({ env: { TAPFLOW_HOME: named }, cwd: tmp(), home: tmp() })
    expect(install).toMatchObject({ dir: named, missing: true })
  })

  it('resolves TAPFLOW_HOME=~/.tapflow to the default install, config fallback included', () => {
    const home = tmp()
    const cwd = tmp()
    dir(path.join(home, '.tapflow'))
    write(path.join(home, CONFIG_FILE))
    const named = resolveInstallDir({ env: { TAPFLOW_HOME: path.join(home, '.tapflow') }, cwd, home })
    const plain = resolveInstallDir({ env: {}, cwd, home })
    expect(named.dir).toBe(plain.dir)
    expect(named.configPath).toBe(plain.configPath)
    expect(named.defaultDataLayout).toBe(plain.defaultDataLayout)
  })

  describe('at the home directory', () => {
    it('reads ~/tapflow.config.json for an install `init` wrote there', () => {
      const home = tmp()
      write(path.join(home, CONFIG_FILE))
      dir(path.join(home, '.tapflow', 'data'))
      expect(resolveInstallDir({ env: {}, cwd: home, home })).toMatchObject({
        dir: home,
        reason: 'config in the current directory',
      })
    })

    it('reads that config from any other directory too', () => {
      const home = tmp()
      write(path.join(home, CONFIG_FILE))
      dir(path.join(home, '.tapflow', 'data'))
      expect(resolveInstallDir({ env: {}, cwd: tmp(), home })).toMatchObject({
        dir: path.join(home, '.tapflow'),
        configPath: path.join(home, CONFIG_FILE),
      })
    })

    it('does not treat ~/.tapflow/data as data in the current directory', () => {
      // It is the default install's own data. Reading it as a signal would look for
      // ~/tapflow.config.json and serve that data with no config at all.
      const home = tmp()
      dir(path.join(home, '.tapflow', 'data'))
      expect(resolveInstallDir({ env: {}, cwd: home, home }).dir).toBe(path.join(home, '.tapflow'))
    })

    it('prefers a configured ~/.tapflow over an older install at ~, and says what it hides', () => {
      const home = tmp()
      write(path.join(home, '.tapflow', CONFIG_FILE))
      write(path.join(home, CONFIG_FILE))
      write(path.join(home, '.tapflow-data', 'tapflow.db'), 'DB')
      const install = resolveInstallDir({ env: {}, cwd: home, home })
      expect(install.dir).toBe(path.join(home, '.tapflow'))
      expect(install.configPath).toBe(path.join(home, '.tapflow', CONFIG_FILE))
      expect(install.shadowed).toEqual([path.join(home, CONFIG_FILE), path.join(home, '.tapflow-data')])
    })

    it('takes a legacy .tapflow-data at ~ while no ~/.tapflow config exists', () => {
      const home = tmp()
      write(path.join(home, '.tapflow-data', 'tapflow.db'), 'DB')
      expect(resolveInstallDir({ env: {}, cwd: home, home }).dir).toBe(home)
    })
  })

  it('matches the home through a symlink', () => {
    const real = tmp()
    const link = path.join(tmp(), 'home-link')
    fs.symlinkSync(real, link)
    dir(path.join(real, '.tapflow', 'data'))
    // cwd given as the link, home as the real path: the two must still count as the same place.
    expect(resolveInstallDir({ env: {}, cwd: link, home: real }).dir).toBe(path.join(real, '.tapflow'))
  })
})

describe('the data dir an install uses', () => {
  const dataOf = (install: { dir: string; defaultDataLayout: string }) =>
    resolveDefaultDataDir(install.dir, install.defaultDataLayout)

  it('is <install>/data for the default install', () => {
    const home = tmp()
    const install = resolveInstallDir({ env: {}, cwd: tmp(), home })
    expect(dataOf(install)).toEqual({
      dataDir: path.join(home, '.tapflow', 'data'),
      usingLegacy: false,
      existing: false,
    })
  })

  it('is <install>/data for a TAPFLOW_HOME install with no data yet', () => {
    const named = tmp()
    const install = resolveInstallDir({ env: { TAPFLOW_HOME: named }, cwd: tmp(), home: tmp() })
    expect(dataOf(install).dataDir).toBe(path.join(named, 'data'))
  })

  it('stays <install>/.tapflow/data for an install in its own folder', () => {
    // An app repo that ran `tapflow init` and never started the relay has no data dir at all. Its
    // .gitignore covers `.tapflow/data/`, so putting the secrets in a new `data/` risks committing them.
    const cwd = tmp()
    write(path.join(cwd, CONFIG_FILE))
    const install = resolveInstallDir({ env: {}, cwd, home: tmp() })
    expect(dataOf(install).dataDir).toBe(path.join(cwd, '.tapflow', 'data'))
  })

  it('keeps reading an existing .tapflow/data', () => {
    const named = tmp()
    write(path.join(named, '.tapflow', 'data', 'tapflow.db'), 'DB')
    const install = resolveInstallDir({ env: { TAPFLOW_HOME: named }, cwd: tmp(), home: tmp() })
    expect(dataOf(install)).toEqual({
      dataDir: path.join(named, '.tapflow', 'data'),
      usingLegacy: false,
      existing: true,
    })
  })

  it('keeps reading a legacy .tapflow-data and says so', () => {
    const named = tmp()
    write(path.join(named, '.tapflow-data', 'tapflow.db'), 'DB')
    const install = resolveInstallDir({ env: { TAPFLOW_HOME: named }, cwd: tmp(), home: tmp() })
    expect(dataOf(install)).toEqual({
      dataDir: path.join(named, '.tapflow-data'),
      usingLegacy: true,
      existing: true,
    })
  })

  it('prefers an existing tapflow layout over a `data/` of the app the install sits in', () => {
    const cwd = tmp()
    write(path.join(cwd, CONFIG_FILE))
    write(path.join(cwd, '.tapflow', 'data', 'tapflow.db'), 'DB')
    write(path.join(cwd, 'data', 'products.json'), '[]')
    const install = resolveInstallDir({ env: {}, cwd, home: tmp() })
    expect(dataOf(install).dataDir).toBe(path.join(cwd, '.tapflow', 'data'))
  })
})
