---
"@tapflowio/cli": patch
---

fix(cli): allow `setup` to proceed non-interactively when stdin is not a terminal

`setup` determines if it can run interactively. It previously relied entirely on `process.stdout.isTTY`, but when stdin was not a terminal (e.g. `tapflow setup ios </dev/null`), prompts were still drawn without being able to be answered, causing an exit code of 0 without progress. `setup` now appropriately ensures both `stdout` and `stdin` are TTYs.

<!-- changelog: internal — reason -->
