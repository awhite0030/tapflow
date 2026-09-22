import { banner, step, DIM, R } from '../lib/print.js'
import { migrateDataDir } from '../lib/migrate-data-dir.js'
import {
  installNetFilter, followThroughApproval, offerApprovalUpFront, APPROVAL_PATH, INSTALL_STAGE_MESSAGE, CONFIRM_DEADLINE_MS,
  NET_FILTER_APP, removalSteps, type InstallOptions,
} from '../lib/net-filter.js'
import { terminalApprovalDeps } from '../lib/approval-prompt.js'

// `tapflow migrate data-dir` — one-shot move of a legacy .tapflow-data/ into the unified .tapflow/data/.
export async function cmdMigrateDataDir(): Promise<void> {
  const result = await migrateDataDir(process.cwd())
  switch (result.status) {
    case 'migrated': {
      const lines = ['Moved .tapflow-data/ → .tapflow/data/.']
      if (result.configUpdated) lines.push('Repointed local.dataDir in tapflow.config.json.')
      if (result.gitignoreUpdated) lines.push('Added the runtime paths to .gitignore.')
      lines.push('Start tapflow as usual: tapflow start')
      banner('success', 'DATA DIRECTORY MIGRATED', lines)
      return
    }
    case 'noop-already':
      banner('success', 'ALREADY MIGRATED', ['.tapflow/data/ is in place and no legacy .tapflow-data/ remains.'])
      return
    case 'noop-no-legacy':
      banner('success', 'NOTHING TO MIGRATE', ['No legacy .tapflow-data/ found in this directory.'])
      return
    case 'conflict':
      banner('error', 'MIGRATION BLOCKED', [
        'Both .tapflow-data/ (legacy) and .tapflow/data/ exist.',
        'Reconcile by hand — keep the directory with your real data, remove the other, then re-run.',
      ])
      process.exit(1)
      break

    case 'relay-running':
      banner('error', 'RELAY IS RUNNING', [
        `The relay is currently running on port ${result.port}.`,
        'Stop the relay before migrating the data directory.'
      ])
      process.exit(1)
      break
    case 'exdev':
      banner('error', 'CROSS-FILESYSTEM MOVE', [
        '.tapflow-data/ and .tapflow/data/ are on different filesystems, so an atomic move is not possible.',
        'Move it by hand: mv .tapflow-data .tapflow/data',
        'Then set local.dataDir to .tapflow/data in tapflow.config.json if it was pinned to the old path.',
      ])
      process.exit(1)
      break
    case 'config-unwritable':
      banner('error', 'CONFIG IS UNWRITABLE', [
        'Could not update local.dataDir in tapflow.config.json.',
        'The data directory was not moved.',
        'Fix the file permissions and try again, or migrate by hand.'
      ])
      process.exit(1)
      break
  }
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
export async function cmdMigrateNetFilter(opts: { ignoreRunningDevices?: boolean } = {}): Promise<void> {
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
    return
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
      return
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
      process.exit(1)
      break
    case 'already-current':
      banner('success', 'ALREADY UP TO DATE', ['The Mac is already running the filter this tapflow carries.'])
      return
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

      return
    case 'needs-reboot':
      banner('success', 'RESTART TO FINISH', [
        'Installed. macOS replaces a running filter only on restart, so the previous version keeps running until then.',
        'Restart the Mac, then: tapflow doctor ios',
      ])
      return
    case 'not-macos':
      banner('success', 'NOTHING TO MIGRATE', ['The iOS network filter is macOS only.'])
      return
    case 'no-artifact':
      banner('error', 'NO FILTER TO INSTALL', [
        'This tapflow install carries no usable filter app, so there is nothing to migrate.',
        'Reinstalling tapflow restores it.',
      ])
      process.exit(1)
      break
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
      process.exit(1)
      break
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
      process.exit(1)
      break
    case 'refused-downgrade':
      banner('error', 'MIGRATION REFUSED', [
        `This Mac runs filter ${outcome.installed} and this tapflow carries ${outcome.shipped}.`,
        'Installing would replace a newer filter another tapflow on this Mac depends on.',
        'Upgrade this checkout instead.',
      ])
      process.exit(1)
      break
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
      process.exit(1)
      break
    default: {
      // **The compiler cannot see a missing case here, and that is why this line exists.** `setup`'s
      // switch returns a value, so an unhandled member is a type error there; this one returns void,
      // and `refused-host-unknown` fell straight through it — printing nothing and exiting 0 in the
      // one state the outcome was invented for.
      const unhandled: never = outcome
      throw new Error(`unhandled install outcome: ${JSON.stringify(unhandled)}`)
    }
  }
}
