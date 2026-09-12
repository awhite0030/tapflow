---
"@tapflowio/android-agent": patch
---

Throw an explicit boot error when an emulator vanishes during video setup instead of returning silently and reporting the device as ready.
<!-- changelog: internal — fixes a race condition where a killed emulator is reported as ready without video -->
