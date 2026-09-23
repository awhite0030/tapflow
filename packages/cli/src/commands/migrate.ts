import fs from 'fs'
import path from 'path'
import { confirm, isCancel } from '@clack/prompts'
import { resolveInstallDir, holdsInstallData, config, LEGACY_DATA_DIR, UNIFIED_DATA_DIR } from '@tapflowio/relay'
import { probeBind } from '../lib/port-available.js'
import { isInteractive } from '../lib/interactive.js'
import { banner, step, warn, DIM, R } from '../lib/print.js'
import { migrateDataDir } from '../lib/migrate-data-dir.js'
import {
  installNetFilter, followThroughApproval, offerApprovalUpFront, APPROVAL_PATH, INSTALL_STAGE_MESSAGE, CONFIRM_DEADLINE_MS,
  NET_FILTER_APP, removalSteps, type InstallOptions,
  readNetFilterState, isNetFilterCurrent, isFilterEnforcing, isNewer,
} from '../lib/net-filter.js'
import { terminalApprovalDeps } from '../lib/approval-prompt.js'

/**
 * What one migration step came to, for `tapflow migrate` to decide whether to go on.
 *
 * - `ok` — done, already done, or waiting on something only the user can do (a macOS approval, a
 *   restart). The subcommand exits 0 in each of these, and so does the list.
 * - `failed` — the subcommand exits 1. The list stops here.
 * - `cancelled` — the user backed out of a question. Nothing changed; the list stops, exit 0.
 */
export type StepResult = 'ok' | 'failed' | 'cancelled'

// `tapflow migrate data-dir` — one-shot move of a legacy .tapflow-data/ into the unified .tapflow/data/.
//
// **The install dir, like every other command.** It read the cwd until the install dir existed, and
// the docs now tell a server operator to set TAPFLOW_HOME and run tapflow commands from wherever
// they are — which would have reported "nothing to migrate" while the install's legacy directory
// stayed exactly where it was, with the relay warning about it on every start.
export async function runDataDirMigration(): Promise<StepResult> {
  const dir = resolveInstallDir().dir

  // **Refused while this install's relay is running** (#836). The relay holds its uploads directory in
  // memory: moving the data under it makes the next upload recreate `.tapflow-data/uploads/builds/`
  // and leave its build there, outside the data the relay reads after a restart — and the next
  // migrate stops on two directories. The port is the relay's own resolved one (`config.local.port`,
  // so `TAPFLOW_PORT` from the shell or the data dir's `.env` counts), probed the way the relay binds
  // it. Only `EADDRINUSE` means something is there; `EACCES` on a low port is not a running relay.
  // Checked only when there is something to move, so an install with nothing to migrate is not told
  // to stop anything.
  if (fs.existsSync(path.join(dir, '.tapflow-data'))) {
    const port = config.local.port
    const err = await probeBind(port)
    if (err?.code === 'EADDRINUSE') {
      banner('error', 'STOP THE RELAY FIRST', [
        `Something is listening on port ${port}, the port this install's relay uses.`,
        'Moving the data while the relay runs leaves anything uploaded meanwhile in the old directory.',
        'Stop the relay, then run this again.',
        'A relay started on another port with `tapflow relay start --port` is not detected — stop it too.',
      ])
      return 'failed'
    }
  }

  const result = migrateDataDir(dir)
  switch (result.status) {
    case 'migrated': {
      const lines = ['Moved .tapflow-data/ → .tapflow/data/.']
      if (result.configUpdated) lines.push('Repointed local.dataDir in tapflow.config.json.')
      if (result.gitignoreUpdated) lines.push('Added the runtime paths to .gitignore.')
      lines.push('Start tapflow as usual: tapflow start')
      banner('success', 'DATA DIRECTORY MIGRATED', lines)
      return 'ok'
    }
    case 'noop-already':
      banner('success', 'ALREADY MIGRATED', ['.tapflow/data/ is in place and no legacy .tapflow-data/ remains.'])
      return 'ok'
    case 'noop-no-legacy':
      banner('success', 'NOTHING TO MIGRATE', ['No legacy .tapflow-data/ found in this directory.'])
      return 'ok'
    case 'conflict':
      banner('error', 'MIGRATION BLOCKED', [
        'Both .tapflow-data/ (legacy) and .tapflow/data/ exist.',
        'Reconcile by hand — keep the directory with your real data, remove the other, then re-run.',
      ])
      return 'failed'
    case 'exdev':
      banner('error', 'CROSS-FILESYSTEM MOVE', [
        '.tapflow-data/ and .tapflow/data/ are on different filesystems, so an atomic move is not possible.',
        'Move it by hand: mv .tapflow-data .tapflow/data',
        'Then set local.dataDir to .tapflow/data in tapflow.config.json if it was pinned to the old path.',
        ...configNotRestored(result),
      ])
      return 'failed'
    case 'config-unwritable':
      banner('error', 'CANNOT UPDATE THE CONFIG', [
        `${result.configPath} names .tapflow-data as the data directory and could not be rewritten:`,
        result.detail,
        'Nothing was moved.',
      ])
      return 'failed'
    case 'rename-failed':
      banner('error', 'MIGRATION FAILED', [
        `Could not move .tapflow-data/ to .tapflow/data/: ${result.detail}`,
        'Nothing was moved. Stop anything using the directory and run this again.',
        ...configNotRestored(result),
      ])
      return 'failed'
  }
}

