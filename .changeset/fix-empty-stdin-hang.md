---
"tapflow": patch
---

Fix tapflow setup hanging when stdin is not a terminal by checking process.stdin.isTTY alongside process.stdout.isTTY.
