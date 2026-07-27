---
"@tapflowio/ios-agent": patch
---

Fix iOS sessions that silently dropped every tap, swipe and keystroke after an agent reconnect.

The input channel was created only during `device:boot`. When an agent reconnected while the simulator stayed booted, the session came back without one, so touch, pinch, key and button input were discarded with no error — the device looked responsive because screenshots and UI-tree reads went through a different path. Input now sets the channel up on demand.

Buttons addressed by name still need a fresh `device:boot`; that is a narrower gap tracked separately.
