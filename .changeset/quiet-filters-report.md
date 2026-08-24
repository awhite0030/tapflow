---
"@tapflowio/ios-agent": patch
---

Let tapflow tell when the iOS network filter is not actually running (#639, #641, #642).

Taking an iOS simulator off the network needs a system extension on your Mac, and nothing checked
that it was still there and doing its job. The control decided from evidence inside the app instead
— so a filter that had been disabled, crashed, or never approved left the toggle reporting a device
as offline while its traffic kept flowing. That is the one failure this feature exists to prevent,
and it was invisible.

The filter now leaves a small status file saying what it is currently enforcing, refreshed every
few seconds and removed when it stops. Missing, or several beats old, means it is not enforcing —
and both cases were measured rather than assumed: killing it freezes the file, and macOS brings it
back about seven seconds later.

Two other things came out of the same work. **Changing a device's network no longer asks macOS to
re-install the extension every time** — installation and configuration were one code path, so a
toggle that only needed to write a setting was requesting a system extension replacement, which can
hang. And a flow the filter cannot attribute to any simulator is now counted and logged separately
from ordinary Mac traffic; it is still allowed through, deliberately, because refusing on a
transient lookup failure would cut your own browser — but it is no longer invisible.