// The one state a failed move can leave worse than it found: the config already rewritten and not put
// back. Said with the exact line to restore, because the relay would otherwise start on an empty
// .tapflow/data/ while the data sits untouched in .tapflow-data/.
function configNotRestored(result: { configRestored: boolean; configPath: string }): string[] {
  if (result.configRestored) return []
  return [
    '',
    `${result.configPath} was already changed and could not be put back: it now names`,
    '.tapflow/data while the data is still in .tapflow-data. Set local.dataDir back to',
    '".tapflow-data" in that file before starting the relay.',
  ]
}

/** `tapflow migrate data-dir` on its own: the step, with the exit code it has always had. */
export async function cmdMigrateDataDir(): Promise<void> {
  if (await runDataDirMigration() === 'failed') process.exit(1)
}

/**
 * `tapflow migrate net-filter` — put the iOS network filter on a Mac that was set up before it existed.
 *
 * **`setup` cannot cover this and that is the whole reason this exists.** Setup is a first-run
 * command; someone who ran it a year ago and then upgraded never runs it again, so the filter would
 * arrive in their `node_modules` and never reach their Mac. `migrate data-dir` was written for the
 * same shape of problem.
 *
 * The install itself is `installNetFilter`, shared with setup — one routine, because two would
 * eventually answer the same question differently.
 */
