---
"tapflow": patch
---

<!-- changelog: internal — fix setup hanging when stdin is not a terminal -->
Fix `setup` command hanging when `stdin` is not a terminal by properly checking both `stdout` and `stdin` for `isTTY`.
