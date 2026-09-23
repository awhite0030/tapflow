import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * **The block `tapflow init` writes into the install dir's AGENTS.md**, so the operator's coding
 * agent answers tapflow questions from the docs instead of its training data.
 *
 * It holds pointers and nothing else. The block itself only changes when `init` runs again, while
 * the docs it points at are rebuilt from source on every merge — so a command list or a config key
 * written here would be the one part that goes stale, and it is loaded into every session the
 * operator starts in this directory, where length costs them tokens.
 */
export const MARKER_BEGIN = '<!-- tapflow:begin -->'
export const MARKER_END = '<!-- tapflow:end -->'

export const AGENTS_BLOCK = `${MARKER_BEGIN}
## tapflow (managed by \`tapflow init\`)

This directory is a [tapflow](https://www.tapflow.dev) install — the self-hosted relay that puts iOS
simulators and Android emulators in a browser for the whole team. \`tapflow.config.json\` here is its
configuration, and the data directory beside it holds the database, uploads and secrets.

**Answer tapflow questions from the docs, not from memory.** Fetch
https://www.tapflow.dev/llms.txt, pick the page it lists, and read that page by adding \`.md\` to its
URL (for example https://www.tapflow.dev/reference/cli.md). Say so when the docs do not cover
something, rather than guessing. https://www.tapflow.dev/llms-full.txt is every page in one file:
use it only when you can read a whole file, because a tool that truncates a large fetch loses the
reference pages, which are at the end.

**The docs follow the latest source, so they can describe a release this machine does not have.**
Compare \`tapflow --version\` with
https://raw.githubusercontent.com/jo-duchan/tapflow/main/CHANGELOG.md, newest first — anything under
\`[Unreleased]\` has not shipped.

**Look at the running install with \`tapflow doctor\`, \`tapflow status\` and \`tapflow logs\`.**

**Never read, print or commit this install's secrets.** \`jwt-secret\` and \`.env\` live in the data
directory — \`data/\`, or \`.tapflow/data/\` or \`.tapflow-data/\` on an older install, or wherever
\`local.dataDir\` or \`TAPFLOW_DATA_DIR\` points. \`smtp.pass\` in \`tapflow.config.json\` is one too.
${MARKER_END}
`

export const CLAUDE_IMPORT = '@AGENTS.md\n'

/** Everything tapflow itself puts in an install dir, plus what an operator's agent leaves there. */
const TAPFLOW_OWNED_ENTRIES = new Set([
  'tapflow.config.json', 'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', '.claude', 'litestream.yml',
  '.gitignore', 'data', '.tapflow', '.tapflow-data', 'bin', 'wda', '.DS_Store',
])

export type AgentsResult = 'created' | 'appended' | 'updated' | 'unchanged' | 'malformed'

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Put `block` into `existing`, touching nothing outside the markers.
 *
 * Broken markers leave the file alone: a pair in the wrong order, a second `begin`, or one half on
 * its own is a file someone edited by hand, and appending to it would make the damage permanent —
 * the next run would find the same mess and append again.
 */
export function upsertBlock(existing: string | null, block: string): { result: AgentsResult; content: string } {
  if (existing === null) return { result: 'created', content: block }

  const begins = existing.split(MARKER_BEGIN).length - 1
  const ends = existing.split(MARKER_END).length - 1
  if (begins > 1 || ends > 1 || begins !== ends) return { result: 'malformed', content: existing }
  if (begins === 1 && existing.indexOf(MARKER_BEGIN) > existing.indexOf(MARKER_END)) {
    return { result: 'malformed', content: existing }
  }

  if (begins === 1) {
    const start = existing.indexOf(MARKER_BEGIN)
    const end = existing.indexOf(MARKER_END) + MARKER_END.length
    // Sliced rather than `String.replace`: a `$&` or `` $` `` anywhere in the block is a
    // substitution pattern to `replace`, which would mangle it on the way in.
    const content = existing.slice(0, start) + block.trimEnd() + existing.slice(end)
    return { result: content === existing ? 'unchanged' : 'updated', content }
  }

  if (existing.trim() === '') return { result: 'created', content: block }
  return { result: 'appended', content: `${existing.trimEnd()}\n\n${block}` }
}

/**
 * Whether a CLAUDE.md pulls in the AGENTS.md beside it. Claude Code skips `@` paths inside code
 * spans and fenced code blocks, so a file that only mentions the import in an example does not have
 * one — and that file is exactly what an operator would write after being told about the import.
 */
