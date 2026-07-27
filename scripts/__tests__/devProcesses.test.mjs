// `dev-down` SIGKILLs whatever `isDevProcess` selects, so these fixtures are the safety argument.
//
// The MATCH cases are verbatim `ps -Ao pid=,command=` lines from a live `pnpm dev` — copied, not
// written from memory. The first version of this matcher was written from memory and selected
// none of the three roles while selecting `grep`, `less` and sibling checkouts instead.
import { describe, it, expect } from 'vitest'
import { isDevProcess, selectPorts, DEV_PORTS } from '../dev-ports.mjs'

const ROOT = '/Users/dev/projects/tapflow'
const NODE = '/Users/dev/.nvm/versions/node/v24.15.0/bin/node'

// Real command lines, with the path rewritten to ROOT.
const REAL = {
  supervisor: `node ${ROOT}/node_modules/.bin/../concurrently/dist/bin/concurrently.js -k -n relay,dashboard,ios,android -c cyan,magenta,green,yellow pnpm dev:relay`,
  vite: `node ${ROOT}/packages/dashboard/node_modules/.bin/../vite/bin/vite.js --port 3001`,
  tsxLauncher: `node ${ROOT}/playground/node_modules/.bin/../tsx/dist/cli.mjs --conditions=source relay.ts`,
  tsxChild: `${NODE} --require ${ROOT}/node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/preflight.cjs --import file://${ROOT}/node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/loader.mjs --conditions=source relay.ts`,
  iosLauncher: `node ${ROOT}/playground/node_modules/.bin/../tsx/dist/cli.mjs --conditions=source ios-agent.ts`,
  androidLauncher: `node ${ROOT}/playground/node_modules/.bin/../tsx/dist/cli.mjs --conditions=source android-agent.ts`,
}

describe('isDevProcess — must select every process `pnpm dev` starts', () => {
  for (const [name, command] of Object.entries(REAL)) {
    it(`selects the ${name}`, () => {
      expect(isDevProcess(command, ROOT)).toBe(true)
    })
  }
})

describe('isDevProcess — must never select anything else', () => {
  const NEVER = {
    // A sibling clone at a path the repo root is a prefix of. `includes(ROOT)` matched these.
    'sibling clone (prefix)': `node ${ROOT}-fork/playground/node_modules/.bin/../tsx/dist/cli.mjs --conditions=source relay.ts`,
    'sibling clone (suffix)': `node ${ROOT}2/packages/dashboard/node_modules/.bin/../vite/bin/vite.js --port 3001`,
    // Agent worktrees live INSIDE the repo but are separate checkouts.
    'agent worktree': `node ${ROOT}/.claude/worktrees/agent-x/playground/node_modules/.bin/../tsx/dist/cli.mjs --conditions=source relay.ts`,
    // Someone else's project that happens to use the same tooling.
    'unrelated vite': '/usr/local/bin/node /Users/dev/other-app/node_modules/vite/bin/vite.js --port 3001',
    // Tools whose ARGUMENTS contain the patterns. Grepping the repo for the string in
    // dev-ports.mjs must not make you a kill target.
    // Unquoted on purpose: `ps` shows the shell's word-split argv, so the search terms arrive as
    // separate tokens that look exactly like a dev process's flags. This is the case that makes
    // the "executable must be node" rule load-bearing — with quotes it passes for the wrong
    // reason, and the rule can be deleted without any test noticing.
    grep: `grep -rn vite --port 3001 ${ROOT}/packages`,
    ripgrep: `rg --conditions=source relay.ts ${ROOT}/packages`,
    pager: `less ${ROOT}/scripts/dev-ports.mjs vite --port 3001`,
    editor: `vim ${ROOT}/README.md`,
    tail: `tail -f ${ROOT}/relay.log`,
    // Node processes in the repo doing something else entirely.
    'node running eslint': `node ${ROOT}/node_modules/.bin/eslint scripts`,
    'node running vitest': `node ${ROOT}/node_modules/.pnpm/vitest@3.0.0/node_modules/vitest/vitest.mjs run`,
    'the teardown script itself': `node ${ROOT}/scripts/dev-down.mjs`,
    // A build of the same sources — not a running dev server.
    'tsc build': `node ${ROOT}/node_modules/.bin/tsc -b`,
  }

  for (const [name, command] of Object.entries(NEVER)) {
    it(`does not select: ${name}`, () => {
      expect(isDevProcess(command, ROOT)).toBe(false)
    })
  }
})

