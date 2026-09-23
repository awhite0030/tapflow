---
'tapflow': minor
'@tapflowio/relay': minor
---

**`tapflow migrate` runs every migration an install still needs.** It checks each one, lists what applies, asks once in a terminal and runs without asking elsewhere, and stops at the first failure with exit 1. Today that is `data-dir`, when the install has a `.tapflow-data/` with data in it, and `net-filter`, when the iOS network filter is installed but out of date or not filtering. A Mac that never installed the filter is left alone. `tapflow migrate data-dir` and `tapflow migrate net-filter` work as before.

**Builds still install after their data directory moves** ([#836](https://github.com/jo-duchan/tapflow/issues/836)). The relay stored each build's full path, so after `tapflow migrate data-dir` every build uploaded before it failed to install with "cannot read this build file", and expired ones were removed from the list while their files stayed on disk. The relay now finds the file in its current `uploads/builds/` first and falls back to the stored path.

`tapflow migrate data-dir` refuses while something is listening on the relay's port, since a running relay would put later uploads back into `.tapflow-data/`. It also rewrites `tapflow.config.json` before the move and puts it back if the move fails, where a config it could not write used to leave the data moved and the config pointing at the old directory.
