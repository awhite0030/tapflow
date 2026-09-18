---
"tapflow": patch
---

Fix tapflow setup exiting silently on empty stdin by checking both stdin and stdout for TTY.
