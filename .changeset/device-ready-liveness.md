---
"@tapflowio/relay": patch
---

Stop telling a viewer a device is ready when nothing is streaming.

The relay replays `device:ready` when a browser joins, so a tab that lost its socket mid-session gets a picture back without waiting for another boot. The condition for that replay was `deviceStatus === 'booted'` — and `deviceStatus` starts life as the agent's `simctl list` snapshot at registration. Since the relay opens a session for every device an agent reports, a simulator somebody left running had a session marked booted before the agent had done anything with it. Joining that session produced a `device:ready` with no stream behind it.

The replay now keys off whether this session announced a stream and has not since taken it back, tracked separately from the device's own state. `deviceStatus` is unchanged and still answers "is this device up" for the device list and the REST guards — the two questions were sharing one field.

Also released when a reboot starts and when the stream socket goes away. `device:booting` already cleared the cached chrome for the same reason, and a browser joining mid-boot should not be promised a stream that is being torn down. The stream socket matters because the agent does not always get to report the end: `handleDeviceShutdown` tears the streamer down before running `simctl shutdown`, and if that throws, no `device:shutdown-done` is ever sent.