export async function runNetFilterMigration(opts: { ignoreRunningDevices?: boolean } = {}): Promise<StepResult> {
  // **Lines rather than a spinner**, and that is forced rather than chosen: `installNetFilter` is
  // synchronous to the bottom, so `setInterval` never fires while it runs. See `InstallStage`.
  // **Asked before anything changes, when macOS is going to ask too (#799).** The answer opens the
  // approval screen during the host's wait instead of after it, and carries into the follow-through so
  // nobody is asked twice.
  const deps = terminalApprovalDeps()
  const offer = await offerApprovalUpFront(deps)
  // Backing out of the question is backing out of the command: nothing has changed yet.
  if (offer === 'cancelled') {
    step('Cancelled — nothing was installed.')
    return 'cancelled'
  }
  const installOpts: InstallOptions = {
    ...opts, onProgress: (s) => step(INSTALL_STAGE_MESSAGE[s]), openApprovalSheet: offer === 'accepted',
  }
  let outcome = installNetFilter(installOpts)
  // **Finished in the same run when somebody is here to do it (#799).** Async for the prompt alone. What
  // comes back is decided by the switch below exactly as a first answer would be, so the exit code of
  // every outcome is unchanged.
  if (outcome.status === 'needs-approval') {
    outcome = await followThroughApproval(outcome, deps, installOpts, offer)
  }
  switch (outcome.status) {
    case 'installed':
      banner('success', 'NETWORK FILTER INSTALLED', [
        `Installed to ${NET_FILTER_APP} and activated.`,
        'iOS network control is available now: tapflow doctor ios',
      ])
      return 'ok'
    case 'installed-unconfirmed':
      // **Not a failure, and not a success either.** The app is in place and the extension is
      // activated; what could not be confirmed is that a provider came back up and started
      // enforcing. Saying "available now" here would be the claim this whole check exists to stop
      // making.
      banner('error', 'INSTALLED, BUT NOTHING IS FILTERING YET', [
        `Installed to ${NET_FILTER_APP}, and macOS accepted it — but no filter reported itself`,
        `as running within ${CONFIRM_DEADLINE_MS / 1000} seconds.`,
        '',
        // **The honest half.** Reaching here means the configuration was switched back on and nothing
        // answered, which is the shape that took this Mac's network down on 2026-09-02. Saying "your
        // network is unaffected" would be telling someone the symptom in front of them cannot be
        // happening — and the remedy for it appears nowhere else in this command's output.
        'It may still be starting. Check first:',
        '  tapflow doctor ios',
        '',
        'If new connections on this Mac have stopped working, take the filter out of the path:',
        `  ${NET_FILTER_APP}/Contents/MacOS/TapflowNetFilter --off`,
        'Traffic returns immediately; iOS network control stays off until you run this command again.',
      ])
      return 'failed'
    case 'already-current':
      banner('success', 'ALREADY UP TO DATE', ['The Mac is already running the filter this tapflow carries.'])
      return 'ok'
    case 'needs-approval':
      banner('success', 'APPROVAL NEEDED', [
        `Installed to ${NET_FILTER_APP}, and macOS is waiting for you to allow it.`,
        `Open ${APPROVAL_PATH} and switch tapflow on.`,
        // **Run again, not check.** Every way here — no terminal, the offer declined, or no switch
        // within the wait — leaves the filter off, and the rerun is what turns it on. Pointing at
        // `doctor` first only sent people to a line telling them to run this.
        'Then run this again to switch the filter on: tapflow migrate net-filter',
        ...(outcome.filterLeftDisabled ? [
          'The filter stays switched off until then — your network is unaffected, and iOS network'
          + ' control stays unavailable.',
        ] : []),
      ])

      return 'ok'
    case 'needs-reboot':
      banner('success', 'RESTART TO FINISH', [
        'Installed. macOS replaces a running filter only on restart, so the previous version keeps running until then.',
        'Restart the Mac, then: tapflow doctor ios',
      ])
      return 'ok'
    case 'not-macos':
      banner('success', 'NOTHING TO MIGRATE', ['The iOS network filter is macOS only.'])
      return 'ok'
    case 'no-artifact':
      banner('error', 'NO FILTER TO INSTALL', [
        'This tapflow install carries no usable filter app, so there is nothing to migrate.',
        'Reinstalling tapflow restores it.',
      ])
      return 'failed'
    case 'refused-devices-busy':
      // Not an error the way a failed install is: nothing is broken, the moment is wrong. Naming what
      // is running is the point — the person at the keyboard may not be the person testing.
      //
      // **Two refusals share this outcome and they are different states.** Before the install nothing
      // has changed. After an approval the install has run and the filter is waiting to be switched on
      // — `filterLeftDisabled` being present says so — and "it is not done" would be false there.
      banner('error', 'DEVICES ARE IN USE', [
        ...(outcome.filterLeftDisabled === undefined ? [
          'Replacing the network filter interrupts every new connection on this Mac while it happens,',
          'so it is not done while something is running:',
        ] : [
          'The extension is approved, but switching the filter on drops connections this Mac has open,',
          'so it was not switched on while something is running:',
        ]),
        ...outcome.busy.map((b) => `  · ${b}`),
        '',
        ...(outcome.filterLeftDisabled ? [
          'The filter is switched OFF until then — your network works, iOS network control does not.',
          '',
        ] : []),
        'Stop them and run this again, or go ahead anyway:',
        '  tapflow migrate net-filter --ignore-running-devices',
      ])
      return 'failed'
    case 'refused-host-unknown':
      // The command whose whole purpose is this repair, so it has to explain why it will not do it.
      banner('error', 'CANNOT TELL WHAT THIS MAC IS RUNNING', [
        `Extension ${outcome.activated} is enforcing, but ${NET_FILTER_APP} is gone.`,
        'The extension version says which filter is running, not which app it came from, so tapflow',
        'cannot tell whether this Mac was set up by a newer tapflow than this one. Installing over it',
        'would replace a working filter somebody else depends on.',
        '',
        'Either reinstall from the tapflow whose version matches, or clear the extension and start over:',
      ])
      // **Outside the banner, because the banner wraps at 72 columns** and the first step carries a path
      // into the package that is longer than that. Wrapped, it is two lines nobody can paste.
      for (const s of removalSteps()) console.log(`${DIM}       ${s}${R}`)
      console.log()
      return 'failed'
    case 'refused-downgrade':
      banner('error', 'MIGRATION REFUSED', [
        `This Mac runs filter ${outcome.installed} and this tapflow carries ${outcome.shipped}.`,
        'Installing would replace a newer filter another tapflow on this Mac depends on.',
        'Upgrade this checkout instead.',
      ])
      return 'failed'
    case 'failed':
      banner('error', 'MIGRATION FAILED', [
        // "Did not finish", not "could not be installed": a failure while switching the filter on comes
        // after the install and the approval both succeeded.
        `The filter install did not finish (exit ${outcome.code}).`,
        outcome.detail,
        'packages/ios-agent/ios-netfilter/README.md has what each exit code means.',
        // **The state matters more than the failure.** A filter left off is a working Mac with no iOS
        // network control, and it stays that way silently — `doctor ios` reports versions, and every
        // version here is correct.
        ...(outcome.filterLeftDisabled ? [
          '',
          'The filter is switched OFF. Your network works; iOS network control does not.',
          'Run this again to turn it back on.',
        ] : []),
      ])
      return 'failed'
    default: {
      // **Kept although the switch now returns a value.** It returned void when `refused-host-unknown`
      // fell straight through it — printing nothing and exiting 0 in the one state the outcome was
      // invented for — and the explicit `never` is what stops that returning if the return goes away.
      const unhandled: never = outcome
      throw new Error(`unhandled install outcome: ${JSON.stringify(unhandled)}`)
    }
  }
}

