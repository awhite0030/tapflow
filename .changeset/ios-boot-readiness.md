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

**Three readings get three answers.** `unknown` is a device in motion — `toDeviceStatus` collapses `Booting`
into it — so it gets the whole deadline. `shutdown`, or gone from the list, is what a device looks like when
nothing is bringing it up, so it gets a 3s grace and no more: the handler skips `boot` entirely when the device
was already `booted` when it read the list, and a shutdown landing in that window leaves nobody booting
anything. A **failed** reading is not a reading at all — this spawns `xcrun simctl list` up to 180 times where
the old code spawned it once, each an independent chance to kill a healthy boot during the interval when
CoreSimulator is busiest, so failures are retried and the last one is reported with the deadline. Android's poll
has always swallowed them.

The wait also takes an `isStale` signal, checked every iteration. `handleDeviceBoot` is fire-and-forget and its
`bootSeq` check runs only once the wait returns, so a shutdown arriving mid-wait would otherwise leave a poll
spawning a process twice a second, for the rest of the deadline, against a device that is now deliberately off
and will never converge.

`DeviceStatus` is left alone throughout: widening it to carry `booting` would change a union `agent-core`
publishes and the dashboard consumes, and the poll's exit condition never needed the distinction.

The status sent with the chrome data stops being hardcoded. It was `status: 'booted'` written over a value that
had just been fetched and discarded — a lie in the source that changes nothing observable, because
`sendChromeData` reads `id`, `name`, `osVersion` and `typeId` and never `status`. What changes is that the value
is now the one that was observed.

**Known gap, not addressed here:** `mcp-server`'s `boot_device` waiter has a 30s deadline
(`client.ts`), which now sits *inside* the agent's 90s one. A cold or full-erase boot past 30s
reports a bare timeout to the LLM rather than the reason the agent is about to send. Before this change that
ceiling was unreachable, because the agent answered as soon as the boot was accepted — with the answer that
`No devices are booted` came from. Raising it belongs with the `mcp-server` client rather than here.

The seq re-check after the wait is load-bearing, not defensive: this is another multi-second `await`, and
`sendChromeData` starts a helper process on the far side of it. A shutdown or a newer boot arriving in that gap
would otherwise install a self-reviving helper for the device it is taking down — the same shape #484 had to
add a check for after exactly this kind of gap.
