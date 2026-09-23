import fs from 'fs'
import path from 'path'

// Local (not imported from @tapflowio/relay, whose import runs a config-load side effect) so this stays a pure fs op; mirrors relay's lib/dataDir.ts.
const LEGACY_DATA_DIR = '.tapflow-data'
const UNIFIED_DATA_DIR = path.join('.tapflow', 'data')
// config.json stores dataDir with a forward slash regardless of platform (it is a portable config value).
const UNIFIED_CONFIG_VALUE = '.tapflow/data'

export type MigrateDataDirResult =
  | { status: 'migrated'; from: string; to: string; configUpdated: boolean; gitignoreUpdated: boolean }
  | { status: 'noop-no-legacy' } // nothing to migrate
  | { status: 'noop-already' } // legacy gone, unified dir present
  | { status: 'conflict'; legacy: string; target: string } // both exist — needs manual reconciliation
  | { status: 'exdev'; from: string; to: string; configPath: string; configRestored: boolean } // cross-filesystem — needs a manual move
  // The config pins the old path and could not be rewritten. Checked first, so nothing has moved.
  | { status: 'config-unwritable'; configPath: string; detail: string }
  // The move itself failed for another reason (Windows' open handles, permissions). Nothing moved.
  | { status: 'rename-failed'; from: string; to: string; detail: string; configPath: string; configRestored: boolean }

// One-shot atomic-rename move of legacy .tapflow-data/ → .tapflow/data/, also repointing config.json and .gitignore. Idempotent; never destroys data.
export function migrateDataDir(cwd: string): MigrateDataDirResult {
  const legacy = path.join(cwd, LEGACY_DATA_DIR)
  const target = path.join(cwd, UNIFIED_DATA_DIR)
  const legacyExists = fs.existsSync(legacy)
  const targetExists = fs.existsSync(target)

  if (!legacyExists) return { status: targetExists ? 'noop-already' : 'noop-no-legacy' }
  if (targetExists) return { status: 'conflict', legacy, target }

  // **The config is rewritten before the move, and put back if the move fails.** It used to be the
  // other way round, with the write unguarded: a config that could not be written left the data moved
  // and the config still naming the old path, with a stack trace as the only report — and the next
  // start created an empty `.tapflow-data/` there. Written first, a config that cannot be written stops
  // the command before anything has moved.
  const configPath = path.join(cwd, 'tapflow.config.json')
  let repointed: { original: string } | null
  try {
    repointed = repointConfig(configPath)
  } catch (err) {
    return { status: 'config-unwritable', configPath, detail: err instanceof Error ? err.message : String(err) }
  }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(legacy, target) // atomic within a filesystem
  } catch (err) {
    const configRestored = repointed === null || restoreConfig(configPath, repointed.original)
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      return { status: 'exdev', from: legacy, to: target, configPath, configRestored }
    }
    return {
      status: 'rename-failed', from: legacy, to: target, configPath, configRestored,
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  const gitignoreUpdated = ensureGitignore(cwd)
  return { status: 'migrated', from: legacy, to: target, configUpdated: repointed !== null, gitignoreUpdated }
}

// Rewrite config.json local.dataDir only when it pins the OLD default (.tapflow-data); a custom path is the user's choice and left untouched.
// Returns the bytes it replaced, so a failed move can put them back; null when nothing was rewritten.
// A write that fails throws — the caller stops before anything moves.
function repointConfig(configPath: string): { original: string } | null {
  let raw: string
  try {
    raw = fs.readFileSync(configPath, 'utf-8')
  } catch {
    return null
  }
  let cfg: { local?: { dataDir?: unknown } }
  try {
    cfg = JSON.parse(raw)
  } catch {
    return null
  }
  if (cfg.local?.dataDir !== LEGACY_DATA_DIR) return null
  cfg.local.dataDir = UNIFIED_CONFIG_VALUE
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf-8')
  return { original: raw }
}

function restoreConfig(configPath: string, original: string): boolean {
  try {
    fs.writeFileSync(configPath, original, 'utf-8')
    return true
  } catch {
    return false
  }
}

// Best-effort: keep moved secrets (.env, jwt-secret) out of git — append the runtime paths to an existing .gitignore, or create one inside a git repo.
function ensureGitignore(cwd: string): boolean {
  const gitignorePath = path.join(cwd, '.gitignore')
  const entries = ['.tapflow/data/', '.tapflow/artifacts/']
  let content: string
  try {
    content = fs.readFileSync(gitignorePath, 'utf-8')
  } catch {
    if (!isInsideGitRepo(cwd)) return false // not a git repo → nothing tracked here to protect
    try {
      fs.writeFileSync(gitignorePath, `# tapflow runtime data\n${entries.join('\n')}\n`, 'utf-8')
      return true
    } catch {
      return false
    }
  }
  const present = new Set(content.split('\n').map((l) => l.trim()))
  // Treat a `**/`-prefixed glob (how the monorepo root ignores these) as already covering the entry.
  const needed = entries.filter((e) => !present.has(e) && !present.has(`**/${e}`))
  if (needed.length === 0) return false
  try {
    const separator = content.endsWith('\n') || content === '' ? '' : '\n'
    fs.appendFileSync(gitignorePath, `${separator}${needed.join('\n')}\n`, 'utf-8')
    return true
  } catch {
    return false
  }
}

function isInsideGitRepo(dir: string): boolean {
  let current = dir
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return true
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}
