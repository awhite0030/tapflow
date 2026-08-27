// A session-less entry point on an agent resolves its device through the shared refuser, not by
// insertion order.
//
// **The unit test beside this one covers the entry points that exist; this covers the twelfth.**
// `AndroidAgent.ambiguousDevice.test.ts` asserts that `screenshot`, `setNetworkOffline` and the touch
// methods refuse — but a new member written next year would copy the shape of its neighbours, and if
// the copied shape were `deviceStates.values().next().value` nothing would say so. That is how eleven
// of them accumulated: `IOSAgent.soleOf` had already fixed the defect (#607) and each new Android
// entry point was written from the one above it.
//
// **A source check, so a floor rather than a fence** — a member could resolve a device some third way
// and pass. What it catches precisely is the copy, which is what actually happened.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const AGENT = 'packages/android-agent/src/AndroidAgent.ts'

/**
 * The one member allowed to take the first entry, named rather than pattern-matched.
 *
 * Writing the exemption as a regex that happens to skip it would let the next exemption in silently.
 * `#617` gives the reason: a read's worst case is answering about the wrong device, a write's is
 * taking someone else's device off the network — and this one answers *before* a device is chosen,
 * so refusing would make "which session am I on" an error on a healthy two-emulator Mac.
 */
const ALLOWED = ['get sessionId()']

/** Every `deviceStates.…next().value` in the file, with the member it sits in. */
function insertionOrderPicks(src) {
  const lines = src.split('\n')
  const found = []
  let member = '(top level)'
  for (const [i, line] of lines.entries()) {
    // Members are two-space indented in this class; anything deeper is a nested function.
    const m = line.match(/^ {2}(?:private |public |async |static )*(get [a-zA-Z]+\(\)|[a-zA-Z]+\()/)
    if (m) member = m[1].endsWith('(') ? `${m[1]})` : m[1]
    if (/deviceStates\.(values|keys)\(\)\.next\(\)\.value/.test(line) && !line.trimStart().startsWith('*')) {
      found.push({ member, line: i + 1 })
    }
  }
  return found
}

describe('AndroidAgent resolves a device the way IOSAgent does', () => {
  const src = readFileSync(join(ROOT, AGENT), 'utf8')

  it('reads a real file with the shared refuser in it', () => {
    // Anti-vacuity: if the helper were renamed away, every assertion below would pass by finding
    // nothing to complain about, on a class that had lost the fix entirely.
    expect(src.length, 'the agent source parsed as empty').toBeGreaterThan(1000)
    expect(src, 'the shared refuser is gone — this check no longer guards anything')
      .toContain('private soleLiveOrNone()')
    expect(src, 'the refusal itself is gone').toMatch(/cannot choose between them/)
  })

  it('leaves only the named exemption picking the first entry', () => {
    const offenders = insertionOrderPicks(src)
      .filter((f) => !ALLOWED.includes(f.member))
      .map((f) => `${f.member} at ${AGENT}:${f.line}`)
    expect(
      offenders,
      'These resolve their device by insertion order — the entry the relay happened to register\n'
      + '  first, which on a two-emulator Mac is somebody else\'s device (#617). Route them through\n'
      + '  `soleLive()` (or `soleLiveOrNone()` where absence has always been a no-op). If one genuinely\n'
      + '  belongs to the exemption, add it to ALLOWED here with the reason, so the next reader can\n'
      + '  see it was a decision.',
    ).toEqual([])
  })

  it('still has the exemption, so the list is not stale', () => {
    // The other direction: if `get sessionId()` were changed to refuse, ALLOWED would name a member
    // that no longer needs it and the next person would inherit an exemption for nothing.
    const picks = insertionOrderPicks(src).map((f) => f.member)
    expect(picks, 'ALLOWED names a member that no longer picks the first entry').toEqual(ALLOWED)
  })
})
