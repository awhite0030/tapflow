---
'@tapflowio/protocol': patch
'@tapflowio/relay': patch
---

fix: answer device:shutdown with bad payload

A malformed device:shutdown request is now answered with a device:shutdown-error rather than dropped silently, matching the behaviour of other answerable commands.
