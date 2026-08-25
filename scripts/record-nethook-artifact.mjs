#!/usr/bin/env node
// Writes the record that ties the committed injected library to its sources.
// `build-nethook.sh` runs this as its last step, so the binary and the record are produced together —
// which is the only arrangement where forgetting one cannot leave the other looking right.
import fs from 'node:fs'
import path from 'node:path'
import { computeRecord, readRecord, RECORD, SHIPPED_DYLIB } from './lib/nethook-artifact.mjs'

const repo = path.resolve(import.meta.dirname, '..')
const record = computeRecord(repo)
if (record.dylibBytes === 0) {
  console.error(`No dylib at ${SHIPPED_DYLIB} — build it before recording.`)
  process.exit(1)
}

// **Refuse to certify a stale binary against new sources.** This script needs nothing but node, so
// the cheapest way past a red guard is to run it — which rewrites both hashes and produces a record
// that is perfectly consistent with itself and wrong. If the sources moved and the binary did not,
// the binary was not rebuilt, and saying so here is the difference between a guard and a formality.
const previous = readRecord(repo)
if (previous && previous.sources !== record.sources && previous.dylib === record.dylib) {
  console.error(
    'The hook sources changed but the dylib did not — it has not been rebuilt.\n'
    + '  Run packages/ios-agent/build-nethook.sh, which rebuilds and records in one step.\n'
    + '  (Recording on its own here would certify the old binary against the new sources.)',
  )
  process.exit(1)
}
fs.writeFileSync(path.join(repo, RECORD), `${JSON.stringify(record, null, 2)}\n`)
console.log(`recorded ${RECORD}: ${record.sourceFileCount} sources, ${record.dylibBytes} bytes`)
