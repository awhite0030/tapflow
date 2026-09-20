---
"tapflow": minor
---

`tapflow setup` now exits 1 when it prints `SETUP INCOMPLETE`. It returned 0 whatever the banner said, so anything that chained on it — `tapflow setup ios && tapflow agent start`, a provisioning run, a Makefile — carried on against a Mac that was not set up. A person reads the banner and a script reads the code, and the two disagreed. This is stricter than `tapflow doctor`, which passes a check that only warns and so reports a Mac with no simulator runtime as fine — the two answer different questions, one whether the Mac is usable and one whether the work got done.

Only pending work counts. A step that reports a note while still being fine — the audio permission on a run that cannot ask, a host that is not macOS — leaves the run complete and the code 0. Declining an install at a prompt does count, because the environment is then just as unready as if nothing had asked.

The banner, the results list and the new-terminal hint all still print first.

Migrate: a script that should carry on past an incomplete setup needs `;` or `|| true` where it used `&&`, or `|| true` on the line itself under `set -e`.