describe('isDevProcess — the role and the repo must be the SAME argument', () => {
  // Each of these supplies "inside the repo" from one argument and "looks like a dev process"
  // from another. Checking the two independently made all four kill targets.
  const SPLIT_EVIDENCE = {
    'in-repo tsx running an out-of-repo script':
      `node ${ROOT}/node_modules/.bin/tsx --conditions=source /Users/dev/side/relay.ts`,
    'foreign tsx, repo path in an unrelated flag':
      `node /usr/local/lib/tsx/cli.mjs --conditions=source relay.ts --cwd ${ROOT}/x`,
    'foreign vite, repo path as data':
      `node /other/node_modules/vite/bin/vite.js --port 3001 --root ${ROOT}/packages`,
    'a repo script with a vite-ish word and a bare 3001':
      `node ${ROOT}/scripts/foo.mjs vite 3001`,
  }

  for (const [name, command] of Object.entries(SPLIT_EVIDENCE)) {
    it(`does not select: ${name}`, () => {
      expect(isDevProcess(command, ROOT)).toBe(false)
    })
  }
})

describe('isDevProcess — a checkout path containing spaces', () => {
  // Splitting the command on whitespace shredded such a path, so nothing matched: `dev:down`
  // reported "no dev processes" and exited 0 while the relay still held the port — the exact
  // confusion the tool exists to remove, delivered as a success.
  const SPACED = '/Users/dev/My Projects/tapflow'

  it('still selects the relay', () => {
    expect(isDevProcess(
      `node ${SPACED}/playground/node_modules/.bin/../tsx/dist/cli.mjs --conditions=source relay.ts`,
      SPACED,
    )).toBe(true)
  })

  it('still selects vite', () => {
    expect(isDevProcess(
      `node ${SPACED}/packages/dashboard/node_modules/.bin/../vite/bin/vite.js --port 3001`,
      SPACED,
    )).toBe(true)
  })

  it('still refuses a sibling checkout', () => {
    expect(isDevProcess(
      `node ${SPACED}-fork/packages/dashboard/node_modules/vite/bin/vite.js --port 3001`,
      SPACED,
    )).toBe(false)
  })
})

describe('isDevProcess — the individual conditions', () => {
  it('requires the executable to be node, not merely a mention of it', () => {
    expect(isDevProcess(`sh -c "node ${ROOT}/playground/x --conditions=source relay.ts"`, ROOT))
      .toBe(false)
  })

  it('requires an absolute path inside the repo, not a relative one', () => {
    // Run from inside the repo, everything is relative and the process is indistinguishable
    // from the same command in any other checkout. Refuse rather than guess.
    expect(isDevProcess('node ./node_modules/.bin/tsx --conditions=source relay.ts', ROOT))
      .toBe(false)
  })

  it('requires a recognised role, not just any node process in the repo', () => {
    expect(isDevProcess(`node ${ROOT}/playground/seed.ts`, ROOT)).toBe(false)
  })

  it('does not confuse vite on another port with the dashboard', () => {
    expect(isDevProcess(`node ${ROOT}/node_modules/vite/bin/vite.js --port 5173`, ROOT)).toBe(false)
  })

  it('does not treat a docs or playground concurrently run as the dev supervisor', () => {
    expect(isDevProcess(`node ${ROOT}/node_modules/.bin/concurrently -n docs,api "a" "b"`, ROOT))
      .toBe(false)
  })
})

// `pnpm dev:pool` runs no dashboard, so callers name the ports they need. A name that matches
// nothing must not quietly select none: the preflight would then exit 0 having looked at nothing,
// which is precisely the silent success this tool exists to prevent.
describe('selectPorts', () => {
  it('returns every port when nothing is named', () => {
    expect(selectPorts([])).toEqual(DEV_PORTS)
  })

  it('selects by prefix, so "dashboard" matches "dashboard (vite)"', () => {
    expect(selectPorts(['dashboard']).map((p) => p.what)).toEqual(['dashboard (vite)'])
    expect(selectPorts(['relay']).map((p) => p.what)).toEqual(['relay'])
  })

  it('throws on a name that matches nothing rather than selecting none', () => {
    expect(() => selectPorts(['relayy'])).toThrow(/Unknown dev-preflight target: relayy/)
    expect(() => selectPorts(['relay', 'typo'])).toThrow(/typo/)
  })
})
