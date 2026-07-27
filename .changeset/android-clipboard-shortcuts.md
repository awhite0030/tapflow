---
"@tapflowio/android-agent": patch
---

Fix the copy, paste and cut shortcuts on Android — they typed the letter instead.

The key handler ignored the Ctrl/Meta modifier and typed the raw character, so pressing Cmd+C in the viewer entered a literal `c` into the app — copy, paste and cut all failed silently. A Ctrl/Cmd chord with C, V or X now maps to `KEYCODE_COPY` / `KEYCODE_PASTE` / `KEYCODE_CUT`.

Any other chord with a letter — Cmd+A, for one — no longer types that letter either. A chord is a command, not text.
