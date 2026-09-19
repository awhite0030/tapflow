---
'@tapflowio/protocol': minor
'@tapflowio/agent-core': minor
'@tapflowio/android-agent': minor
'@tapflowio/relay': minor
---

Foldable devices. Taps now land where you press them on a device whose display is rotated — the emulator's gRPC input takes coordinates in the display's natural orientation, and the viewer normalises against the rotated picture it is showing, so the two axes were swapped on every unfolded foldable. Folded, they also land in the right place: the emulator scales injected touch pixels by its own display size, which stays at the unfolded panel's, so scaling by the panel the guest reports sent every tap 1.92x too far across. A toolbar control folds and unfolds the device, keeping the orientation you were in, and the device frame follows the screen when it changes. A session starts unfolded and upright rather than inheriting whatever the last one left. Screenshots and recordings save the picture on screen rather than the frame behind it — the emulator captures a foldable's panel in its own fixed orientation, so an unfolded device was portrait on screen and landscape in the file, with the cursor overlay a quarter turn from the finger. `PosturableAgent` (`agent-core`) and the `input:posture` / `device:postures` messages carry it, with posture ids and labels owned by the platform so a device that folds differently needs no change outside its own agent.
