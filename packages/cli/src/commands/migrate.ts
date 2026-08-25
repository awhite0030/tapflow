import { banner } from '../lib/print.js'
import { migrateDataDir } from '../lib/migrate-data-dir.js'
import { installNetFilter, NET_FILTER_APP } from '../lib/net-filter.js'

// `tapflow migrate data-dir` — one-shot move of a legacy .tapflow-data/ into the unified .tapflow/data/.
export function cmdMigrateDataDir(): void {
  const result = migrateDataDir(process.cwd())
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
    case 'exdev':
      banner('error', 'CROSS-FILESYSTEM MOVE', [
        '.tapflow-data/ and .tapflow/data/ are on different filesystems, so an atomic move is not possible.',
        'Move it by hand: mv .tapflow-data .tapflow/data',
        'Then set local.dataDir to .tapflow/data in tapflow.config.json if it was pinned to the old path.',
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
export function cmdMigrateNetFilter(): void {
  const outcome = installNetFilter()
  switch (outcome.status) {
    case 'installed':
      banner('success', 'NETWORK FILTER INSTALLED', [
        `Installed to ${NET_FILTER_APP} and activated.`,
        'iOS network control is available now: tapflow doctor ios',
      ])
      return
    case 'already-current':
      banner('success', 'ALREADY UP TO DATE', ['The Mac is already running the filter this tapflow carries.'])
      return
    case 'needs-approval':
      banner('success', 'APPROVAL NEEDED', [
        `Installed to ${NET_FILTER_APP}, and macOS is waiting for you to allow it.`,
        'System Settings → General → Login Items & Extensions → Network Extensions, and switch tapflow on.',
        'Then check it took: tapflow doctor ios',
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
        'This tapflow install carries no filter app, so there is nothing to migrate.',
        'Reinstalling tapflow restores it.',
      ])
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
        `The filter could not be installed (exit ${outcome.code}).`,
        outcome.detail,
        'packages/ios-agent/ios-netfilter/README.md has what each exit code means.',
      ])
      process.exit(1)
      break
  }
}
