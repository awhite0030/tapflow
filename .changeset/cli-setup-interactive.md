---
"tapflow": patch
---

Fix `setup` command hanging when `stdin` is not a terminal by properly checking both `stdout` and `stdin` for `isTTY`.
