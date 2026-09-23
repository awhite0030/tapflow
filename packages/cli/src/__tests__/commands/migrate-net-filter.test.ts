import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../../lib/net-filter.js', async (actual) => ({
  ...(await actual<typeof import('../../lib/net-filter.js')>()),
  installNetFilter: vi.fn(),
  followThroughApproval: vi.fn(),
  offerApprovalUpFront: vi.fn(),
}))

import { cmdMigrateNetFilter } from '../../commands/migrate.js'
import {
  installNetFilter, followThroughApproval, offerApprovalUpFront, INSTALL_STAGE_MESSAGE, removalSteps,
} from '../../lib/net-filter.js'

const mockInstall = vi.mocked(installNetFilter)
const mockFollow = vi.mocked(followThroughApproval)
const mockOffer = vi.mocked(offerApprovalUpFront)

/**
 * **What `tapflow migrate net-filter` exits with, per outcome.**
 *
 * This is a contract and not an implementation detail: a provisioning script runs this command and
 * branches on the code. v0.20.0 answered 0 for every outcome it could produce; `installed-unconfirmed`
 * is the first one that does not, and it covers a state that used to be reported as `installed` —
 * so a script that passed on 0.20.0 can fail on 0.21.0 for a Mac whose filter is slow to come up.
 *
 * That change is deliberate, because the old answer was a claim the command could not support. It is
 * pinned here because the release notes state it, and because #731 is an open question about whether
 * this exit code is right — whoever settles it needs to see which of the eleven outcomes were meant
 * as failures rather than infer it from a switch.
 */
const EXIT_CONTRACT: Record<string, 0 | 1> = {
  // Nothing is wrong, or the remaining step is a human's.
  installed: 0,
  'already-current': 0,
  'needs-approval': 0,
  'needs-reboot': 0,
  'not-macos': 0,
  // Something is wrong, or the command declines to guess.
  'installed-unconfirmed': 1,
  'no-artifact': 1,
  'refused-devices-busy': 1,
  'refused-host-unknown': 1,
  'refused-downgrade': 1,
  failed: 1,
}

/** The fields each outcome carries, so the banner renders rather than throwing on `undefined`. */
const OUTCOME: Record<string, Record<string, unknown>> = {
  installed: {},
  'installed-unconfirmed': {},
  'already-current': {},
  'needs-approval': { filterLeftDisabled: true },
  'needs-reboot': {},
  'not-macos': {},
  'no-artifact': {},
  'refused-devices-busy': { busy: ['simulator iPhone 17 Pro'] },
  'refused-host-unknown': { activated: '1787846299' },
  'refused-downgrade': { installed: '1788999999', shipped: '1788357869' },
  failed: { code: 3, detail: 'save refused', filterLeftDisabled: true },
}

describe('tapflow migrate net-filter — exit code contract', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)
    // A stalled install is handed to the approval step. Here nobody approves, so the contract measured is
    // the first answer's — which is what a provisioning script without a terminal sees.
    mockFollow.mockResolvedValue({ status: 'needs-approval', filterLeftDisabled: true })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it.each(Object.entries(EXIT_CONTRACT))('%s exits %d', async (status, code) => {
    mockInstall.mockReturnValue({ status, ...OUTCOME[status] } as never)

    if (code === 0) {
      await cmdMigrateNetFilter()
      expect(exitSpy, `${status} left the process with a failure code`).not.toHaveBeenCalled()
    } else {
      // **The rejection is the assertion that it stopped.** `process.exit` is mocked, so without it the
      // switch would fall through and the next statement would run in a process the real command has
      // already left — which is how a `break` that should have been a `return` reads as passing.
      await expect(cmdMigrateNetFilter()).rejects.toThrow('process.exit')
      expect(exitSpy).toHaveBeenCalledWith(1)
    }
  })

  it('covers every outcome the command handles', () => {
    // **By inspection, because the union is erased at runtime.** `migrate.ts` has a `never`
    // exhaustiveness guard, so a new outcome cannot be forgotten there — but it can be given the
    // wrong exit code, and nothing above would notice a case this table never names.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'commands', 'migrate.ts'), 'utf8',
    )
    const body = src.slice(
      src.indexOf('export async function runNetFilterMigration'),
      src.indexOf('export async function cmdMigrateNetFilter'),
    )
    const handled = [...body.matchAll(/^ {4}case '([a-z-]+)':/gm)].map((m) => m[1])

    expect(handled.length, 'no cases were found — the regex stopped matching the source').toBeGreaterThan(5)
    expect(handled.sort()).toEqual(Object.keys(EXIT_CONTRACT).sort())
  })
})

