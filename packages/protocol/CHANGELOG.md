# @tapflowio/protocol

## 0.18.0

### Minor Changes

- 7637be3: Add `@tapflowio/protocol`, one wire contract for the WebSocket messages exchanged between browser, relay and agents, and type every place that originates a message against it.

  Nothing checked those messages before. The relay built them as inline object literals passed to `JSON.stringify`, the dashboard's `send()` took `object`, and mcp-server's took `Record<string, unknown>` — so the definitions each package kept were descriptions, not contracts, and three of them had already drifted from the wire:

  - `stream:request-idr` was sent by the relay from two places while absent from its own `MessageType`.
  - `input:key` was documented as `payload: { key: string }`. Every sender and both agents use `{ code, modifiers }`, with `modifiers` a HID bitmap — so the field name and the type were both wrong.
  - `input:touch:end` and `app:clear-state` carried payloads from mcp-server that no definition mentioned.

  All three are fixed by the contract now describing what actually travels. The relay's 25 originating sends go through a typed `sendTo`, which also folds in the `readyState` check that was repeated at most call sites and missing at some. `Session.chromeData` is `ChromePayload` rather than `unknown`; the relay still only stores and forwards it, but a new platform now extends the union instead of the relay.

  No message changed shape on the wire. This is types only, and `@tapflowio/protocol` emits no runtime code — consumers import it with `import type`, so nothing reaches a browser bundle.

- 273c016: Tell an open dashboard tab when its session ends because the agent went away, instead of leaving it to spin.

  Restarting a device agent used to orphan the viewer: the relay deleted the session, the browser kept a live socket addressed to a `sessionId` that no longer existed, and everything it sent was dropped as unknown. The tab sat on `Waiting for first frame...` forever with no message, and only a manual page refresh recovered it.

  The relay now sends `session:terminated` (with `reason: 'agent-disconnected'`) to whoever is attached, before removing the session — after removal the socket reference is gone. The viewer reports it upward and the dashboard returns to the Mac list with an explanation, then refreshes the agent list immediately so picking the same Mac again does not try to join the dropped session.

  The relay also logs one line when an agent connects and one when it disconnects. It previously printed `Waiting for agents...` at startup and then said nothing either way, so a terminal gave no signal about whether an agent was attached.

  This is the first half of the fix. Rebinding the tab to the restarted agent's new session — so a restart is invisible rather than merely announced — is tracked separately.

### Patch Changes

