#!/usr/bin/env node
// Runs before `pnpm dev`. A dev server left running from an earlier session holds :4000, the
// relay fails with EADDRINUSE, and concurrently then SIGTERMs the dashboard and both agents —
// so the visible failure is four processes dying and no mention of the port anywhere.
//
// It reports and stops. It does NOT kill anything: a dev server you started deliberately in
// another terminal is indistinguishable from a leftover, and killing the wrong one is the more
// expensive mistake. `pnpm dev:down` is the deliberate version.
import { selectPorts, listenersOn, commandFor, findDevProcesses } from './dev-ports.mjs'

// `pnpm dev:pool` runs no dashboard, so blocking it on :3001 would refuse a start for a port it
// never wanted. Callers name what they need: `dev-preflight.mjs relay dashboard`.
let ports
try {
  ports = selectPorts(process.argv.slice(2))
} catch (e) {
  console.error(`\n  ${e.message}\n`)
  process.exit(2)
}

const held = ports.map(({ port, what }) => ({ port, what, pids: listenersOn(port) })).filter(
  (p) => p.pids.length > 0,
)

if (held.length === 0) process.exit(0)

const ours = new Set(findDevProcesses().map((p) => p.pid))

console.error('\n  Cannot start: something is already listening.\n')
for (const { port, what, pids } of held) {
  for (const pid of pids) {
    const mine = ours.has(pid) ? '  ← a tapflow dev process from this checkout' : ''
    console.error(`  :${port}  ${what}`)
    console.error(`         pid ${pid}${mine}`)
    console.error(`         ${commandFor(pid).slice(0, 120)}\n`)
  }
}

const allOurs = held.every(({ pids }) => pids.every((pid) => ours.has(pid)))
console.error(
  allOurs
    ? '  All of the above are this checkout\'s own dev processes:\n\n      pnpm dev:down\n'
    : `  Some of these are not tapflow dev processes. Check before killing:\n\n      kill ${held
        .flatMap(({ pids }) => pids)
        .join(' ')}\n`,
)
process.exit(1)
