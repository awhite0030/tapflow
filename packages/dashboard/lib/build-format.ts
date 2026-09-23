import type { Build } from '@/lib/types'

export const STATUS_TONE = {
  Backlog:       'backlog',
  'In Progress': 'progress',
  Done:          'done',
  Rejected:      'rejected',
} as const satisfies Record<string, 'backlog' | 'progress' | 'done' | 'rejected'>

export function buildLabel(build: Build): string {
  if (build.version_name && build.build_number) return `${build.version_name} · build ${build.build_number}`
  return build.version_name ?? build.version_label ?? (build.build_number ? `build ${build.build_number}` : 'Build')
}

/**
 * A row's name for every control on it, so a screen reader hears which build a control acts on and
 * voice control can address one row. **The build number alone does not identify a row**: a release
 * groups by `version_name` only, so an iOS and an Android build with the same number sit in one
 * accordion, and iOS restarts numbering per version. The DB id was tried first and was worse — the
 * row renders "build —", so it named something nobody can see or say.
 */
export function buildRowName(build: Build): string {
  return `${build.platform} build ${build.build_number ?? 'without a number'}, ${build.version_name ?? 'Unversioned'}`
}

function deletionMs(deleteAfter: string): number {
  // SQLite datetime() returns naive UTC ("YYYY-MM-DD HH:MM:SS") — append Z so it isn't read as local time.
  const hasTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(deleteAfter)
  return new Date(hasTz ? deleteAfter : deleteAfter.replace(' ', 'T') + 'Z').getTime() - Date.now()
}

// delete_after is the absolute purge time; the countdown is independent of review status (#258).
export function formatDeletionCountdown(deleteAfter: string): { label: string; urgent: boolean } {
  const diff = deletionMs(deleteAfter)
  if (diff <= 0) return { label: 'Deleting…', urgent: true }
  const h = Math.floor(diff / 3_600_000)
  if (h < 1) return { label: 'Deletes in < 1h', urgent: true }
  if (h < 24) return { label: `Deletes in ${h}h`, urgent: h < 6 }
  return { label: `Deletes in ${Math.floor(h / 24)}d`, urgent: false }
}

/**
 * The same countdown in words, for an announcement — "7d" is read out as "7 d".
 *
 * **Rounded, not floored**, because this is said right after scheduling: the relay answers
 * `datetime('now', '+7 days')`, truncated to the second and a round trip old by the time it is read,
 * so the remaining time is always a little under seven days and flooring announced "in 6 days".
 */
export function describeDeletionCountdown(deleteAfter: string): string {
  const diff = deletionMs(deleteAfter)
  if (diff <= 0) return 'now'
  if (diff < 3_600_000) return 'within an hour'
  const h = Math.round(diff / 3_600_000)
  if (h < 24) return `in ${h} hour${h === 1 ? '' : 's'}`
  const d = Math.round(diff / 86_400_000)
  return `in ${d} day${d === 1 ? '' : 's'}`
}
