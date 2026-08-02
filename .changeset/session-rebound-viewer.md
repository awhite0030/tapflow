---
"@tapflowio/protocol": patch
"@tapflowio/dashboard": patch
---

Teach the viewer to recover from an agent restart — the receiving half.

Restart a device agent today and the tab is told `session:terminated` and sent back to the Mac list. That is better than the silence it replaced (#446), but it makes the tester redo navigation for something that should be invisible.

`session:rebound` is the message that will carry the alternative: the relay keeps the session, re-points it at the new agent socket, and tells the viewer to ask for its device back. The relay cannot restart the stream itself — the codec negotiation and the downscale tier ride in the browser's own `device:boot` payload and exist nowhere the relay can see.

**No behaviour changes yet.** Nothing sends `session:rebound`; the relay half is the next PR (#426). This lands first because the reverse order would leave the tab worse than today: the viewer would drop the unknown message, and since `device:boot` is only re-sent from the `session:joined` branch, there would be no recovery path at all — a frozen frame that looks live until someone refreshes.

On receipt the viewer tears down first, then re-boots:

- Clears what a restart invalidates, including three flags `device:booting` never touches — `launching`, `swKeyboardPending`, `swKeyboardVisible`. Their acknowledgements died with the old agent. This was unreachable before: a dead agent unmounted the viewer, so nothing could outlive it.
- Re-sends `device:boot` carrying `app-only`, never a reset. A restart is not a request to erase the device (#439).
- Skips the reinstall. The simulator stayed up across the restart and the build is still on it; reinstalling would kill the app state the recovery exists to preserve. The skip cannot key off `installed` — `device:booting` clears that flag and the agent sends it on every boot, so it is always false by the time `device:ready` arrives — so it uses a ref released on `device:ready` and on `device:boot-error`.
- Restores `installed` when it skips. That flag gates the Launch control, and without `app:install-done` to set it the tester would silently lose the button.