/** `tapflow migrate net-filter` on its own: the step, with the exit code it has always had. */
export async function cmdMigrateNetFilter(opts: { ignoreRunningDevices?: boolean } = {}): Promise<void> {
  if (await runNetFilterMigration(opts) === 'failed') process.exit(1)
}

// ── `tapflow migrate` — every migration this install still needs, in one run ─────────────────────

/**
 * What a migration's check found. Only `pending` is run.
 *
 * `blocked` is a migration that is due but would fail every time it ran — two data directories side
 * by side is the one case today. Running it would stop the list on the same refusal forever, so it is
 * reported beside the list and left out of the exit code: nothing this command does can fix it.
 */
export type MigrationCheck =
  | { state: 'none' }
  | { state: 'pending'; summary: string }
  | { state: 'blocked'; reason: string }

export interface Migration {
  /** The subcommand that runs this one on its own. */
  id: string
  /** Reads only. Whatever it touches, it must not change it. */
  check(): MigrationCheck
  run(): Promise<StepResult>
}

/**
 * **Adding a migration is adding an entry here**, and the entry's `check` is the whole decision of
 * whether `tapflow migrate` offers it. Order is run order.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: 'data-dir',
    check() {
      const dir = resolveInstallDir().dir
      // A `.tapflow-data` holding only `jwt-secret` is what an older CLI left wherever it ran, not an
      // install's data (see `holdsInstallData`). Offering to move it would be offering to move nothing.
      if (!holdsInstallData(path.join(dir, LEGACY_DATA_DIR))) return { state: 'none' }
      if (fs.existsSync(path.join(dir, UNIFIED_DATA_DIR))) {
        return {
          state: 'blocked',
          reason: `${dir} has both .tapflow-data/ and .tapflow/data/. Keep the one with your data, remove the other, then run \`tapflow migrate data-dir\`.`,
        }
      }
      return { state: 'pending', summary: `Move ${path.join(dir, LEGACY_DATA_DIR)} into .tapflow/data/` }
    },
    run: runDataDirMigration,
  },
  {
    id: 'net-filter',
    check() {
      // Before any probe: `readNetFilterState` shells out to macOS tools that do not exist elsewhere.
      if (process.platform !== 'darwin') return { state: 'none' }
      const s = readNetFilterState()
      // **A filter that was never installed is not a pending migration.** It is an optional feature,
      // and `setup` counts declining it as done — offering it here would ask everyone who said no, and
      // install it unasked wherever no terminal is attached.
      if (s.shippedHost === null || s.shippedExt === null) return { state: 'none' }
      if (s.installedHost === null) {
        if (s.activatedExt === null) return { state: 'none' }
        // The app was deleted while its extension kept running. The installer refuses this rather than
        // guess which host the Mac had (`refused-host-unknown`), so it is reported, not run into.
        return {
          state: 'blocked',
          reason: `extension ${s.activatedExt} is running but ${NET_FILTER_APP} is gone. See \`tapflow doctor ios\`.`,
        }
      }
      // What the installer would refuse is left out rather than run into: a newer copy is another
      // checkout's to replace (`refused-downgrade`). Same for an extension newer than this package's.
      if (isNewer(s.installedHost, s.shippedHost)) return { state: 'none' }
      if (s.activatedExt !== null && s.shippedExt !== null && isNewer(s.activatedExt, s.shippedExt)) return { state: 'none' }
      // The installer's own test for "nothing to do" (`installNetFilter`), so the two cannot disagree.
      if (isNetFilterCurrent(s)) {
        return isFilterEnforcing() ? { state: 'none' } : { state: 'pending', summary: 'Turn the iOS network filter back on (installed, not filtering)' }
      }
      if (s.installedHost === s.shippedHost) return { state: 'pending', summary: 'Activate the iOS network filter this version carries' }
      return { state: 'pending', summary: `Update the iOS network filter (${s.installedHost} → ${s.shippedHost})` }
    },
    run: () => runNetFilterMigration(),
  },
]

/**
 * `tapflow migrate`: check every migration, show what is due, and run it.
 *
 * Asked once in a terminal; run without asking otherwise, as each subcommand already does. Stops at
 * the first failure with exit 1, and at a step the user backs out of with exit 0.
 */
