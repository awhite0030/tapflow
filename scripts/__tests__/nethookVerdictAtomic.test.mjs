// The injected library's verdict file is written to a temp path and renamed onto the target, so a
// reader never sees a torn one (#653). Two things can undo that and they fail differently:
//
//  1. **The source goes back to writing in place.** Caught by reading `tf_write_verdict`.
//  2. **The source is right and the shipped binary is the old one.** `nethookArtifactFresh` is the
//     general guard for that, and it is the one to read first. This check overlaps it and is kept
//     for the case it cannot see: that guard trusts `nethook-shipped.json`, and the cheapest way
//     past a red guard is to edit the record. Measured — with a stale binary and a record hand-
//     written to match it, every assertion in `nethookArtifactFresh` passes and only this one fails.
//     A record can be forged; an undefined symbol cannot.
//
// **The binary check reads the linker's symbol table, not the author's text.** `_rename` is in the
// dylib because the linker recorded an undefined symbol for it, which no comment, string literal or
// renamed helper can produce. Searching the file's bytes rather than shelling out to `nm` is so the
// check runs on the Linux CI that has no Mach-O tools: the undefined-symbol names live in the string
// table as raw bytes either way. Measured on the two binaries this change sits between — the old one
// contains `_rename` zero times, the rebuilt one twice.
//
// The source check is a spelling assertion and therefore a floor, not a fence
// (contributing/test-and-guard-coverage.md §3). Its structural twin is the binary check: the two are
// independent, and the mutation table below shows each failing without the other.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const DYLIB = join(ROOT, 'packages', 'ios-agent', 'bin', 'libtapflow-nethook.dylib')
const SOURCE = join(ROOT, 'packages', 'ios-agent', 'src', 'network-hook.m')

/** `tf_write_verdict`'s body, from its opening brace to the closing brace in column 1. */
function writeVerdictBody() {
  const src = readFileSync(SOURCE, 'utf8')
  const start = src.indexOf('static void tf_write_verdict(')
  expect(start, 'tf_write_verdict is gone — this check no longer guards anything').toBeGreaterThan(-1)
  const end = src.indexOf('\n}\n', start)
  expect(end, 'tf_write_verdict has no closing brace in column 1').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('the shipped dylib writes its verdict atomically', () => {
  it('imports rename, so the binary in bin/ is one that was built from a source that renames', () => {
    // Anti-vacuity floor from the measured size: a truncated or empty read would pass a bare
    // `includes` check on nothing.
    const bytes = readFileSync(DYLIB)
    expect(bytes.length, 'the dylib is missing or truncated').toBeGreaterThan(50_000)
    expect(
      bytes.includes('_rename'),
      'the committed dylib does not import rename — the source was changed without rebuilding it, '
        + 'or the write went back in place. Run packages/ios-agent/build-nethook.sh.',
    ).toBe(true)
  })

  it('opens a temp path and reaches the target only through rename', () => {
    const body = writeVerdictBody()
    // The claim is about which path `fopen` is given, not that `fopen` is absent — writing still
    // uses it, one file over.
    expect(body).toMatch(/fopen\(tmp,/)
    expect(body, 'fopen truncates the target in place, which is the defect').not.toMatch(/fopen\(path,/)
    expect(body).toMatch(/rename\(tmp, path\)/)
  })

  it('removes the temp file on every path that does not rename it', () => {
    // Otherwise a failing app leaves one `.tmp` per launch in the simulator's /tmp, and the failure
    // that produced them is silent by construction.
    const body = writeVerdictBody()
    const renames = (body.match(/rename\(/g) ?? []).length
    const unlinks = (body.match(/unlink\(/g) ?? []).length
    expect(renames).toBe(1)
    expect(unlinks, 'a write that fails after creating the temp file leaves it behind').toBe(2)
  })
})