describe('tapflow migrate net-filter — saying what it is waiting on', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('hands the installer a reporter that prints, instead of installing in silence', async () => {
    // **The wiring, which the installer's own tests cannot see.** Every progress test in
    // `net-filter.test.ts` calls `installNetFilter` directly, so deleting `onProgress` from *this*
    // call site leaves all of them green. That deletion is the mutation this test exists for.
    mockInstall.mockReturnValue({ status: 'already-current' } as never)
    await cmdMigrateNetFilter({ ignoreRunningDevices: true })

    const opts = mockInstall.mock.calls[0]?.[0] as
      { onProgress?: (s: string) => void; ignoreRunningDevices?: boolean } | undefined
    expect(opts?.onProgress, 'the command installs without reporting anything').toBeTypeOf('function')

    // **The flag still reaches the installer.** Adding the reporter turned `installNetFilter(opts)`
    // into `installNetFilter({ ...opts, onProgress })`, and dropping that spread would disable
    // `--ignore-running-devices` silently — the command would refuse with DEVICES ARE IN USE forever,
    // with every test still green. That deletion is the second mutation this test catches.
    expect(opts?.ignoreRunningDevices, '--ignore-running-devices no longer reaches the installer').toBe(true)

    // **And that the reporter writes.** A callback that accepts a stage and drops it would satisfy
    // the check above while leaving the command exactly as silent as it was — which is the defect,
    // not a weaker version of it.
    const logged = vi.mocked(console.log)
    const before = logged.mock.calls.length
    opts?.onProgress?.('activating')
    const written = logged.mock.calls.slice(before).map((c) => String(c[0])).join('\n')
    expect(written).toContain(INSTALL_STAGE_MESSAGE.activating)
  })
})

describe('tapflow migrate net-filter — asking before the install', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    mockInstall.mockReturnValue({ status: 'needs-approval', filterLeftDisabled: true })
    mockFollow.mockResolvedValue({ status: 'installed' })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('asks before installing, and carries a yes into the install and the follow-through', async () => {
    // **The migrate half of the wiring.** Three mutations: asking after the install (the host has
    // already waited by then), dropping `openApprovalSheet` (no screen during the wait), and dropping the
    // answer from the follow-through (the same question twice).
    mockOffer.mockResolvedValue('accepted')
    await cmdMigrateNetFilter()
    expect(mockOffer).toHaveBeenCalledTimes(1)
    expect(mockOffer.mock.invocationCallOrder[0]).toBeLessThan(mockInstall.mock.invocationCallOrder[0]!)
    expect(mockInstall.mock.calls[0]?.[0]?.openApprovalSheet).toBe(true)
    expect(mockFollow.mock.calls[0]?.[3]).toBe('accepted')
    // One set of answers for both questions, so a person is not modelled twice.
    expect(mockFollow.mock.calls[0]?.[1]).toBe(mockOffer.mock.calls[0]?.[0])
  })

  it('installs nothing when the question is backed out of, and does not fail', async () => {
    // A no still installs; Ctrl-C or Esc at a question that warned about dropped connections must not.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit') }) as never)
    mockOffer.mockResolvedValue('cancelled')
    await cmdMigrateNetFilter()
    expect(mockInstall).not.toHaveBeenCalled()
    expect(mockFollow).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
    const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n')
    expect(printed).toMatch(/Cancelled/)
  })

  it('opens nothing when it did not ask', async () => {
    // Non-interactive runs and replaces. `offer !== 'declined'` would start the opener for both.
    mockOffer.mockResolvedValue('not-asked')
    await cmdMigrateNetFilter()
    expect(mockInstall.mock.calls[0]?.[0]?.openApprovalSheet).toBe(false)
    expect(mockFollow.mock.calls[0]?.[3]).toBe('not-asked')
  })

  it('opens nothing after a no, and tells the follow-through not to ask again', async () => {
    mockOffer.mockResolvedValue('declined')
    await cmdMigrateNetFilter()
    expect(mockInstall.mock.calls[0]?.[0]?.openApprovalSheet).toBe(false)
    expect(mockFollow.mock.calls[0]?.[3]).toBe('declined')
  })
})