export async function cmdMigrate(migrations: readonly Migration[] = MIGRATIONS): Promise<void> {
  const pending: { id: string; summary: string; run: () => Promise<StepResult> }[] = []
  for (const m of migrations) {
    const c = m.check()
    if (c.state === 'blocked') warn(`${m.id}: ${c.reason}`)
    if (c.state === 'pending') pending.push({ id: m.id, summary: c.summary, run: () => m.run() })
  }

  if (pending.length === 0) {
    banner('success', 'NOTHING TO MIGRATE', ['This install is up to date.'])
    return
  }

  console.log('\n  Pending migrations:')
  for (const p of pending) console.log(`    ${p.id.padEnd(12)}${p.summary}`)
  console.log('')

  if (isInteractive()) {
    const go = await confirm({ message: pending.length === 1 ? 'Run it?' : `Run all ${pending.length}?` })
    if (isCancel(go) || !go) {
      step('Cancelled — nothing was changed.')
      return
    }
  }

  for (const [i, p] of pending.entries()) {
    step(`${DIM}[${i + 1}/${pending.length}]${R} ${p.id}`)
    const result = await p.run()
    if (result === 'ok') continue
    const rest = pending.slice(i + 1).map((r) => r.id)
    if (rest.length > 0) step(`Not run: ${rest.join(', ')}. Run \`tapflow migrate\` again when ready.`)
    if (result === 'failed') process.exit(1)
    return
  }
}
