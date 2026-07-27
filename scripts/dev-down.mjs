#!/usr/bin/env node
// Stops the dev processes `pnpm dev` starts, for this checkout only.
//
// Why this exists: `concurrently -k` cleans up when it exits normally, but not when the terminal
// goes away, the machine sleeps, or a process was started detached. One relay survived a day that
// way and cost a debugging session — the failure it produced named neither the port nor the pid.
import { findDevProcesses, listenersOn, REPO_ROOT, DEV_PORTS } from './dev-ports.mjs'

// Reported before the early exit: "nothing of ours is running" and "the port is free" are
// different facts, and the case that needs both stated is exactly the one that returned early.
function reportForeignHolders() {
  for (const { port, what } of DEV_PORTS) {
    if (listenersOn(port).length > 0) {
      console.log(`\n  Note: :${port} (${what}) is still held, by something that is not a tapflow dev process.`)
    }
  }
}

const targets = findDevProcesses()
if (targets.length === 0) {
  console.log(`No tapflow dev processes running for ${REPO_ROOT}`)
  reportForeignHolders()
  process.exit(0)
}

for (const { pid, command } of targets) {
  console.log(`  kill ${pid}  ${command.slice(0, 100)}`)
  try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
}

// SIGTERM first so a relay can close its sockets; SIGKILL only what ignores it.
await new Promise((r) => setTimeout(r, 1500))
const survivors = findDevProcesses()
for (const { pid } of survivors) {
  console.log(`  kill -9 ${pid}  (did not stop on SIGTERM)`)
  try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
}

// The child processes tsx spawns (esbuild services) exit with their parent; anything still
// holding a port after this is not ours, and saying so is more useful than a silent success.
await new Promise((r) => setTimeout(r, 500))
const stillThere = findDevProcesses()
if (stillThere.length > 0) {
  console.error(`\n  ${stillThere.length} process(es) survived — investigate:`)
  for (const { pid, command } of stillThere) console.error(`    ${pid}  ${command.slice(0, 100)}`)
  process.exit(1)
}

reportForeignHolders()

console.log('\nStopped.')
