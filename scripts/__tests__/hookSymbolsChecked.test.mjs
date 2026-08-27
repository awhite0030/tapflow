// The symbols `doctor` looks for are the symbols the hook actually rebinds.
//
// **A copy exists and this is what makes it safe.** `wanted[]` lives in the injected library's source
// (`packages/ios-agent/src/network-hook.m`), which the CLI does not ship — and it cannot be recovered
// from the shipped dylib either: three of the four are resolved with `dlsym(RTLD_DEFAULT, name)`, so
// they are C string literals rather than import entries. Measured against the built artifact with
// `scripts/lib/macho.mjs`: only `_getaddrinfo` appears in its symbol table at all.
//
// So the CLI keeps its own list, and the drift that costs something is one direction: a symbol added
// to `wanted[]` and not to the check. The install is all-or-none, so the new symbol failing takes the
// whole feature down while `doctor` goes on reporting that everything it knows about is present —
// a check that is green precisely because it has not been told what to look for.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const HOOK = 'packages/ios-agent/src/network-hook.m'
const DOCTOR = 'packages/cli/src/lib/doctor.ts'

/** The `name` field of every entry in the dylib's `wanted[]` table. */
function rebound() {
  const src = readFileSync(join(ROOT, HOOK), 'utf8')
  const start = src.indexOf('wanted[] = {')
  expect(start, 'wanted[] is gone — this check no longer guards anything').toBeGreaterThan(-1)
  const block = src.slice(start, src.indexOf('};', start))
  return [...block.matchAll(/\{"([a-z_]+)"/g)].map((m) => m[1]).sort()
}

/** The list `doctor` reads the SDK stubs for. */
function checked() {
  const src = readFileSync(join(ROOT, DOCTOR), 'utf8')
  const m = src.match(/const HOOK_SYMBOLS = \[([^\]]*)\]/)
  expect(m, 'HOOK_SYMBOLS is gone from doctor').toBeTruthy()
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()
}

describe('doctor checks the symbols the hook actually needs', () => {
  it('reads both lists, so neither side can be empty and pass', () => {
    // Anti-vacuity from the measured count: four in each. Two regexes that matched nothing would
    // satisfy the comparison below by finding two empty lists equal.
    expect(rebound().length, 'the rebinding table parsed as empty').toBeGreaterThanOrEqual(4)
    expect(checked().length, "doctor's list parsed as empty").toBeGreaterThanOrEqual(4)
  })

  it('looks for exactly what is rebound', () => {
    expect(
      checked(),
      'The symbols `doctor` checks and the symbols the injected library rebinds have drifted apart.\n'
      + '  `wanted[]` is all-or-none, so one entry this Xcode no longer exports takes the whole feature\n'
      + `  down — and a check that has not been told to look for it reports green while that happens.\n`
      + `  Both lists: ${HOOK} and ${DOCTOR}.`,
    ).toEqual(rebound())
  })

  it('names stubs that exist in an SDK layout', () => {
    // A floor rather than a fence — it cannot know what a future SDK ships — but it catches the
    // rename that would make every symbol read as missing and every install read as broken.
    const src = readFileSync(join(ROOT, DOCTOR), 'utf8')
    expect(src, 'the SDK stub list is gone').toMatch(/const SDK_STUBS = \[/)
    expect(src).toContain('usr/lib/libSystem.tbd')
    expect(src).toContain('Network.framework/Network.tbd')
  })
})
