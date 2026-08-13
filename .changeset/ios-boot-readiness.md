---
'@tapflowio/ios-agent': patch
---

fix(ios-agent): wait for the simulator to finish booting before announcing device:ready

`simctl boot` returns when CoreSimulator has *accepted* the boot, not when the device reaches `Booted`, and
nothing waited for the difference. Measured on an iPhone 17 Pro / iOS 26.5: `xcrun simctl bootstatus` reported
`Finished` **7.6 seconds** after `boot` had already returned. `device:ready` went out inside that window, so it
announced something that was not yet true.

`SimctlWrapper.waitUntilBooted` polls the device list until the device reports `booted` and returns what it
read; `handleDeviceBoot` awaits it before `sendChromeData`, and a boot that never finishes ends as
`device:boot-error` at a 90s deadline rather than as a ready device that is not up.

Android has waited since the beginning (`EmulatorLauncher.waitForBoot` — `adb wait-for-device` plus a
`sys.boot_completed` poll, awaited on both boot paths), so this closes an asymmetry rather than adding a
policy. A human is slower than the gap and rarely notices; `mcp-server` installs and taps the moment it sees
`device:ready`, and #440's "app install intermittently fails with *No devices are booted*" was this — targeting
the session's udid removed one of its two causes and left this one, because the two were indistinguishable at
the time.

**Every status other than `booted` counts as still coming up, `shutdown` included.** `toDeviceStatus` collapses
`Booting` into `unknown`, and the wait only ever runs after `boot` was accepted, so a `shutdown` reading here is
the transition not having been observed yet. Failing on it would race a boot that was about to succeed. That
also keeps `DeviceStatus` alone: widening it to carry `booting` would change a union `agent-core` publishes and
the dashboard consumes, and the poll's exit condition never needed the distinction.

The status sent with the chrome data stops being hardcoded. It was `status: 'booted'` written over a value that
had just been fetched and discarded — a lie in the source that no consumer read, since `sendChromeData` uses
only `name`, `osVersion` and `typeId`. The behaviour is unchanged; what changes is that the value is now the one
that was observed.

The seq re-check after the wait is load-bearing, not defensive: this is another multi-second `await`, and
`sendChromeData` starts a helper process on the far side of it. A shutdown or a newer boot arriving in that gap
would otherwise install a self-reviving helper for the device it is taking down — the same shape #484 had to
add a check for after exactly this kind of gap.