export function importsAgentsMd(text: string): boolean {
  const prose = text
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/^~~~[\s\S]*?^~~~/gm, '')
    .replace(/`[^`\n]*`/g, '')
  return /(?:^|\s)@(?:\.\/)?AGENTS\.md(?=\s|$)/m.test(prose)
}

/**
 * The CLAUDE.md files that stop Claude Code reading an AGENTS.md here: any of the three names in
 * this directory or above it. `~/.claude/CLAUDE.md` is the user's own and does not count.
 */
export function claudeMdOnPath(dir: string, home = os.homedir()): string[] {
  const found: string[] = []
  let current = path.resolve(dir)
  const userLevel = path.join(realpathOr(home), '.claude', 'CLAUDE.md')
  while (true) {
    for (const name of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      const candidate = path.join(current, name)
      if (fs.existsSync(candidate) && realpathOr(candidate) !== userLevel) found.push(candidate)
    }
    const parent = path.dirname(current)
    if (parent === current) return found
    current = parent
  }
}

/**
 * Whether this directory is tapflow's own. `~/.tapflow` always is, and so is a directory holding
 * nothing but what tapflow and an agent working here put there.
 *
 * It decides one thing: whether to write a CLAUDE.md. In a directory that is also something else —
 * an app repo an older install lives in — that file would switch Claude Code to reading CLAUDE.md
 * files only, and the repo's other AGENTS.md files would stop loading.
 */
export function isTapflowOwned(dir: string, home = os.homedir()): boolean {
  if (realpathOr(dir) === realpathOr(path.join(home, '.tapflow'))) return true
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return true // not there yet: `init` is about to create it
  }
  return entries.every((e) => TAPFLOW_OWNED_ENTRIES.has(e))
}

export interface AgentDocsReport {
  agents: AgentsResult | 'skipped'
  claude: 'created' | 'present' | 'skipped'
  notes: string[]
}

/**
 * Write the block into `<dir>/AGENTS.md`, and a `CLAUDE.md` that imports it when the directory is
 * tapflow's own.
 *
 * Nothing is written to the home directory itself: an `~/AGENTS.md` loads into every session
 * started anywhere below it.
 */
export function scaffoldAgentDocs(dir: string, home = os.homedir()): AgentDocsReport {
  const notes: string[] = []
  if (realpathOr(dir) === realpathOr(home)) {
    return {
      agents: 'skipped',
      claude: 'skipped',
      notes: [`Skipped AGENTS.md: ${dir} is your home directory, and an AGENTS.md there loads in every session below it.`],
    }
  }

  const agentsPath = path.join(dir, 'AGENTS.md')
  let existing: string | null = null
  try {
    existing = fs.readFileSync(agentsPath, 'utf-8')
  } catch {
    existing = null
  }
  const { result, content } = upsertBlock(existing, AGENTS_BLOCK)
  if (result === 'malformed') {
    notes.push(`Left ${agentsPath} alone: its tapflow markers are damaged. Fix or remove them, then run tapflow init again.`)
  } else if (result !== 'unchanged') {
    // In place, never a temp file and a rename: that would turn a symlinked AGENTS.md into a copy.
    fs.writeFileSync(agentsPath, content, 'utf-8')
  }

  const claudePath = path.join(dir, 'CLAUDE.md')
  const owned = isTapflowOwned(dir, home)
  let claude: AgentDocsReport['claude'] = 'skipped'
  if (fs.existsSync(claudePath)) {
    claude = 'present'
    const sameFile = realpathOr(claudePath) === realpathOr(agentsPath)
    if (!sameFile && !importsAgentsMd(fs.readFileSync(claudePath, 'utf-8'))) {
      notes.push(`Add \`@AGENTS.md\` to ${claudePath} — Claude Code reads CLAUDE.md instead of AGENTS.md where one exists.`)
    }
  } else if (owned) {
    fs.writeFileSync(claudePath, CLAUDE_IMPORT, 'utf-8')
    claude = 'created'
  } else if (claudeMdOnPath(dir, home).length > 0) {
    notes.push(`Add a CLAUDE.md here containing \`@AGENTS.md\` — a CLAUDE.md above this directory stops Claude Code reading AGENTS.md.`)
  }

  return { agents: result, claude, notes }
}
