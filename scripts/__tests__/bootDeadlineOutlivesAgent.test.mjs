import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// **A client that gives up before the agent does replaces a reason with a bare timeout.** The agents poll
// for a booting device — 90s on iOS, 120s on Android — and then answer `device:boot-error` with what went
// wrong. `mcp-server` waited 30s, *inside* both, so a cold boot past 30 seconds reported a timeout to the
// model while the boot was proceeding normally and its explanation was already on its way (#549).
//
// The two numbers live in different packages and neither imports the other, so nothing could hold them
// together. That is what this file is: not a check that a constant has a particular value — anyone may
// change any of them — but that the relationship between them survives the change.
//
// **The margin is the part that is easy to get wrong, and it is why this is not a bare `<`.** Those agent
// constants bound *one poll*, not the request. A boot also lists devices, may shut the device down and
// erase it, boots it, opens a stream — none of which has a named ceiling anywhere. `flow-runner` sat at
// exactly Android's 120s, which passes an inequality that reads `deadline > ceiling` only if you squint,
// and buys zero room for any of those stages. So the check requires room, and names how much.

const root = join(import.meta.dirname, '../..')
const read = (p) => readFileSync(join(root, p), 'utf8')

/** How much a client must allow beyond the poll it can see, for the stages it cannot. */
const MIN_MARGIN_MS = 30_000

/** Each entry: where the number lives, and the declaration that carries it. A `_`-separated literal is the
 *  repo's style for these, and the pattern accepts underscores rather than requiring them, so a plain
 *  `120000` is still read rather than silently missed. */
const CEILINGS = [
  {
    what: 'iOS simulator boot poll',
    file: 'packages/ios-agent/src/SimctlWrapper.ts',
    pattern: /BOOT_READY_TIMEOUT_MS = ([\d_]+)/,
  },
  {
    what: 'Android emulator boot poll',
    file: 'packages/android-agent/src/EmulatorLauncher.ts',
    pattern: /BOOT_READY_TIMEOUT_MS = ([\d_]+)/,
  },
]

const DEADLINES = [
  { what: 'mcp-server bootDevice', file: 'packages/mcp-server/src/client.ts', pattern: /BOOT_DEADLINE_MS = ([\d_]+)/ },
  { what: 'flow-runner bootDevice', file: 'packages/flow-runner/src/RelayClient.ts', pattern: /BOOT_DEADLINE_MS = ([\d_]+)/ },
]

const valueOf = ({ file, pattern }) => {
  const m = pattern.exec(read(file))
  return m ? Number(m[1].replace(/_/g, '')) : null
}

/** The rule itself, as a function, so it can be tested in both directions rather than only asserted. */
const clears = (deadline, slowestPoll) => deadline - slowestPoll >= MIN_MARGIN_MS

describe('a relay client outlives the agent boot it is waiting on', () => {
  it('every constant this check compares was actually found', () => {
    // Anti-vacuity, and it is not ceremony here: the whole check is four regexes over four files, so a
    // rename turns every assertion below into a comparison of `null` — which is neither greater nor less
    // than anything, and `toBeGreaterThan` on it fails loudly, but the *pair* count would silently drop to
    // zero if a list were emptied instead. Both failures are covered by asserting the shape first.
    expect(CEILINGS.length).toBe(2)
    expect(DEADLINES.length).toBe(2)
    for (const c of [...CEILINGS, ...DEADLINES]) {
      expect(valueOf(c), `${c.what}: ${c.pattern} found nothing in ${c.file}`).toBeGreaterThan(0)
    }
  })

  it('each client deadline clears the slowest agent poll by the stated margin', () => {
    const slowest = Math.max(...CEILINGS.map(valueOf))
    for (const d of DEADLINES) {
      const deadline = valueOf(d)
      expect(
        clears(deadline, slowest) ? MIN_MARGIN_MS : deadline - slowest,
        `${d.what} is ${deadline}ms against a ${slowest}ms poll — leaves ${deadline - slowest}ms for the ` +
          `stages that have no ceiling (list, shutdown, erase, boot, open stream). Raise it, or lower the poll.`,
      ).toBeGreaterThanOrEqual(MIN_MARGIN_MS)
    }
  })

  it('the rule rejects the state that motivated it, not just states far from it', () => {
    // The check's own strictness, exercised in both directions against the exact numbers this slice found:
    // `flow-runner` was 120_000 against Android's 120_000. A bare `>=` calls that fine and a bare `>` calls
    // it a defect by one millisecond; neither says what is actually wrong, which is that a boot has several
    // unbounded stages to get through after the poll it can see.
    expect(clears(120_000, 120_000), 'equal is not clearing it').toBe(false)
    expect(clears(120_000 + MIN_MARGIN_MS - 1, 120_000), 'one short of the margin is still short').toBe(false)
    expect(clears(120_000 + MIN_MARGIN_MS, 120_000)).toBe(true)
  })

  it('names what it cannot see', () => {
    // `waitForBoot` takes its ceiling as a **default parameter**, so a caller may pass its own and this
    // check would not know. Asserting that the in-repo caller does not is the reachable half; the rest is
    // written down rather than implied.
    const android = read('packages/android-agent/src/AndroidAgent.ts')
    const calls = [...android.matchAll(/waitForBoot\(([^)]*)\)/g)].map((m) => m[1])
    expect(calls.length, 'no waitForBoot call found — did it move?').toBeGreaterThan(0)
    for (const args of calls) {
      expect(args.split(',').length, `waitForBoot(${args}) passes its own timeout, which this check cannot see`).toBe(1)
    }
  })
})
