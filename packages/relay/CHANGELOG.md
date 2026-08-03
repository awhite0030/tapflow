# @tapflowio/relay

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

- 76a00e7: Stop telling a viewer a device is ready when nothing is streaming.

  The relay replays `device:ready` when a browser joins, so a tab that lost its socket mid-session gets a picture back without waiting for another boot. The condition for that replay was `deviceStatus === 'booted'` — and `deviceStatus` starts life as the agent's `simctl list` snapshot at registration. Since the relay opens a session for every device an agent reports, a simulator somebody left running had a session marked booted before the agent had done anything with it. Joining that session produced a `device:ready` with no stream behind it.

  The replay now keys off whether this session announced a stream and has not since taken it back, tracked separately from the device's own state. `deviceStatus` is unchanged and still answers "is this device up" for the device list and the REST guards — the two questions were sharing one field.

  The flag is cleared on three events: `device:shutdown-done`, `device:booting`, and the stream socket closing.

  `device:booting` already cleared the cached chrome for the same reason — a browser joining mid-boot should not be promised a stream that is being torn down. The stream socket matters because the agent does not always get to report the end: `handleDeviceShutdown` tears the streamer down before running `simctl shutdown`, and if that throws, no `device:shutdown-done` is ever sent.

- bd9eb37: Fix Full reset erasing devices nobody asked to erase, and failing on the ones people did.

  Two defects that were only safe together. `resetMode` lived in a `useState` that nothing reset: leaving a session with `← All Macs` is a conditional re-render, not an unmount, so an armed toggle survived it and the _next_ device the tester picked was erased too. Separately, `IOSAgent` called `simctl erase` without checking device state, and `erase` refuses a device that is not shut down — so an explicit Full reset on a device that was already running died with `Boot failed: Command failed: xcrun simctl erase <udid>`.

  The second was containing the first: the unwanted erase usually targeted a booted device, so it threw and destroyed nothing. Fixing only the agent would have turned that loud failure into silent data loss, so both move together.

  - **dashboard**: Full reset is now a one-shot intent — arming it applies to the next device you pick and then disarms itself. Asking twice means turning it on twice. The mode the viewer was launched with is held separately from the toggle, so disarming does not disturb the running session.
  - **dashboard**: only the first `device:boot` of a viewer mount carries the reset. `session:joined` arrives again on every socket reconnect, so a Wi-Fi blip or a sleeping laptop would otherwise re-erase the device the tester is looking at, with no click involved.
  - **dashboard**: the toggle is not offered on Android, where nothing acts on it (#447). It used to stay visibly on having done nothing; self-disarming would have made that read as "done".
  - **ios-agent**: shut a running device down before erasing it. Any state other than `Shutdown` gets the shutdown — `Booting` and `Shutting Down` refuse an erase exactly as `Booted` does, and re-picking a device while its shutdown is still draining lands there. The request is never silently skipped.
  - **ios-agent**: if the erase itself fails, boot the device back up before reporting the error — but only when the device really was running and no newer boot has overtaken this one. The shutdown was ours to undo; a device that was already stopping, or one the tester has since asked to stop, is not.

- bd6e64f: Keep a session alive across an agent restart — the relay half (#426).

  Restarting a device agent ended every session it held: the browser was told `session:terminated` and sent back to the Mac list, losing its navigation for something that should have been invisible. The relay now recognises the restart for what it is on the wire — a second socket registering the same devices under the same identity — and re-points the session at it, keeping the id and telling the viewer with `session:rebound`, which the viewer answers with a fresh `device:boot`.

  Only devices the restarted agent still reports are kept. One that is gone gets the old treatment: its session ends and its viewer is told why.

  `SessionManager.rebind()` owns the whole move, rather than the call site doing it inline:

  - **The index order is load-bearing.** The session's id has to leave the old socket's set _before_ `agentSocket` is reassigned. Following the idiom in `remove()` — dereferencing the index through `session.agentSocket` — deletes it from the new set and leaves the old one holding it, so the old socket's close, which the relay itself triggers, evicts the session that was just re-pointed.
  - **Agent-derived fields now have one writer.** `create()` and `rebind()` both take them from a single function, so a field added to a session cannot land on one path only — and `rebind` is the path that would be missed.
  - Capabilities are refreshed, because an upgrade is the usual reason to restart an agent and `session:joined` is only sent once. The device's reported status is refreshed too: left stale, a device that came back down still reads `booted` to the REST guards.
  - `readySent` goes false. Carried across, a browser joining just after the restart would be replayed a `device:ready` for a stream that died with the old process.
  - The old socket's resource entry is dropped. `evictAgentSocket` normally does this, but it returns early when the socket has no sessions left — exactly the case where all of them were rebound — so the map would otherwise keep a dead socket per restart.

  Two things that used to be handled by the eviction the rebind now skips: in-flight screenshot and UI-tree requests are rejected outright instead of waiting out their timeout, and a device that gets a new session is left out of `create()` so the same simulator cannot end up behind two of them. `agent:registered` pairs devices with sessions by id rather than by position, which stops holding the moment some devices are rebound and others are new.

  A device named twice in one register payload now gets one session rather than two, one of which the agent was never told about — the same orphan the rebind prevents, arriving by a different door.

- a391b85: Teach the viewer to recover from an agent restart — the receiving half.

  Restart a device agent today and the tab is told `session:terminated` and sent back to the Mac list. That is better than the silence it replaced (#446), but it makes the tester redo navigation for something that should be invisible.

  `session:rebound` carries the alternative: the relay keeps the session, re-points it at the new agent socket, and tells the viewer to ask for its device back. The relay cannot restart the stream itself — the codec negotiation and the downscale tier ride in the browser's own `device:boot` payload and exist nowhere the relay can see.

  The receiving half landed before the sending one, and on its own it changed nothing. The reverse order would have left the tab worse than it was: the viewer would drop a message it did not know, and `device:boot` is only re-sent from the `session:joined` branch, so there was no recovery path to fall back on — a frozen frame that looks live until someone refreshes. Both halves are in this release, along with the window that gives a restarting agent time to come back.

  On receipt the viewer tears down first, then re-boots:

  - Clears what a restart invalidates, including three flags `device:booting` never touches — `launching`, `swKeyboardPending`, `swKeyboardVisible`. Their acknowledgements died with the old agent. This was unreachable before: a dead agent unmounted the viewer, so nothing could outlive it.
  - Re-sends `device:boot` carrying `app-only`, never a reset. A restart is not a request to erase the device (#439).
  - Skips the reinstall when the build was already on the device. The simulator stayed up across the restart, and reinstalling would kill the app state the recovery exists to preserve. The skip cannot key off `installed` at that point — `device:booting` clears that flag and the agent sends it on every boot, so it is always false by the time `device:ready` arrives — so the state is captured when the rebind starts.
  - Restores `installed` when it skips. That flag gates the Launch control, and without `app:install-done` to set it the tester would silently lose the button.
  - Installs anyway when the rebind interrupted an install. An agent is at its most fragile mid-install, and there the app really is absent — skipping would leave a Launch button for something that is not on the device.
  - Counts pending rebinds rather than flagging one. A crash-looping agent rebinds repeatedly, each with its own boot and its own `device:ready`; a flag is spent by the first, and the second reinstalls. The count is also reset by `session:joined` and `device:boot-error`, so a rebind whose agent never answers cannot absorb a later ordinary boot and suppress installs for the rest of the mount.

  Also names the Launch button on both platforms. It was icon-only with no accessible name, so screen-reader and voice-control users had no way to reach it.

- Updated dependencies [2aebd34]
- Updated dependencies [f4235e5]
- Updated dependencies [7637be3]
- Updated dependencies [a391b85]
- Updated dependencies [273c016]
  - @tapflowio/protocol@0.18.0
  - @tapflowio/agent-core@0.18.0

## 0.17.0

### Minor Changes

- 661356e: Share the clipboard between the dashboard and the simulator/emulator.

  **Paste** works everywhere, including plain-HTTP LAN deployments: Cmd/Ctrl+V in the viewer sends your clipboard to the device and pastes it there.

  **Copy** needs the dashboard served over HTTPS (or localhost). Cmd/Ctrl+C then brings what you copied on the device to your own clipboard in one press. On plain HTTP the copy still lands on the device and the dashboard says why it stopped there: proving the copy actually happened takes a round trip, and no clipboard API available on plain HTTP accepts a value that arrives that late. tapflow already supports LAN HTTPS, which WebCodecs hardware decoding also benefits from.

  Previously neither direction existed: text copied inside the simulator had no way out, so accounts, tokens and deep links had to be retyped by hand.

  - iOS reads and writes the device pasteboard through `simctl pbpaste`/`pbcopy`.
  - Android uses the emulator's gRPC clipboard API (the AVD images do not implement `adb shell cmd clipboard`). Devices on the scrcpy backend report the feature as unsupported instead of failing silently.
  - The agent presses the device-side chord itself and confirms the clipboard actually changed before answering, so a slow or busy device cannot hand back the previous value as if it were freshly copied. When it cannot, it says whether its marker is still on the device, so the viewer knows whether pressing the plain chord as a fallback is safe.
  - Adds the `clipboard:read` / `clipboard:write` / `clipboard:data` / `clipboard:write-done` / `clipboard:error` messages, and an agent capability list in `agent:register`. Additive on the wire: an agent that does not advertise `clipboard` is never sent these messages at all, and the viewer keeps forwarding the shortcuts as plain key input exactly as before — so **an agent running an older version keeps working, it just copies and pastes within the device only.** Update the agent to get the bridge.

- eaa78ac: MCP input tools now report what actually happened instead of always reporting success.

  `tap`, `swipe`, `press_key` and `press_button` were fire-and-forget: the tool answered `{tapped: true}` no matter what the agent did with the input. Against a session whose device is not booted the input was dropped and still reported as success — a false positive that also makes parallel test results untrustworthy.

  Agents now acknowledge a gesture's terminal message with `input:done` or `input:error`, and the tools surface that. `done` means the agent dispatched the input to a booted device; as with the existing `input:type-done`, it is not a guarantee the app reacted.

  Additive: an agent that does not send the ack is handled as before.

### Patch Changes

- @tapflowio/agent-core@0.17.0

## 0.16.0

### Patch Changes

- @tapflowio/agent-core@0.16.0

## 0.15.0

### Minor Changes

- Unify project state under a single `.tapflow/` root and harden Android build ingestion.

  - **Breaking — default data directory moved** from `.tapflow-data/` to `.tapflow/data/`, unifying all project state under one `.tapflow/` root (`data/` runtime, `flows/` committed, `artifacts/` screenshots). Existing installs keep working without action — a pinned `local.dataDir` is honored and a config-less default install keeps reading a pre-existing `.tapflow-data/`. Run `tapflow migrate data-dir` once to unify the layout (atomic rename, no data loss; repoints `local.dataDir` and updates `.gitignore`). Docker: remount your data volume at `/app/.tapflow/data`.
  - **Breaking — stricter APK ingestion.** `POST /api/v1/builds` now returns `400` for an `.apk` uploaded with `app_id` when the relay can't read the APK's package name (Android build-tools / `aapt` missing, or the archive is unreadable), instead of storing an unversioned build under that app. Install build-tools with `tapflow setup android`, or omit `app_id` to file the build separately.
  - Added `tapflow migrate data-dir`, an Android `build-tools` install in `tapflow setup android`, and an `aapt (build-tools)` check in `tapflow doctor`.
  - `tapflow flow run` writes failure screenshots to `.tapflow/artifacts/` by default, matching the `--artifacts` help text.
  - Fixed: an `.apk` with unreadable metadata is no longer merged into an unrelated app or false-promoted to platform `both`; `tapflow doctor` and the relay now share the same `aapt` search paths.

### Patch Changes

- @tapflowio/agent-core@0.15.0

## 0.14.0

### Minor Changes

- ba0a3d8: Automated QA axis: UI accessibility tree queries and the deterministic flow runner.

  - `query_ui_tree` (MCP) / `GET /api/v1/sessions/:sessionId/ui-tree` — unified element schema (`role`/`label`/`identifier`/`frame`/`enabled`), frames normalized 0-1 so a frame center feeds straight into `tap`. iOS reads the tree via a resident XCUITest runner inside the simulator — window-agnostic (no Simulator.app window required) and still no WebDriverAgent; Android via `uiautomator dump` with a device-side timeout.
  - `@tapflowio/flow-runner` (new package) + `tapflow flow run` — replay YAML flows with zero LLM calls: 10-step vocabulary, identifier/label selector resolution, condition-based waits, JUnit reports, failure screenshots, CI exit-code contract (0/1/2).
  - `run_flow` (MCP) — agents author a flow once, then replay it deterministically over the existing session.
  - New relay messages `app:clear-state` (reset app data — `pm clear` on Android, data-container wipe on iOS) and `input:type-done`/`input:type-error` (text-entry completion ack, so a following key press stays ordered). Text entry now waits for this ack: a self-hosted agent older than this release will not send it, so text steps time out — update the agent alongside the relay.
  - mcp-server and flow-runner graduate from the `experimental` dist-tag to the standard npm channel, versioned with the repo-wide fixed group.

### Patch Changes

- Updated dependencies [ba0a3d8]
  - @tapflowio/agent-core@0.14.0

## 0.13.0

### Minor Changes

- Outbound webhooks for build review-status changes

  The relay now POSTs to registered URLs when a build's review status transitions to `Done` or `Rejected`, so review outcomes can flow into Slack or the next CI step. Endpoints are registered at runtime via the REST API (`/api/v1/webhooks`, `builds:write` scope) or declared in `tapflow.config.json` (`webhooks`, with signing secrets read from env vars). Deliveries carry metadata only — never app binaries — and are HMAC-SHA256 signed (`X-Tapflow-Signature`) when a secret is set. Registration blocks loopback and cloud-metadata addresses.

### Patch Changes

- @tapflowio/agent-core@0.13.0

## 0.12.0

### Minor Changes

- Accept EAS `eas build` iOS simulator artifacts (`.tar.gz` / `.tgz`) as a first-class build upload, alongside `.app.zip` and `.apk`. The archive is stored as-is (no re-zip) and extracted with `tar` at install time, so the `.app`'s executable bits and symlinks are preserved. Uploads are validated before storage — path traversal (`..`/absolute), symbolic/hard links, corrupt gzip, and gzip bombs (`TAPFLOW_MAX_UNPACKED_BYTES`, default upload cap ×4) are rejected. This removes the CI re-packaging step for Expo/EAS teams: `eas build → CI → tapflow` uploads the native `.tar.gz` directly.

### Patch Changes

- @tapflowio/agent-core@0.12.0

## 0.11.1

### Patch Changes

- @tapflowio/agent-core@0.11.1

## 0.11.0

### Patch Changes

- 3377bfe: Fix the package type entrypoint for npm consumers (#345). `exports.types` now points at the published `dist/*.d.ts` instead of `src/` — which isn't shipped in the tarball (`files` ships only `dist`/`bin`), so consumers couldn't resolve the package's types.

  The monorepo moves to **TypeScript project references** (each lib package gets `composite: true` + `references`, plus a root solution `tsconfig.json`). `typecheck`/`build` run via `tsc -b`, so workspace typecheck stays build-light (incremental, no manual dist build) while the published packages expose correct types from `dist`. No runtime or public API changes.

- Updated dependencies [3377bfe]
  - @tapflowio/agent-core@0.11.0

## 0.10.0

### Minor Changes

- Build review status is now decoupled from the storage deletion lifecycle (#258). Marking a build **Done** no longer schedules it for deletion — `status_label` is a pure review state, and purge keys off a new nullable `delete_after` timestamp instead of `completed_at`. Deletion is an explicit action via `POST /api/v1/builds/:id/schedule-deletion` (and `DELETE …/schedule-deletion` to cancel); the response and build payloads now include `delete_after`. Migration `012` adds the column and grandfathers builds already on the old `completed_at` clock (`delete_after = completed_at + TTL`) so upgrades keep reclaiming disk. The dashboard shows a deletion-countdown badge separate from the status column with explicit schedule/cancel actions.

### Patch Changes

- 9864d2d: Build-upload validation errors are now returned in English, matching the rest of the API (previously the `.app.zip` format, missing-`.app`-directory, and device-only-slice messages were Korean only). Internal code comments are unchanged.
- d1b36a9: The relay now runs a WebSocket heartbeat (ping/pong, 30s) over every socket and terminates one that misses a pong window, so dead agent/browser/stream sockets (Wi-Fi loss, sleep, cable pull) are detected promptly instead of lingering until the TCP timeout. Termination reuses the existing close cleanup, evicting stale sessions and clearing the duplicate "Stale" card.
  - @tapflowio/agent-core@0.10.0

## 0.9.2

### Patch Changes

- - Bump nodemailer to 9.0.1, resolving the `raw`-option file-access / SSRF advisory (GHSA-p6gq-j5cr-w38f).
  - Reject in-flight screenshots when an agent is evicted on re-register.
  - Dedup agent re-register by machine id to remove duplicate "Stale" cards.
  - Extract `startTlsBackgroundTasks` (cert renewal + address publish) shared by all three entry points.
- Updated dependencies
  - @tapflowio/agent-core@0.9.2

## 0.9.1

### Patch Changes

- The relay now loads `.tapflow-data/.env` before reading its config, so every secret can live in that file — not just DNS/ACME tokens. `JWT_SECRET`, the SMTP password, and the tunnel token are all picked up from `.env` now. Precedence is shell env > `.env` > config file (a shell variable still overrides the file). `TAPFLOW_DATA_DIR` is the one exception, since it decides where `.env` lives.
  - @tapflowio/agent-core@0.9.1

## 0.9.0

### Minor Changes

- LAN HTTPS — terminate TLS in-process with automatic certificates.

  - relay: in-process TLS termination with a disk-backed certificate store and automatic renewal. Two providers: `AcmeCertProvider` (Let's Encrypt via DNS-01) and `ImportCertProvider` (bring your own cert).
  - relay: pluggable `DnsProviderRegistry` for DNS-01 challenges, with `CloudflareDnsProvider` and `VercelDnsProvider` adapters. New DNS providers register without touching relay code.
  - relay: auto-publishes the detected LAN IP to the configured domain's A record and self-heals it on change, so the HTTPS hostname keeps resolving on the local network.
  - relay: DNS/ACME credentials load from a gitignored `.env` file, namespaced under `TAPFLOW_`. Requires Node >= 20.12.0.
  - cli: `tapflow init` gains a guided HTTPS setup step for the LAN path; `tapflow start` wires `--trusted-proxies` / `--cors-origins`.

  This enables WebCodecs-based low-latency streaming, which requires a secure context on the LAN.

### Patch Changes

- da68b9e: Further harden the relay for public exposure:

  - CORS is restricted to the configured origins (public URL + loopback) instead of `*`, so an `Authorization` token can't be used from an unlisted cross-origin script.
  - Cookie-authenticated state-changing requests must come from a same-origin or allowlisted origin (lightweight CSRF guard); PAT-authenticated requests are exempt.
  - Invite links are built from the configured base URL (tunnel public URL / relay URL) instead of the request `Host` header.
  - Uploads that exceed the size limit are rejected and their partial files removed (builds and comment attachments). Limits are configurable via `TAPFLOW_MAX_BUILD_BYTES` / `TAPFLOW_MAX_COMMENT_BYTES`.

- 37f1aae: The relay now logs handler exceptions (method, path, stack) instead of silently swallowing them, so 5xx failures are diagnosable. Response bodies still return only a generic message, and PATs are masked in the logs.
  - @tapflowio/agent-core@0.9.0

## 0.8.2

### Patch Changes

- 859f9e3: Harden the relay for public and proxied exposure:

  - A per-install JWT secret is generated and persisted automatically when `JWT_SECRET` is unset, replacing the shared development default.
  - Authentication endpoints apply rate limiting with exponential backoff.
  - Bootstrap (`auth/init`) is restricted to localhost — on headless servers, run `tapflow admin init` on the relay host.
  - New `TAPFLOW_TRUSTED_PROXIES` resolves the real client IP from `X-Forwarded-For` when the relay runs behind a same-host reverse proxy.
  - @tapflowio/agent-core@0.8.2

## 0.8.1

### Patch Changes

- 129b5b1: relay: bind the server dual-stack (IPv4 + IPv6). A bare `listen(port)` bound IPv6-only on some macOS/node setups, so an agent on another Mac connecting over `ws://<ipv4>:4000` timed out (TCP/HTTP reached the host, but the WebSocket handshake never hit the server). The relay now binds with `{ host: '::', ipv6Only: false }`, so LAN agents connect over IPv4 without a workaround.
- 6e4801a: Restore remote agent connections to the relay (#271). The WS auth gate added in 17b8615 closed every non-loopback connection without a cookie/PAT, so no remote agent could register — the agent then hung forever on a silent pre-registration close ("Connecting ios agent…"). Remote agents now connect again, authenticated with a token.

  **Changed — remote agents now require a token.** A relay on a different machine only accepts agents that present a PAT with the new `agent` scope (create one in Settings → Tokens, pass it via `--token` or `TAPFLOW_AGENT_TOKEN`). Agents connecting to a relay on the same machine (`localhost`) stay unauthenticated, so `tapflow start` is unchanged. See [Remote relay authentication](https://github.com/jo-duchan/tapflow/blob/main/docs/guide/agent.md#remote-relay-authentication).

  Details:

  - relay: remote connections presenting a PAT with the new `agent` scope are accepted and roled by their first message (`agent:register` / `stream:register`); the rejection close reason explains the fix and is logged. Token creation API accepts a `scope` field (`agent` scope is Admin-only; default scope unchanged).
  - dashboard: token dialog gains an API/Agent type selector; creating an agent token shows a ready-to-run `tapflow agent start --token` command.
  - agents (iOS/Android): new `token` option sends `Authorization: Bearer` on the control and stream WS; pre-registration closes now reject with the close code/reason instead of hanging; handshake timeout (10s default); reconnect failures log their cause.
  - cli: `tapflow agent start --token` flag (or `TAPFLOW_AGENT_TOKEN` env); a 1008 rejection prints token setup guidance. Local (`localhost`) agents stay unauthenticated — `tapflow start` is unchanged.

- Updated dependencies [6e4801a]
  - @tapflowio/agent-core@0.8.1

## 0.8.1-next.0

### Patch Changes

- 129b5b1: relay: bind the server dual-stack (IPv4 + IPv6). A bare `listen(port)` bound IPv6-only on some macOS/node setups, so an agent on another Mac connecting over `ws://<ipv4>:4000` timed out (TCP/HTTP reached the host, but the WebSocket handshake never hit the server). The relay now binds with `{ host: '::', ipv6Only: false }`, so LAN agents connect over IPv4 without a workaround.
  - @tapflowio/agent-core@0.8.1-next.0

## 0.8.0

### Patch Changes

- @tapflowio/agent-core@0.8.0

## 0.8.0-next.4

### Patch Changes

- @tapflowio/agent-core@0.8.0-next.4

## 0.8.0-next.3

### Patch Changes

- @tapflowio/agent-core@0.8.0-next.3

## 0.8.0-next.2

### Patch Changes

- @tapflowio/agent-core@0.8.0-next.2

## 0.8.0-next.1

### Patch Changes

- @tapflowio/agent-core@0.8.0-next.1

## 0.8.0-next.0

### Patch Changes

- @tapflowio/agent-core@0.8.0-next.0

## 0.7.0

### Minor Changes

- Low-latency render pipeline.

  - **Android host-encode**: emulators now capture over gRPC and encode H.264 on the Mac host (VideoToolbox). The gRPC backend is the default for emulators, with a 30fps cap and automatic scrcpy fallback; real devices continue to use scrcpy.
  - **Unified downscale**: per-session resolution is chosen from the viewer's connection context (native on a secure context, 1280px on LAN-HTTP, 1000px external) and is tunable via `TAPFLOW_MAX_SIZE` and the per-platform / `_LAN` / `_EXTERNAL` overrides.
  - **Relay IDR-on-rejoin**: the relay requests an IDR keyframe when a browser (re)joins a booted device, so a late joiner paints immediately.
  - **iOS**: static-frame skip, tear-free framebuffer snapshots, and keyframe-aware backpressure on the agent→relay stream.
  - **Android**: keyframe-aware backpressure and 16-aligned encode sizing to avoid macroblock padding on the WASM decoder.

  The dashboard unifies iOS/Android decoding and perf telemetry behind a single `useDecoderStream` hook (hardware WebCodecs on a secure context, WASM fallback otherwise).

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.7.0

## 0.6.1

### Patch Changes

- @tapflowio/agent-core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.6.0

## 0.5.1

### Patch Changes

- @tapflowio/agent-core@0.5.1

## 0.5.0

### Minor Changes

- H.264 streaming pipeline with automatic codec negotiation.

  - iOS streams H.264 by default (VideoToolbox encoder), cutting bandwidth ~10× vs JPEG (~16–27 KB/frame vs ~235 KB) for noticeably lower latency. Android streaming moves to a runtime decoder layer.
  - The browser advertises its decode capability (`acceptH264`) at boot; the agent picks H.264 only when the client can decode it, otherwise falls back to JPEG — no black screens on older browsers.
  - Tiered browser decoders: HTTPS → WebCodecs, plain-HTTP LAN → WASM (tinyh264), both WebGL2-rendered.

  Backward compatible: the envelope codec/keyframe marker reuses a previously zero flag byte, so older clients read frames as JPEG and the relay forwards payloads untouched. Agents without `acceptH264` (version skew) default to JPEG. Opt out of H.264 anytime with `TAPFLOW_IOS_CODEC=jpeg`.

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.5.0

## 0.4.1

### Patch Changes

- 17b8615: fix: path traversal in /uploads/ and unauthenticated WebSocket access
- Updated dependencies [17b8615]
  - @tapflowio/agent-core@0.4.1

## 0.4.0

### Minor Changes

- feat!: tapflow init redesign, Tailscale tunnel, web onboarding, and UX improvements

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.4.0

## 0.3.1

### Patch Changes

- Fix mcp-server release: add publishConfig for experimental tag and public access
- Updated dependencies
  - @tapflowio/agent-core@0.3.1

## 0.3.0

### Minor Changes

- bec7ff1: Release v0.3.0

  - relay: add screenshot REST endpoint (`GET /api/v1/sessions/:id/screenshot`) for CI and AI agent use
  - relay: enforce PAT scope checks on builds endpoints; new tokens include `view` scope by default
  - relay: add `session:leave` message type — MCP clients can disconnect without ending the session
  - relay: fix `.app` bundle names with spaces in zip upload validation
  - dashboard: add deeplink URL execution from QA session toolbar
  - dashboard: add keyboard shortcuts and Kbd UI to simulator toolbar
  - dashboard: add streaming performance overlay

### Patch Changes

- Updated dependencies [bec7ff1]
  - @tapflowio/agent-core@0.3.0

## 0.2.2

### Patch Changes

- 306d859: feat: auto-delete build files 7 days after done status

  - Add `completed_at` column to builds table (migration 010)
  - Record timestamp when build status changes to Done
  - Block status changes on completed (Done) builds
  - Run TTL cleanup on server start and every 24 hours
  - @tapflowio/agent-core@0.2.2

## 0.2.1

### Patch Changes

- fix: WebSocket backpressure, Android pinch via scrcpy multi-touch, dashboard skeleton visibility
- Updated dependencies
  - @tapflowio/agent-core@0.2.1

## 0.2.0

### Minor Changes

- Add typed errors, CLI install banner, and dashboard toast feedback

  - **typed errors** (`agent-core`): `ValidationError`, `PlatformError`, `AuthError` exported from `@tapflowio/agent-core`; key runtime throw sites updated for typed `instanceof` handling (#63)
  - **CLI install banner**: `postinstall` prints success banner after global npm install (suppressed in CI / non-TTY / local workspace); `tapflow` with no args shows version banner and quick-start commands (#90)
  - **dashboard toast feedback**: sonner toasts on all key mutation flows — token create/revoke/copy, workspace/profile/password/app settings, app creation, build upload; `confirm()` replaced with `AlertDialog`; `toast.promise` for upload progress (#91)

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.2.0

## 0.1.0

### Patch Changes

- f13bd85: **Breaking change**: default `dataDir` renamed from `.tapflow` to `.tapflow-data`.

  If you have an existing `.tapflow/` directory, either rename it to `.tapflow-data/` or set `dataDir: ".tapflow"` in `tapflow.config.json` to keep using the old path.

  - @tapflowio/agent-core@0.1.0

## 0.1.0-alpha.8

### Patch Changes

- @tapflowio/agent-core@0.1.0-alpha.8

## 0.1.0-alpha.7

### Patch Changes

- f13bd85: **Breaking change**: default `dataDir` renamed from `.tapflow` to `.tapflow-data`.

  If you have an existing `.tapflow/` directory, either rename it to `.tapflow-data/` or set `dataDir: ".tapflow"` in `tapflow.config.json` to keep using the old path.

  - @tapflowio/agent-core@0.1.0-alpha.7

## 0.1.0-alpha.2

### Patch Changes

- @tapflowio/agent-core@0.1.0-alpha.2
