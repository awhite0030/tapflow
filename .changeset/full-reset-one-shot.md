---
"@tapflowio/dashboard": patch
"@tapflowio/ios-agent": patch
---

Fix Full reset erasing devices nobody asked to erase, and failing on the ones people did.

Two defects that were only safe together. `resetMode` lived in a `useState` that nothing reset: leaving a session with `← All Macs` is a conditional re-render, not an unmount, so an armed toggle survived it and the *next* device the tester picked was erased too. Separately, `IOSAgent` called `simctl erase` without checking device state, and `erase` refuses a booted device — so an explicit Full reset on a device that was already running died with `Boot failed: Command failed: xcrun simctl erase <udid>`.

The second was containing the first: the unwanted erase usually targeted a booted device, so it threw and destroyed nothing. Fixing only the agent would have turned that loud failure into silent data loss, so both move together.

- **dashboard**: Full reset is now a one-shot intent — arming it applies to the next device you pick and then disarms itself. Asking twice means turning it on twice. The mode the viewer was launched with is held separately from the toggle, so disarming does not disturb the running session.
- **dashboard**: only the first `device:boot` of a viewer mount carries the reset. `session:joined` arrives again on every socket reconnect, so a Wi-Fi blip or a sleeping laptop would otherwise re-erase the device the tester is looking at, with no click involved.
- **ios-agent**: shut a running device down before erasing it, so an explicit Full reset works whatever state the device is in. The request is never silently skipped.

Android is unaffected — `AndroidAgent` does not read `resetMode` (#447).
