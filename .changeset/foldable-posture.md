---
'@tapflowio/protocol': minor
'@tapflowio/agent-core': minor
'@tapflowio/android-agent': minor
'@tapflowio/relay': minor
---

Foldable devices. Taps now land where you press them on a device whose display is rotated — the emulator's gRPC input takes coordinates in the display's natural orientation, and the viewer normalises against the rotated picture it is showing, so the two axes were swapped on every unfolded foldable. A toolbar control folds and unfolds the device, and the device frame follows the screen when it changes. `PosturableAgent` (`agent-core`) and the `input:posture` / `device:postures` messages carry it, with posture ids and labels owned by the platform so a device that folds differently needs no change outside its own agent.
