import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

// The only place a cross-package assertion can live: each agent's tests run inside its own package,
// and neither depends on the other. So this reads source as text, the way testsReadSource.test.mjs
// does, to hold the two producers to one contract.

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')

/** From a declaration's start to the line that closes it — `\n}` at column 0. */
function sliceBlock(src, startsWith) {
  const from = src.indexOf(startsWith)
  if (from < 0) throw new Error(`not found: ${startsWith}`)
  const end = src.indexOf('\n}', from)
  return src.slice(from, end < 0 ? undefined : end)
}

/** Android's internal reasons, which its switch names on the way in. Not wire reasons. */
const INTERNAL_ONLY = new Set(['channel-down', 'no-session'])

const PROTOCOL = 'packages/protocol/src/index.ts'
const IOS = 'packages/ios-agent/src/IOSAgent.ts'
const ANDROID_MAP = 'packages/android-agent/src/inputOutcome.ts'

function declaredReasons() {
  const src = read(PROTOCOL)
  const block = src.slice(src.indexOf('export type InputErrorReason'))
  const end = block.indexOf('\n\n')
  return [...block.slice(0, end).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort()
}

describe('input:error reason — one contract, two producers', () => {
  it('the union parses and has the members the producers rely on', () => {
    // A bare length check passed on any non-empty union, including a truncated parse — this file's
    // parser terminates on a blank line, so a reformat could have silently shortened the set.
    expect(declaredReasons()).toEqual(
      ['channel-starting', 'channel-unavailable', 'dispatch-failed', 'malformed', 'no-gesture', 'not-booted', 'unsupported'],
    )
  })

  // A lookup table is a runtime value, and this package's main entry must erase under `import type`
  // or it lands in the dashboard bundle. So the prose lives with each agent, deliberately.
  it('the protocol package declares no message table', () => {
    const src = read(PROTOCOL)
    expect(src).not.toMatch(/INPUT_ERROR_MESSAGES|Record<InputErrorReason/)
  })

  for (const [name, file] of [['ios-agent', IOS], ['android-agent', ANDROID_MAP]]) {
    it(`${name} imports the reason type rather than declaring its own`, () => {
      const src = read(file)
      expect(src).toMatch(/import type \{[^}]*InputErrorReason[^}]*\} from '@tapflowio\/protocol'/)
      // A local re-declaration would let the two drift, which is the whole failure this guards.
      expect(src).not.toMatch(/(export )?type InputErrorReason\s*=/)
    })
  }

  // Built from what the protocol declares, not from a hand-written list. An earlier version listed
  // the names itself and then asserted they were declared — true by construction, and it stopped
  // covering the union the moment a reason was added.
  it('every declared reason is named by at least one producer', () => {
    const declared = declaredReasons()
    const sources = [IOS, ANDROID_MAP].map(read).join('\n')
    const missing = declared.filter((r) => !sources.includes(`'${r}'`))
    // A reason nothing can produce is a promise to consumers that no code keeps.
    expect(missing, 'declared but unreachable').toEqual([])
  })

  it('neither producer names a reason the protocol does not declare', () => {
    const declared = new Set(declaredReasons())
    // Anything quoted in a `case '…':` or as a key of the message table is a candidate; the union's
    // own members are hyphenated lowercase, so that shape is the filter rather than a fixed list.
    // Scoped to the one construct in each file that names wire reasons — the message table on iOS,
    // the mapping switch on Android. Reading the whole file would sweep in unrelated hyphenated
    // strings (device chrome button names, for one) and the test would be about the regex.
    const blocks = [
      ['ios message table', sliceBlock(read(IOS), 'const INPUT_ERROR_MESSAGES')],
      ['android wireReason', sliceBlock(read(ANDROID_MAP), 'export function wireReason')],
    ]
    for (const [what, block] of blocks) {
      const named = [...block.matchAll(/'([a-z]+(?:-[a-z]+)+)'/g)].map((m) => m[1])
      expect(named.length, `${what} names no reasons`).toBeGreaterThan(0)
      for (const r of named) {
        // Android's own internal reasons appear on the left of its switch; only a name that looks
        // like a wire reason and is not declared is the failure.
        if (INTERNAL_ONLY.has(r)) continue
        expect(declared, `${what} names ${r}`).toContain(r)
      }
    }
  })
})
