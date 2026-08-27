---
"@tapflowio/ios-agent": patch
---

Two ways the iOS network filter reported itself wrong, both found by measuring rather than reading.

**Installing an update to the filter stopped silently.** Replacing an installed system extension makes macOS ask the app which one to keep, and the object that answers was being collected before the question arrived — `OSSystemExtensionRequest.delegate` is a weak reference and nothing else held it. No callback of any kind then fired, so the only thing left to report was a timeout, which is why this was recorded three separate times as a failure with no known cause. It only ever affected an update, never a first install, because a first install has nothing to ask about.

**And the filter's status file never came back after the filter was turned off and on again.** Taking a device off the network needs that file — it is how tapflow knows the filter is really running — and it is deliberately removed when the filter stops. The flag that suppressed it was never cleared, so from the first stop onward the file stayed missing for as long as the extension's process lived, while the filter went on filtering. Nothing reads that file yet, so this was not something anyone could have seen — it would have become visible as the exact failure the file was added to catch, pointed the other way: a device reported as beyond tapflow's control while its traffic really was being dropped.
