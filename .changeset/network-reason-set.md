---
"@tapflowio/protocol": patch
"@tapflowio/ios-agent": patch
"@tapflowio/android-agent": patch
"@tapflowio/relay": patch
---

Split the network-control reason set so each member carries a remedy, and confirm that a simulator's rule is actually being enforced before reporting it offline.

`unsupported-device` now means only what it says — the write was accepted, the read-back succeeded, and the device had not moved. Every other Android failure is `state-unconfirmed`, which a retry may fix. Two iOS members are new: `filter-unavailable` for a Mac that cannot take devices offline, and `enforcement-lost` for enforcement that stopped underneath a device that was already offline.

On iOS the rule is now confirmed over XPC before the other layers are applied, and a request that cannot be confirmed is refused rather than half-applied — applying the app-facing layers alone tells an app it is offline while its requests keep succeeding. Enforcement is watched while any device is offline, so an outage that used to pass silently is reported instead of leaving a tester signing off on requests that succeeded.

The dashboard says what to do per reason, stops offering a retry where a retry cannot help, and interrupts rather than re-colouring when a finished check has been invalidated.
