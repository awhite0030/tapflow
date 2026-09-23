import fs from 'fs'
import os from 'os'
import path from 'path'

export const LEGACY_DATA_DIR = '.tapflow-data'
export const UNIFIED_DATA_DIR = path.join('.tapflow', 'data')
// The layout of an install dir tapflow owns: config and data side by side, nothing wrapped.
// `.tapflow/data` wraps because it dates from when tapflow lived inside the user's own folder.
export const OWN_DATA_DIR = 'data'
export const CONFIG_FILE = 'tapflow.config.json'
export const DEFAULT_INSTALL_DIR_NAME = '.tapflow'

export interface DefaultDataDir {
  dataDir: string
  // true → resolved to the legacy .tapflow-data/ as a read-only fallback (run `tapflow migrate data-dir`)
  usingLegacy: boolean
  // true → an existing data dir was found; false → `fallback` was chosen for an install that has none yet
  existing: boolean
}

/**
 * Whether `dir` holds an install's data. An empty dir counts — the Docker image and the systemd
 * docs create one before the relay first starts. A dir whose only entry is `jwt-secret` does not:
 * every CLI command up to this change wrote one wherever it ran, because the relay config created
 * it at import, and the relay itself always creates `tapflow.db` on boot. So a dir holding the
 * secret alone is one no relay ever ran in, and treating it as an install made an app repo that
 * had once run `tapflow flow run` look like one.
 */
export function holdsInstallData(dir: string): boolean {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return false
  }
  const real = entries.filter((e) => e !== '.DS_Store')
  return !(real.length === 1 && real[0] === 'jwt-secret')
}

// Read-only resolution of an install's data dir when nothing names one. The relay never MOVES
// anything — that is the job of `tapflow migrate data-dir`. Existing layouts come first, so an
// install that has data keeps it: `.tapflow/data`, then the legacy `.tapflow-data`, and only then
// `fallback`. The existing ones win over a new-layout `data/` because an install living inside an
// app repo can have an unrelated `data/` of the app's own. The caller warns when usingLegacy is true.
export function resolveDefaultDataDir(installDir: string, fallback: string = UNIFIED_DATA_DIR): DefaultDataDir {
  const unified = path.join(installDir, UNIFIED_DATA_DIR)
  if (holdsInstallData(unified)) return { dataDir: unified, usingLegacy: false, existing: true }
  const legacy = path.join(installDir, LEGACY_DATA_DIR)
  if (holdsInstallData(legacy)) return { dataDir: legacy, usingLegacy: true, existing: true }
  return { dataDir: path.join(installDir, fallback), usingLegacy: false, existing: false }
}

export type InstallReason = 'TAPFLOW_HOME' | 'config in the current directory' | 'data in the current directory' | 'default'

export interface InstallDir {
  dir: string
  reason: InstallReason
  configPath: string
  // The data layout used when the install holds no data dir yet (see resolveDefaultDataDir).
  defaultDataLayout: string
  // TAPFLOW_HOME names a directory that does not exist. Only a command that runs the relay refuses
  // it (assertInstallDir) — deciding at import would stop `setup` and `init` too.
  missing: boolean
  // Files of an older install this choice hides, for a warning.
  shadowed: string[]
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * **Which directory is this machine's tapflow install.** Every command asks this and none takes a
 * path, so `init` writes where `start` reads:
 *
 * 1. `TAPFLOW_HOME`, when set and non-empty (relative values resolve against the cwd).
 * 2. The current directory, when it already is an install — it holds `tapflow.config.json`, or a
 *    `.tapflow/data` / `.tapflow-data` with install data in it. This is how installs from before the
 *    home existed keep running where they are, and how `pnpm dev` keeps its own.
 * 3. `~/.tapflow`.
 *
 * A permanent rule, like npm's project `.npmrc` before the user one — not a migration path.
 *
 * Two cases around the home directory, both found in design review:
 * - At `~`, `~/.tapflow/data` is the default install's own data, so it is not a signal there. And
 *   once `~/.tapflow/tapflow.config.json` exists, `~` is never an install: an older install at `~`
 *   would otherwise serve the new install's data under the old config.
 * - An install at `~/.tapflow` with no config of its own reads `~/tapflow.config.json`, which is
 *   where `tapflow init` run from a new terminal used to write it. Without that, starting it from
 *   anywhere but `~` served the same database and secret with its TLS, tunnel and SMTP gone.
 */
export function resolveInstallDir(
  { env = process.env, cwd = process.cwd(), home = os.homedir() }: { env?: NodeJS.ProcessEnv; cwd?: string; home?: string } = {},
): InstallDir {
  const defaultDir = path.join(home, DEFAULT_INSTALL_DIR_NAME)
  let reason: InstallReason = 'default'
  let shadowed: string[] = []

  if (env.TAPFLOW_HOME) {
    const dir = path.resolve(cwd, env.TAPFLOW_HOME)
    if (realpathOr(dir) !== realpathOr(defaultDir)) {
      return {
        dir, reason: 'TAPFLOW_HOME', configPath: path.join(dir, CONFIG_FILE),
        defaultDataLayout: OWN_DATA_DIR, missing: !fs.existsSync(dir), shadowed,
      }
    }
    reason = 'TAPFLOW_HOME'
  } else {
    const atHome = realpathOr(cwd) === realpathOr(home)
    const homeInstallConfigured = atHome && fs.existsSync(path.join(defaultDir, CONFIG_FILE))
    if (homeInstallConfigured) {
      shadowed = [path.join(home, CONFIG_FILE)].filter((p) => fs.existsSync(p))
      if (holdsInstallData(path.join(home, LEGACY_DATA_DIR))) shadowed.push(path.join(home, LEGACY_DATA_DIR))
    } else {
      const inCwd = (why: InstallReason): InstallDir => ({
        dir: cwd, reason: why, configPath: path.join(cwd, CONFIG_FILE),
        // An install in its own folder from before the home existed: keep its layout.
        defaultDataLayout: UNIFIED_DATA_DIR, missing: false, shadowed: [],
      })
      if (fs.existsSync(path.join(cwd, CONFIG_FILE))) return inCwd('config in the current directory')
      if (!atHome && holdsInstallData(path.join(cwd, UNIFIED_DATA_DIR))) return inCwd('data in the current directory')
      if (holdsInstallData(path.join(cwd, LEGACY_DATA_DIR))) return inCwd('data in the current directory')
    }
  }

  let configPath = path.join(defaultDir, CONFIG_FILE)
  const homeConfig = path.join(home, CONFIG_FILE)
  if (!fs.existsSync(configPath) && fs.existsSync(homeConfig)) configPath = homeConfig
  return { dir: defaultDir, reason, configPath, defaultDataLayout: OWN_DATA_DIR, missing: false, shadowed }
}
