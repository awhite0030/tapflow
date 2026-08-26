---
"@tapflowio/relay": minor
---

Add a restart control to the device toolbar

The network control can report `not-armed`, whose remedy the protocol states as "reboot the device" —
and there was no way to reboot a device from the session screen. `input:error`'s `not-booted` has the
same shape. The only route was back to the device list, which loses the session.

The control sits last in the Device group and asks before it fires, since the state a tester has built
up on the device does not come back. It restarts only: wiping stays on the selector screen.

`device:boot` on a running device does nothing on its own — the non-erase path issues a boot the
simulator ignores — so a restart is a `device:shutdown` followed by a `device:boot`. Both already
existed on the wire, so no agent, relay or protocol change was needed.
