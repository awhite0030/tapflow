import fs from 'fs'
import path from 'path'

/**
 * **Where a build's file is now**, given the path stored when it was uploaded.
 *
 * `builds.file_path` is absolute, written once at upload (`api/builds.ts`). The data directory it
 * points into does not stay put: `tapflow migrate data-dir` renames it, an operator moves it or
 * changes `TAPFLOW_HOME`, a backup is restored on a host with a different home directory. Read
 * verbatim, every build uploaded before the move answered "may have been deleted — re-upload" while
 * its file sat intact in the new directory, and the expiry purge could not remove it (#836).
 *
 * So the file is looked for **in this install's `uploads/builds/` first**, by name, and at the stored
 * path only after. Names are unique — `<ms>-<uuid8>_<original>`, and before the UUID was added
 * `<ms>_<original>`, which could only collide within one directory anyway. This install's copy
 * wins over the stored path because a data directory copied rather than moved leaves the old one
 * behind: reading the stored path there would serve, and the purge would delete, another install's
 * files. On an install that never moved, the two are the same path.
 *
 * Nothing is written back. The stored value is left as it is, so the database format does not change
 * and an older relay reading the same database still sees what it wrote.
 *
 * Returns `null` when neither exists — the file really is gone, and the caller's own message says so.
 */
export function resolveBuildFile(stored: string, uploadsDir: string): string | null {
  // `basename` only, so a stored value cannot steer the lookup out of `builds/`. `isFile` rejects the
  // two names basename can still yield that are directories — `..` and the empty string.
  const local = path.join(uploadsDir, 'builds', path.basename(stored))
  for (const candidate of [local, stored]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // not here — try the next one
    }
  }
  return null
}
