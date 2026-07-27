---
"@tapflowio/android-agent": patch
---

Fix Cmd/Ctrl+C, +V and +X on Android — they typed the letter instead of copying.

The key handler ignored the Ctrl/Meta modifier and typed the raw character, so pressing Cmd+C in the viewer entered a literal `c` into the app and copy and paste both failed silently. A Ctrl/Cmd chord with C, V or X now maps to `KEYCODE_COPY` / `KEYCODE_PASTE` / `KEYCODE_CUT`.

Any other chord with a letter — Cmd+A, for one — no longer types that letter either. A chord is a command, not text.
