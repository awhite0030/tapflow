---
"tapflow": patch
---

fix(cli): treat a session as interactive only when both stdin and stdout are terminals

This prevents prompts in `tapflow setup` from waiting indefinitely when reading from an empty stdin under a terminal (e.g. `tapflow setup ios </dev/null`).
