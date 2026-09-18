---
"tapflow": patch
---

Fixed an issue where `tapflow setup` prompts would hang indefinitely when run with a non-interactive standard input. It now requires both stdout and stdin to be a TTY before treating the session as interactive.

<!-- changelog: internal — bugfix for prompt hang under specific stdin conditions -->
