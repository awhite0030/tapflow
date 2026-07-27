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

export const RELAY_PORT = Number(process.env.PORT ?? 4000)
export const DASHBOARD_PORT = 3001
export const DEV_PORTS = [
  { port: RELAY_PORT, what: 'relay' },
  { port: DASHBOARD_PORT, what: 'dashboard (vite)' },
]

const isNode = (argv0) => basename(argv0 ?? '') === 'node'

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

  const inRepo = argv.some(
    (a) => a.startsWith(`${root}/`) && !a.startsWith(`${root}${NESTED_CHECKOUTS}`),
  )
  if (!inRepo) return false

  // tsx launcher and the child it spawns — the child is the one holding the relay port.
  const isTsxDev =
    argv.includes('--conditions=source') &&
    argv.some((a) => /(^|\/)(relay|ios-agent|android-agent|multi-agent)\.ts$/.test(a))
  // `node …/vite/bin/vite.js --port 3001`
  const isVite =
    argv.some((a) => /(^|\/)vite(\.js)?$/.test(a)) && argv.includes(String(DASHBOARD_PORT))
  // `node …/concurrently.js -k -n relay,dashboard,ios,android …`
  const isSupervisor =
    argv.some((a) => /(^|\/)concurrently(\.js)?$/.test(a)) &&
    argv.some((a) => a.startsWith('relay,'))

  return isTsxDev || isVite || isSupervisor
}

/** `ps` output as {pid, command}. Empty if ps is unavailable — never a reason to block. */
export function listProcesses() {
  try {
    return execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' })
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

export const commandFor = (pid) =>
  listProcesses().find((p) => p.pid === pid)?.command ?? '(unknown)'
