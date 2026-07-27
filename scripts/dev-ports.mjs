// Shared between dev-preflight and dev-down: the ports `pnpm dev` needs, and how to tell one of
// its processes apart from anything else on the machine.
//
// `dev-down` SIGKILLs what this module selects, so the selection is the dangerous part of the
// tool and is written to be provably narrow. Every rule below was derived from the real `ps`
// output of a running `pnpm dev` (see scripts/__tests__/devProcesses.test.mjs, whose fixtures
// are verbatim command lines) — an earlier version was written from memory and matched none of
// the three, while matching `grep`, `less` and sibling checkouts instead.
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, resolve, basename } from 'path'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Agent worktrees live under the repo. They are separate checkouts and are never ours to kill. */
const NESTED_CHECKOUTS = '/.claude/worktrees/'

export const RELAY_PORT = Number(process.env.PORT || 4000)   // `||`: PORT="" is not port 0
export const DASHBOARD_PORT = 3001
export const DEV_PORTS = [
  { port: RELAY_PORT, what: 'relay' },
  { port: DASHBOARD_PORT, what: 'dashboard (vite)' },
]

const isNode = (argv0) => basename(argv0 ?? '') === 'node'
const escapeRe = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Does this command line belong to a dev process of the checkout at `root`?
 *
 * Three independent conditions, all required:
 *  1. it is a node process — this alone excludes `grep`, `less`, `vim` and every other tool
 *     that merely mentions the repo or one of the patterns below;
 *  2. some argument is an absolute path inside `root` and outside any nested checkout — this
 *     excludes a sibling clone, and `<root>/.claude/worktrees/*`;
 *  3. it looks like one of the three roles `pnpm dev` starts.
 *
 * Exported for the tests; callers use `findDevProcesses`.
 */
export function isDevProcess(command, root = REPO_ROOT) {
  const argv = command.split(/\s+/).filter(Boolean)
  if (!isNode(argv[0])) return false

  // The path that establishes the ROLE must itself be the one inside the repo. Testing those two
  // things independently let `--root <repo>/packages` or `--cwd <repo>/x` supply the "in repo"
  // half while a foreign vite or a foreign script supplied the role — and `dev-down` SIGKILLs
  // what this returns.
  //
  // Matched against the raw command rather than a token, so a checkout path containing a space
  // still works: `root` is embedded literally and only the remainder is space-free.
  const under = (suffix) =>
    new RegExp(`${escapeRe(root)}/(?!${escapeRe(NESTED_CHECKOUTS.slice(1, -1))}/)\\S*${suffix}`)
      .test(command)

  // The tsx launcher, and the child it spawns — the child holds the relay port. The child names
  // its script relatively, so what anchors it to this checkout is the tsx loader path.
  const isTsxDev =
    argv.includes('--conditions=source') &&
    argv.some((a) => /(^|\/)(relay|ios-agent|android-agent|multi-agent)\.ts$/.test(a)) &&
    !argv.some((a) => a.startsWith('/') && /(relay|ios-agent|android-agent|multi-agent)\.ts$/.test(a)
      && !a.startsWith(`${root}/`)) &&
    under('tsx/[^\\s]*')
  // `node …/vite/bin/vite.js --port 3001`
  const isVite = under('vite(\\.js)?(\\s|$)') && argv.includes(String(DASHBOARD_PORT))
  // `node …/concurrently.js -k -n relay,dashboard,ios,android …`
  const isSupervisor =
    under('concurrently(\\.js)?(\\s|$)') && argv.some((a) => a.startsWith('relay,'))

  return isTsxDev || isVite || isSupervisor
}

/** `ps` output as {pid, command}. Empty if ps is unavailable — never a reason to block. */
export function listProcesses() {
  try {
    // `-ww`: do not let `ps` bound the command column. Not reproducible on this macOS — a
    // 1929-char line survives a pipe intact — but a truncated line makes `isDevProcess` miss a
    // real process, and this tool's worst failure is reporting success having stopped nothing.
    return execFileSync('ps', ['-Awwo', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .map((line) => {
        const m = line.match(/^\s*(\d+)\s+(.*)$/)
        return m ? { pid: Number(m[1]), command: m[2] } : null
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

export const findDevProcesses = () =>
  listProcesses().filter(({ pid, command }) => pid !== process.pid && isDevProcess(command))

/** PIDs listening on a port. `[]` when nothing holds it — or when lsof is unavailable. */
export function listenersOn(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter(Boolean)
  } catch {
    // lsof exits non-zero when nothing matches, and may not be installed at all. Both mean
    // "nothing to report" — a preflight that cannot look must not stop the dev server.
    return []
  }
}

/**
 * Which ports a caller wants checked. Throws on a name that matches nothing: an empty selection
 * would make the preflight exit 0 having looked at nothing, which is the one outcome a tool
 * against silent success must not produce. Exported for the tests.
 */
export function selectPorts(wanted) {
  if (wanted.length === 0) return DEV_PORTS
  const unknown = wanted.filter((w) => !DEV_PORTS.some(({ what }) => what.startsWith(w)))
  if (unknown.length > 0) throw new Error(`Unknown dev-preflight target: ${unknown.join(', ')}`)
  return DEV_PORTS.filter(({ what }) => wanted.some((w) => what.startsWith(w)))
}

export const commandFor = (pid) =>
  listProcesses().find((p) => p.pid === pid)?.command ?? '(unknown)'
