---
'@tapflowio/dashboard': patch
---

Fixed an issue where a screen reader would hear a restart begin but nothing after it by centralizing the device lifecycle status region in the DeviceViewer so that it outlives the skeleton and platform viewer component transitions.
