---
"@tapflowio/ios-agent": minor
---

Stop attributing every flow on the Mac while nothing is offline, and record drops per device

The network filter ran its attribution walk on every new connection the Mac made, whoever it belonged
to, including while its rule was empty — which is most of the life of an installed filter. Measured on
a Mac with no device offline: 125,989 walks averaging 425.9µs, zero drops, and 96% of the flows
belonging to the Mac's own browser and mail. With an empty rule every branch allows, so none of it
could change a verdict.

Separately, the provider's state file proved that the rule had *arrived*, not that a device's traffic
had stopped — and a simulator whose flows consistently fail attribution keeps talking while that file
stays fresh and correct. The file now carries drops per device, which closes the gap in the one
direction it can: a drop was attributed by construction, so it proves enforcement. Zero drops proves
nothing, because an offline device that opens no connections drops nothing, so nothing reads it as
failure. It goes to the log; no control changes.