- 2aebd34: Make an agent restart survivable for the tab that is watching (#426).

  The relay could already re-point a session at a restarted agent's socket (#458), but the trigger almost never fired. It required the old socket to still be registered when the new one arrived, and on a restart it never is: the close is processed in under 400 ms while a new agent takes about a second to register. Measured on a real simulator — the tab got the same bounce to the Mac list it got before any of this existed.

  So a closed agent socket no longer ends its sessions on the spot. They are held for 15 seconds (`TAPFLOW_AGENT_GRACE_MS`), which is long enough for the agent to come back and reclaim them, and the tab keeps its place. If it does not come back the window closes and the session ends exactly as before.

  The sessions stay where they are rather than moving to a holding area of their own — a returning agent is found by walking the sessions and reading the socket each one points at, so a session parked anywhere else could never be reclaimed.

  **`session:agent-away`** tells an attached viewer what is going on. Without it the tab would sit on a picture that stopped updating for the length of the window, which is the complaint #426 was opened with. The viewer drops the frame and says the agent went away; whichever answer follows — reconnected, or ended — replaces it. A genuinely dead agent is now better reported than before, not worse: the wait is explained, and only the news that it is over arrives later.

  Also, while an agent is away:

  - **Its devices are not offered.** A held session is not something anyone can pick, and listing it would draw a Mac card carrying the dead agent's last CPU and memory reading with no warning attached — the existing staleness badge keys off a 30-second-old sample, far longer than the window. It also prevents a duplicate card when a returning agent identifies itself differently, which is what happens when the upgrade that prompted the restart is the one that starts sending a machine id.
  - **Joining says so.** The join is allowed and answered with `session:agent-away`, rather than refused. Refusing looked simpler and was a trap: the viewer sends `session:start` once per reconnect and ignores a plain error, so a browser blip inside the window would strand the tab past any recovery.
  - **Nothing from the previous process is replayed** to a viewer that joins — its chrome, device info and readiness all describe an agent that is gone.
  - `device:boot` for a held session answers `agent offline` rather than `Session not found`. The id is valid, and retrying in a moment may well work.
  - A device that comes back under a different identity — which is what happens when the upgrade prompting the restart is the one that starts sending a machine id — ends the held session immediately rather than making its viewer wait out a window for a device that is demonstrably present.

  `agents:listed` has three other consumers, and a restarting Mac's devices are absent from all of them for the length of the window: `tapflow status` reads as no agents connected, and a one-shot `list_devices` over MCP or flow-runner returns nothing. Retrying after the window gives the normal answer. Shortening `TAPFLOW_AGENT_GRACE_MS` narrows it.

- f4235e5: Make app install/launch failures reach the caller that asked.

  Three paths through `handleBrowserAppInstall` / `handleBrowserAppLaunch` ended without a usable answer: an unknown session got a generic `error` with no `sessionId`, a missing build or bundle id got an app-specific error also without one, and an agent whose socket was not open got nothing at all — the `if` had no `else`. A dashboard viewer holds one session per socket, so an unattributed error still lands somewhere sensible and a human sees it. An MCP caller waits for the reply carrying its own `sessionId`, so all three looked the same from there: silence until the deadline. The caller was told "timed out" when the truth was "that build has no bundle ID".

  - **relay**: every exit from both handlers carries the request's `sessionId`, including `Session not found` — a generic `error` cannot be correlated by construction. An unreachable agent is answered immediately instead of being left to time out, matching what `open-url` and `clipboard:read` already do.
  - **relay**: `device:boot` gets the same treatment. A boot the agent never receives used to leave the viewer on "Waiting for first frame…" with nothing said. `device:shutdown` stays fire-and-forget — nothing waits on it, and inventing a reply type for it would grow the contract for a message no one reads.
  - **protocol**: `app:install-error` and `app:launch-error` now declare `sessionId` as required, and `device:boot-error` joins `RelayToBrowser`. Because `sendTo` is typed against that union, an omission at those call sites is a compile error rather than a silent gap. Messages the relay merely forwards, and the agents' own raw literals, stay outside that check — and nothing yet validates an inbound `sessionId` (#444), so this is a much tighter contract than before rather than an airtight one.
  - **relay**: `buildId` is checked before it reaches the query. `JSON.parse` does not honour `RelayMessage`, and an object or array there makes the driver throw — an exception the message loop used to swallow alongside genuine parse failures, leaving the caller with nothing. That loop no longer catches a parse failure and a routing failure in the same block, and it rejects payloads that are valid JSON but not messages (`null`, numbers, strings) before routing reads a field off them.
  - **dashboard**: the viewer ignores messages addressed to another session, and its local union carries the new field. Adding `sessionId` without a consumer that reads it would not have fixed a correlation bug.

- a391b85: Teach the viewer to recover from an agent restart — the receiving half.

  Restart a device agent today and the tab is told `session:terminated` and sent back to the Mac list. That is better than the silence it replaced (#446), but it makes the tester redo navigation for something that should be invisible.

  `session:rebound` is the message that will carry the alternative: the relay keeps the session, re-points it at the new agent socket, and tells the viewer to ask for its device back. The relay cannot restart the stream itself — the codec negotiation and the downscale tier ride in the browser's own `device:boot` payload and exist nowhere the relay can see.

  **No behaviour changes yet.** Nothing sends `session:rebound`; the relay half is the next PR (#426). This lands first because the reverse order would leave the tab worse than today: the viewer would drop the unknown message, and since `device:boot` is only re-sent from the `session:joined` branch, there would be no recovery path at all — a frozen frame that looks live until someone refreshes.

  On receipt the viewer tears down first, then re-boots:

  - Clears what a restart invalidates, including three flags `device:booting` never touches — `launching`, `swKeyboardPending`, `swKeyboardVisible`. Their acknowledgements died with the old agent. This was unreachable before: a dead agent unmounted the viewer, so nothing could outlive it.
  - Re-sends `device:boot` carrying `app-only`, never a reset. A restart is not a request to erase the device (#439).
  - Skips the reinstall when the build was already on the device. The simulator stayed up across the restart, and reinstalling would kill the app state the recovery exists to preserve. The skip cannot key off `installed` at that point — `device:booting` clears that flag and the agent sends it on every boot, so it is always false by the time `device:ready` arrives — so the state is captured when the rebind starts.
  - Restores `installed` when it skips. That flag gates the Launch control, and without `app:install-done` to set it the tester would silently lose the button.
  - Installs anyway when the rebind interrupted an install. An agent is at its most fragile mid-install, and there the app really is absent — skipping would leave a Launch button for something that is not on the device.
  - Counts pending rebinds rather than flagging one. A crash-looping agent rebinds repeatedly, each with its own boot and its own `device:ready`; a flag is spent by the first, and the second reinstalls. The count is also reset by `session:joined` and `device:boot-error`, so a rebind whose agent never answers cannot absorb a later ordinary boot and suppress installs for the rest of the mount.

  Also names the Launch button on both platforms. It was icon-only with no accessible name, so screen-reader and voice-control users had no way to reach it.