describe('tapflow migrate net-filter — an extension whose app is gone', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit') }) as never)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('prints the removal steps rather than a command SIP refuses', async () => {
    mockInstall.mockReturnValue({ status: 'refused-host-unknown', activated: '1787846299' } as never)
    await expect(cmdMigrateNetFilter()).rejects.toThrow('process.exit')
    const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n')
    expect(printed).not.toMatch(/systemextensionsctl uninstall/)
    for (const s of removalSteps()) expect(printed).toContain(s)
  })
})

describe('tapflow migrate net-filter — following an approval through', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit') }) as never)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('hands a stalled install to the approval step, and reports what that step ended with', async () => {
    // **The migrate half of the wiring.** Deleting the call leaves the command printing APPROVAL NEEDED
    // over a Mac the person just approved. The options go through whole, so `--ignore-running-devices`
    // still governs the switch-on and the switch-on still reports its progress.
    mockInstall.mockReturnValue({ status: 'needs-approval', filterLeftDisabled: true })
    mockFollow.mockResolvedValue({ status: 'installed' })
    await cmdMigrateNetFilter({ ignoreRunningDevices: true })

    expect(mockFollow).toHaveBeenCalledTimes(1)
    const call = mockFollow.mock.calls[0]
    // The flow starts from what the install answered, so its early ways out can hand that back.
    expect(call?.[0]).toEqual({ status: 'needs-approval', filterLeftDisabled: true })
    const opts = call?.[2]
    expect(opts?.ignoreRunningDevices).toBe(true)
    expect(opts?.onProgress).toBeTypeOf('function')
    const written = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n')
    expect(written, 'the banner reported the first answer rather than the final one').toContain('NETWORK FILTER INSTALLED')
  })

  it('does not describe a refusal after the approval as the refusal before an install', async () => {
    // **Two refusals share one outcome.** Before the install nothing has changed; after an approval the
    // install has run and the filter is off. "It is not done" would be false here, and the Mac would be
    // left with no word that its filter is off. Dropping the branch is the mutation.
    mockInstall.mockReturnValue({ status: 'needs-approval', filterLeftDisabled: true })
    mockFollow.mockResolvedValue({ status: 'refused-devices-busy', busy: ['simulator iPhone 17'], filterLeftDisabled: true })
    await expect(cmdMigrateNetFilter()).rejects.toThrow('process.exit')
    const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n')
    expect(printed).toContain('The extension is approved')
    expect(printed).toContain('switched OFF')
    expect(printed).not.toContain('it is not done')
  })

  it('keeps the original wording for a refusal before anything was installed', async () => {
    mockInstall.mockReturnValue({ status: 'refused-devices-busy', busy: ['simulator iPhone 17'] })
    await expect(cmdMigrateNetFilter()).rejects.toThrow('process.exit')
    const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n')
    expect(printed).toContain('it is not done')
    expect(printed).not.toContain('switched OFF')
    expect(mockFollow).not.toHaveBeenCalled()
  })

  it('does not offer the approval screen when nothing is waiting for approval', async () => {
    mockInstall.mockReturnValue({ status: 'installed' })
    await cmdMigrateNetFilter()
    expect(mockFollow).not.toHaveBeenCalled()
  })
})
