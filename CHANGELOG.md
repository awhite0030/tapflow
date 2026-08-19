# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- `js-yaml` moved to 3.15.1 / 4.3.1 (GHSA-5p4m-2wfm-xmqj — quadratic CPU consumption resolving `!!omap`), and its two `pnpm.overrides` entries were retired with it. The pin listed under 0.16.0 below no longer exists: the declared ranges had admitted the patch all along, so what held the old version in place was a lockfile that never re-evaluated them, not a range that forbade it. Development dependency only — no published package carries `js-yaml`.
- `shell-quote` and `dompurify` lost their `pnpm.overrides` entries as well, this time with no version change at all: both already sit at the highest floor any advisory for them asks for (1.9.0 and 3.4.13), and neither entry was doing the work. `concurrently` pins `shell-quote` to an exact version, which the key `<1.8.4` never intersected; `mermaid`'s caret on `dompurify` reaches the same release the override named. 0.9.2 below announced a dompurify pin at 3.4.11, raised since without a note of its own — there is now no pin on either package at all. Both are development dependencies of private packages only.

## [0.19.0] - 2026-08-19

**The wire answers.** Every request now carries an identifier its reply echoes, every refusal comes back
with a machine-readable reason, and a session belongs to the client that opened it rather than to one of
its sockets. Most of what is listed below is one program: paths where nothing was sent, so whoever asked
found out by waiting.

### Breaking Changes

- **Requires Node.js ≥ 22.** Node 20 reached end of life on 2026-04-30 and no longer receives security
  patches.
  `Migrate:` upgrade the Node on the Mac running the agent and on whatever runs the relay. `nvm install 22`
  or the installer from nodejs.org; `tapflow doctor` reports the version it finds.
- **Update your agents and your relay together.** Requests now carry an identifier the reply echoes, so
  the relay can tell which answer belongs to which request. An agent from before this release does not
  echo it, and the reply is then discarded rather than misattributed — safer, and still a failure: an app
  install started from the dashboard sits on "Installing…" with no Launch control, and a deep link opened
  through `open_url` does nothing. A client newer than its relay has the mirror problem on a refused
  session join, which runs to its deadline instead of saying why.
  `Migrate:` upgrade every device agent to this release at the same time as the relay. Packages are
  versioned together, but nothing installs them together — this is the case where a Mac left on the
  previous agent is the one that breaks.
- **An agent must now send a machine-readable `reason` when it refuses an input.** `input:error` used
  to guarantee only `message`, the human-readable prose each agent writes for itself, while `reason` —
  the closed set a caller actually branches on — was optional. That is backwards: the field you were
  guaranteed was the one you must not depend on. `reason` is required now and `message` is optional.
  Every agent shipped with tapflow already sends one, so no producer here had to change; what this
  affects is a third-party or self-modified agent built against an older contract.
  `Migrate:` add `reason` to every `input:error` your agent sends, choosing from `not-booted`,
  `channel-starting`, `channel-unavailable`, `no-gesture`, `dispatch-failed`, `unsupported` or
  `malformed`. Pick by what the caller should do differently, not by which of your internal states
  produced it — the set is deliberately smaller than any one agent's internals. (`not-session-owner`
  is the eighth member and is the relay's alone: it refuses such a frame at its door, before any agent
  sees it.) Prose stays welcome in `message` and may now be omitted.
- **`@tapflowio/relay` no longer exports `RelayMessage` or `MessageType`.** They were the relay's own
  copy of the wire contract — a flat interface where `type` was the only required member, and a
  hand-maintained list of 63 literals beside it — and they disagreed with `@tapflowio/protocol` about
  the same fields, which is the drift this release closes. Nothing in tapflow imported them; this
  affects code outside it that did.
  `Migrate:` import the message types from `@tapflowio/protocol` instead, which declares one interface
  per message and unions them by direction — `BrowserToRelay`, `AgentToRelay`, `BrowserInbound` and so
  on. A `RelayMessage` used as "any frame on this socket" becomes the union for that socket's
  direction, and narrowing on `type` gives the individual message.

### Changed

- **The relay now checks every message it receives against the contract, and refuses the ones that
  break it.** Every frame is checked for its type, its address and its correlator; a command sent by a
  browser is checked in full, down to its payload. Until now it checked only what it *sent*. A command with a missing payload, an empty
  session id, or a build id that was not a number was forwarded to a device anyway — or answered with a
  reply whose own required field was missing, which every client discards, turning a diagnosis into a
  caller waiting out its deadline. A refused command is now answered where the request has a reply, so
  the caller is told which field was wrong instead of waiting; where it has none, the frame is dropped
  and the log names the field. Well-formed messages are unaffected.
- **A field appended to a browser message no longer reaches a device.** Anything the contract does not
  declare is removed before the relay forwards it on. Messages coming *from* an agent are forwarded
  untouched, so an agent newer than its relay does not lose fields it adds.
- **`@tapflowio/protocol` has a second entry point, `@tapflowio/protocol/validate`.** It holds the
  relay's inbound parser, and it brings the package its first runtime dependency (`zod`). The main
  entry is unchanged — types only, fully erased by `import type`, and it does not reach `zod` — so a
  consumer that imports only `@tapflowio/protocol` gains nothing in its bundle.
- Split stable dashboard vendor dependencies into smaller chunks to reduce maximum bundle size and improve cache reuse across releases.
- **A refused session now says which session it refused and why.** Opening a device someone else already
  has open, or one whose Mac is under load, used to produce a generic failure the dashboard could not
  attribute — with two tabs opening at once it could even be shown against the wrong one. The refusal now
  names the session and carries one of three reasons, so the second tester is told the device is in use
  rather than that something went wrong.

### Fixed

- **A boot that will not finish now says so, instead of letting you wait.** Re-pick a device while the
  first one is still starting, or shut it down mid-boot, and the agent abandoned the earlier boot in
  silence — nothing was sent in either direction, so whoever asked found out by waiting: 30 seconds for an
  MCP caller, two minutes for a flow run, forever for a spinner. An abandoned boot is now answered on its
  own request — superseded by a newer boot, abandoned by a shutdown, or invalidated by the agent losing
  the relay — as long as the agent still has an open connection to answer on; when it does not, the relay
  ends the wait instead by declaring the agent away. A tester sees nothing for the boot they replaced
  themselves, and the failure of the one they are waiting on exactly as before.
- **A slow cold boot is no longer reported as a failure that never happened.** The agents poll a booting
  device for up to 90 seconds (iOS) or 120 (Android) before explaining what went wrong; `mcp-server` gave
  up at 30, inside both, so a device that was simply slow came back as a bare timeout while the
  explanation was on its way. `flow-runner` sat at exactly Android's 120, leaving no room at all. Both now
  wait past the agent. The cost of waiting longer is worth knowing: a wedged relay blocks an MCP caller
  for three minutes rather than 30 seconds, so a host whose own tool timeout is shorter will cut in first
  with a message of its own.
- **Losing the relay mid-boot no longer leaves an Android agent finishing a boot nobody owns.** Both
  agents drop their device state when the connection goes, but a boot already running holds its own
  reference to one; on Android it ran to completion against that, standing up a video stream and
  announcing the device ready for a session that no longer existed.
- **Nobody else can power off a device you are using.** Any signed-in client that knew a session id could
  shut down a colleague's simulator mid-test. The check that stops it could not be added before: the
  browser tab that holds a session and the one that sends the shutdown when you navigate away are
  different connections, so refusing "not the holder" would have refused the tab's own cleanup and left
  devices running. A session now belongs to whoever opened it rather than to one of their connections.
- **A Wi-Fi blip no longer costs you your session.** The relay treated a connection as present until TCP
  or a heartbeat noticed otherwise — up to a minute after a laptop went to sleep — so returning inside
  that window meant being told the device was in use, by yourself. A device whose tester's connection
  died — a sleeping laptop, a dropped network — frees up in at most 45 seconds rather than up to a minute,
  and no longer shows as free while it is still in use: "can I take this?" and the
  "In use" badge read the same signal now.
- **A refused `connect_device` says which of the three refusals it was.** It reported the relay's prose
  alone, so "the device is open in another browser session" and "this Mac is over its resource ceiling"
  arrived as sentences a model had to guess at rather than the closed reason it can act on. A failed
  screenshot or UI-tree query likewise says what is wrong with the *session* now, not only what the relay
  said about the request — so one failing because the agent dropped its device binding no longer reads as a
  bare status code. That is the least useful moment for it, since a screenshot is usually being taken to
  explain a step that already failed.
- **Disconnecting from a session no longer leaves a request hanging for its full deadline.** An AI agent
  that disconnects while a boot is still in flight — ordinary, since tool calls run in parallel — used to
  get a bare timeout thirty seconds later. It fails immediately now and says the disconnect is what ended
  it, while still warning that the request may have reached the device anyway. A worse version of the same
  gap could have reported a boot that never happened as success, after re-joining the same session.
- **A flow run whose device dies stops blaming the selector.** When the agent restarts mid-run its device
  binding is gone, and nothing in a flow can restore it — flows boot once, before the first step. Every
  remaining step used to poll for its full timeout and fail with "no element matched", so a restart three
  steps into a ten-step flow spent eighty seconds pointing at the wrong thing. They now fail as soon as the query does and say the
  session needs booting again. The relay's fifteen-second grace for an agent that may come back is
  untouched: queries keep retrying through it exactly as before.
- **Shutting a device down through an MCP client fails in a second instead of half a minute.**
  `device:shutdown` was the one command from a browser that the relay never answered when it could not
  deliver it — a stale session id or an agent that had gone away produced no reply at all, so
  `shutdown_device` reported "Request timed out" with no cause after 30 seconds. It now says which of the
  two happened. The device list had the other half of the same silence: a row stuck on "Shutting down…"
  with both its buttons hidden for the rest of the page's life.
- **A tester whose browser reconnects lands back in their session instead of being thrown out of it.**
  Re-joining a session the tab already held was refused as "session not found" — for a live session, held
  by that tab, which the device list reported as theirs. The viewer reads that as the agent having
  disconnected, so a two-second Wi-Fi blip ended a session that was fine. Re-joining is now the same as
  joining, cached screen state included.
- **Devices no longer stay booted with nobody watching them.** The relay tracked one session per browser
  connection, but one connection can hold several — an AI agent driving two devices uses a single one. When
  it went away only the most recent session was released; the rest stayed marked in use for as long as the
  relay ran, with no idle timeout, so their simulators kept running. Every session a connection held is
  released now, each with its own timeout.
- **An input that never reached the device was reported as having landed.** Every path that could refuse
  or drop an input — a simulator that is not booted, an input channel still starting, an agent that went
  away, a helper process that died — either said nothing or said success. An LLM driving the device through
  MCP moved on as though the tap had happened; a `tapflow flow` run failed several steps later with
  "selector not found", which is the worst place to lose a cause; and the dashboard showed nothing at all.
  Every one of those now answers, and says which of the two it is: the input was refused, with the reason,
  or it could not be confirmed — which is not the same as saying it did not happen, because an
  acknowledgement can arrive after the wait for it has ended. Repeating an input that did land would
  duplicate it, so the message says to check the device rather than to retry.
- **A reply could be attributed to the wrong request.** Boots, shutdowns, app installs and launches, URL
  opens and input acknowledgements carried nothing tying a reply to the request that asked. Two overlapping
  requests on one session and the first answer settled the wrong one — so a boot that failed could be
  reported as the one that succeeded, and an acknowledgement that arrived late was read as the next input's.
  Each of those now carries a correlator the reply echoes.
- **A dead session hung until the deadline instead of saying so.** When an agent went away mid-command, the
  relay said so on the wire, and the MCP server and flow runner ignored it — an app
  install waited out its full two minutes and reported a timeout. They read those messages now and fail with
  the reason. A device whose agent reconnected is reported as needing a boot rather than as a reset device,
  because the app is still running.
- **An app install could fail with "No devices are booted" on a device that was starting up.** Booting a
  simulator was announced as finished when the command to boot it returned, which is 7.6 seconds before the
  device is actually ready. Anything issued in that window — an install, a launch, an input — hit a device
  that was still coming up. The agent now waits for the device to report itself booted before saying so.
- **A JPEG screenshot could come back as PNG bytes labelled JPEG.** Android always produces PNG whatever is
  asked for, and the label was taken from the request. The MCP server picks its image parser by that label,
  so it measured PNG bytes with a JPEG parser and handed the model a wrong screen size — which the model then
  used as the divisor for every tap coordinate. The format is read from the bytes now.
- **`tapflow flow` reported an environment failure as a product failure.** A step whose input the relay or
  the agent refused failed with the selector error from the next step rather than the refusal, so a CI run
  showed a broken assertion where the device had simply not been reachable.
- The iOS fallback video path emitted PNG frames under a JPEG label. No entrypoint shipped with tapflow
  selects it; it affects a consumer of `@tapflowio/ios-agent` that sets `intervalMs` itself.

- **A scrcpy server process error could take down every Android device the agent manages, not just the one session.** The scrcpy server process spawned for a real-device session had no error handler; an unhandled error on it (e.g. the server process failing to spawn, or a permission error on kill) crashed the whole android-agent process, ending every session it was managing. It's now logged instead.
- `TouchHelper` and `KeyboardHelperDaemon` could leave a wedged helper process running after `stop()` — only `SIGTERM` was sent, with no fallback. Both now escalate to `SIGKILL` after 1s if the process hasn't exited, matching `ScreenCaptureStreamer` and `XCUITreeReader`.

## [0.18.0] - 2026-08-03

### Added

- **Restarting a device agent no longer costs you your place.** Upgrading or restarting an agent used to end every session it held: the tab you had open was sent back to the Mac list, and you navigated back through the app to where you had been. The relay now holds a session for 15 seconds after its agent's connection drops, and an agent that comes back reclaims it — the stream returns on its own with the app still on the screen you left it on, and no reinstall, so nothing you had entered is lost. If the agent does not come back the tab says it is waiting and then says the session ended, instead of showing a picture that quietly stopped updating. `TAPFLOW_AGENT_GRACE_MS` sets the window; `0` turns it off.
- `@tapflowio/protocol`, one place the WebSocket message shapes are declared for the relay, the dashboard and the MCP server. They were three hand-kept copies that had already drifted; a message the relay sends is now a compile error everywhere it is spelled wrong.

### Fixed

- **Full reset erased devices nobody asked to erase, and failed on the ones people did.** The toggle stayed on for the rest of the session, so every later reconnect wiped the simulator again — a Wi-Fi blip was enough. It also failed outright on a device that was already running, which is most of them. It now erases once, when asked, and shuts a running device down first.
- **App install and launch failures reached nobody.** A missing build, an unknown session or an offline agent produced either an error with no session attached or, when the agent was gone, nothing at all — so an MCP caller waited out its timeout and reported a failure with no cause. Every one of those paths now answers immediately, addressed to the session that asked.
- **Commands went to whichever simulator happened to be booted.** With two devices up, an install or a launch could land on the wrong one, and `simctl` picked silently rather than erroring. Each command now names the session's own device.
- The dashboard could report a device as ready with nothing streaming behind it — a simulator someone had left running was announced as live before the agent had done anything with it, leaving a viewer waiting for a first frame that was never coming.
- Booting an iOS device no longer hides `Simulator.app`. The workaround dated from an older Xcode and, on the supported line, only cost a window flash on every boot.

### Changed

- An agent that goes away while you are watching now tells the tab so, and the tab says which of the two it is: waiting for the agent to come back, or the session is over. Both are new messages on the relay-to-browser contract; a viewer that predates them ignores them, as before.
- While an agent is away its devices are not offered on the Mac list, and `tapflow status`, `list_devices` over MCP and flow-runner see the same — a device nobody can reach for the length of the window is not one to hand out.

## [0.17.0] - 2026-07-27

### Added

- **Copy and paste now cross between the dashboard and the device.** Cmd/Ctrl+V sends your clipboard to the simulator or emulator and pastes it there; Cmd/Ctrl+C brings what you copied on the device to your own clipboard in one press. Previously neither direction existed, so accounts, tokens and deep links had to be retyped by hand. Paste works everywhere including plain-HTTP LAN; copy needs the dashboard over HTTPS or localhost, because proving the copy actually landed takes a round trip and no clipboard API available on plain HTTP accepts a value arriving that late — on plain HTTP the copy still reaches the device and the dashboard says why it stopped there. The agent presses the device-side chord itself and confirms the clipboard changed before answering, so a slow device cannot hand back its previous contents as if freshly copied.
- MCP `tap`, `swipe`, `press_key` and `press_button` report what actually happened instead of always reporting success. They were fire-and-forget: against a session whose device was not booted the input was dropped and still answered `{tapped: true}`, which also made parallel test results untrustworthy.

### Fixed

- Cmd/Ctrl+C, +V and +X on Android typed the letter into the app instead of copying, pasting or cutting. The key handler ignored the Ctrl/Meta modifier; a chord is now a command, not text.
- No audio from Android in the dashboard, with the emulator's sound coming out of the agent Mac's speakers instead. The bundled encoder binary lost its executable bit on a fresh install, so the agent fell back from the emulator's gRPC backend to scrcpy — and audio capture and host-mute only exist on the gRPC path. Only visible with the dashboard and the agent on separate Macs.
- iOS sessions silently dropped every tap, swipe and keystroke after an agent reconnect. The input channel was created only during `device:boot`, so a session that came back without one discarded input with no error — and the device looked responsive because screenshots and UI-tree reads travel a different path.

### Changed

- Agents advertise what they implement in `agent:register`, and the relay echoes it to the viewer on `session:joined`. Absent means unsupported, so an agent older than a capability keeps working untouched rather than being probed by timeout.

## [0.16.0] - 2026-07-22

### Added

- Flow selectors gain two optional disambiguators for the object form: `role` narrows by element kind (e.g. `{ label: "New Orders", role: button }` when a button and its inner text share a label), and `index` (0-based) picks the Nth remaining match (e.g. `{ role: cell, index: 2 }` for a label-less, id-less row). Additive — bare-string and `{ id }` / `{ label }` selectors are unchanged; the object form now needs at least one of `id` / `label` / `role`.
- MCP `run_flow` installs the build before replaying when `buildId` is set (parity with `tapflow flow run --build`), so a flow's `clearState` / `launchApp` finds the app present even after a session ended or the app was never installed. Pass `install: false` to skip.
- MCP `shutdown_device` — powers a session's booted simulator/emulator down to free resources or force a cold boot next time. Distinct from `disconnect_device`, which only leaves the session and keeps the device running.

### Fixed

- `tapflow flow run`: wait steps (`tapOn` / `assertVisible` / `assertNotVisible`) no longer fail the instant a ui-tree query throws — e.g. the app not being in the foreground yet right after `launchApp`. The poll loop retries transient query failures (foreground race, idle timeout, network) until the step deadline while failing fast on permanent ones (bad request, auth, missing session), and bounds each query with an abort signal so a stalled response can't block past the deadline. This removes the long-press-as-sleep workaround.

### Security

- Pinned transitive dependencies past their advisories via `pnpm.overrides`: `axios` ≥ 1.18.0 (GHSA-xj6q-8x83-jv6g), `protobufjs` ≥ 7.6.5 (GHSA-j3f2-48v5-ccww), `body-parser` ≥ 2.3.0 (GHSA-v422-hmwv-36x6), and `js-yaml` 4.x ≥ 4.3.0 (GHSA-52cp-r559-cp3m).

## [0.15.0] - 2026-07-20

### Added

- `tapflow migrate data-dir` — a one-shot command that moves a legacy `.tapflow-data/` into the unified `.tapflow/data/` layout: atomic rename (no copy, no data loss), repoints `local.dataDir` in `tapflow.config.json` when it pinned the old default, and updates `.gitignore`. Idempotent; conflicting or cross-filesystem states stop with manual guidance.
- `tapflow setup android` installs Android `build-tools` (pinned `35.0.0`), and `tapflow doctor` gains an `aapt (build-tools)` check — apk metadata extraction needs it.

### Breaking Changes

- `POST /api/v1/builds`: an `.apk` upload that specifies `app_id` is now rejected with `400` whenever the relay can't read the APK's package name (Android build-tools / `aapt` missing, or the APK itself unreadable/corrupt), instead of storing an unversioned build under that app. Migrate: install build-tools on the relay host with `tapflow setup android` (or re-export a valid APK), or omit `app_id` to file the build separately.
- The default relay data directory moved from `.tapflow-data/` to `.tapflow/data/`, unifying all project state under a single `.tapflow/` root (`data/` runtime, `flows/` committed, `artifacts/` screenshots). **Existing installs keep working without action:** a `tapflow.config.json` that pins `local.dataDir` (which older `tapflow init` wrote) is honored as-is, and a config-less default install keeps reading a pre-existing `.tapflow-data/` (with a one-line hint). To unify the layout, run **`tapflow migrate data-dir`** once — it atomically renames `.tapflow-data/` → `.tapflow/data/` (no copy, no data loss), repoints `local.dataDir` when it pinned the old default, and adds the runtime paths to `.gitignore`. Cross-filesystem or conflicting states are reported with manual steps instead of guessing. **Docker:** the image volume moved from `/app/.tapflow-data` to `/app/.tapflow/data` — remount your data volume at the new path.

### Changed

- `tapflow flow run` now writes failure screenshots to `.tapflow/artifacts/` by default (was `.tapflow-data/artifacts/`), matching the `--artifacts` help text.

### Fixed

- relay: an `.apk` whose metadata can't be read is no longer merged into an unrelated app or false-promoted to platform `both`; without `app_id` it is isolated under its own entry. `tapflow doctor` and the relay now share the same `aapt` search paths (`ANDROID_SDK_ROOT` and the Linux SDK path included), so a green doctor no longer masks an upload failure.

## [0.14.0] - 2026-07-09

### Added

- Automated QA axis. `query_ui_tree` (MCP) and `GET /api/v1/sessions/:sessionId/ui-tree` return a unified element schema (`role`/`label`/`identifier`/`frame`/`enabled`) with frames normalized 0–1, so a frame center feeds straight into `tap`. iOS reads the tree via a resident XCUITest runner inside the simulator — window-agnostic (no Simulator.app window, no WebDriverAgent); Android via `uiautomator dump` with a device-side timeout (#133).
- `@tapflowio/flow-runner` (new package) and `tapflow flow run` replay YAML flows with zero LLM calls: a 10-step vocabulary, identifier/label selector resolution, condition-based waits, JUnit reports, failure screenshots, and a CI exit-code contract (0 pass / 1 flow failed / 2 env error).
- `run_flow` (MCP) — an agent authors a flow once, then replays it deterministically over the existing session.
- relay `app:clear-state` — reset app data (Android `pm clear`, iOS data-container wipe).
- `@tapflowio/mcp-server` and `@tapflowio/flow-runner` graduate from the `experimental` dist-tag to the standard npm channel, versioned with the repo-wide fixed group.

### Changed

- Text entry waits for an `input:type-done` ack so a following key press stays correctly ordered. **A self-hosted agent older than v0.14.0 does not send this ack — update the agent and relay together, or text steps will time out.**

### Fixed

- mcp: `type_text`, cross-platform hardware buttons, and input payloads aligned with the agent protocol (#376, #377).

## [0.13.0] - 2026-07-05

### Added

- relay: outbound webhooks for build review-status changes. The relay POSTs to registered URLs when a build's review status transitions to `Done` or `Rejected`, so review outcomes can flow into Slack or the next CI step. Register at runtime via `POST /api/v1/webhooks` (`builds:write` scope) or declare endpoints in `tapflow.config.json` (`webhooks`, with signing secrets read from env vars). Deliveries carry metadata only — never app binaries — and are HMAC-SHA256 signed (`X-Tapflow-Signature`) when a secret is set. Registration blocks loopback and cloud-metadata addresses (#367).

## [0.12.0] - 2026-07-03

### Added

- relay: accept EAS `eas build` iOS simulator artifacts (`.tar.gz` / `.tgz`) as a first-class build upload, alongside `.app.zip` (iOS) and `.apk` (Android). The archive is stored as-is and extracted with `tar` at install time — no re-zip — so the `.app`'s executable bits and symlinks are preserved. Uploads are validated before storage: path traversal (`..`/absolute), symbolic/hard links, corrupt gzip, and gzip bombs (`TAPFLOW_MAX_UNPACKED_BYTES`, default upload cap ×4) are rejected. Expo/EAS teams can now run `eas build → CI → tapflow` and upload the native `.tar.gz` directly, with no CI re-packaging step (#362).

## [0.11.1] - 2026-07-02

### Added

- relay: Docker support and a container image publish workflow, so the relay can be self-hosted as an image instead of only from source (#352).
- docs: add navigation links to the project changelog.

### Changed

- deps: bump the npm minor/patch dependency group (22 updates).

### Fixed

- ios: physical device-frame buttons are confined to the bezel — a tap inside the screen area is no longer hijacked as a button press on devices where a button sits near the edge (e.g. iPhone SE). HID buttons also support press-and-hold via an optional `phase: 'down' | 'up'` on `input:button`; existing single-press clients are unaffected.
- dashboard: use the `TimerOff` icon for the cancel-deletion action.

### Security

- Patch js-yaml to 3.15.0 to address CVE-2026-53550.

## [0.11.0] - 2026-06-29

### Added

- audio: simulator/emulator audio output is streamed to the browser, **on by default** on both iOS and Android (opt out with `TAPFLOW_AUDIO=off`). iOS taps the whole simulator process tree via Core Audio process taps (macOS 14.2+) — app audio, WebKit `WebContent`, and system sounds; Android captures over the emulator's gRPC stream. The agent Mac stays muted so audio goes only to the browser — on Android via a shared mute-only process tap (`@tapflowio/audiotap-helper`, macOS 14.2+; below that, use the Mac's volume). The simulator/emulator's own volume is reflected. (#339, #341)
- docs: add self-hosted relay backup guidance for `.tapflow-data/`, Litestream replication, restore order, and non-database artifacts.

### Changed

- build: migrate the monorepo to TypeScript project references and point each package's `exports.types` at the published `dist/*.d.ts` (was `src/`, which isn't in the npm tarball) so consumers resolve types correctly. typecheck/build run via `tsc -b`. Also extracts the shared macOS process-tap helper into `@tapflowio/audiotap-helper`. (#345)

### Fixed

- android: concurrent emulators now each use their own gRPC port (discovered from the running emulator's `.ini`) instead of a fixed `8554`, which collided and made every session show the first emulator's screen.
- cli: `tapflow setup android` now treats a missing emulator binary or Android system image as a partial SDK and repairs it instead of reporting the SDK as ready.
- cli: `tapflow doctor` now checks whether the default relay port 4000 is already in use and prints the `lsof -ti:4000 | xargs kill` recovery command before `tapflow start` hits `EADDRINUSE`.
- cli: `tapflow setup android` now reminds users to open a new shell when the Android SDK rc block already exists but `adb` is still missing from the live `PATH`; `tapflow doctor` now points to the shell-refresh step instead of looping back to setup.

## [0.10.0] - 2026-06-23

### Added

- builds: deletion is now an explicit, manual action decoupled from review status (#258). Marking a build **Done** no longer schedules it for deletion — `status_label` stays a pure review state and purge keys off a new `delete_after` timestamp instead of `completed_at`. Schedule or cancel via `POST`/`DELETE /api/v1/builds/:id/schedule-deletion`; build payloads now include `delete_after`. Migration 012 grandfathers builds already on the old clock (`delete_after = completed_at + TTL`) so upgrades keep reclaiming disk. The App Center shows a deletion-countdown badge separate from the status column with explicit schedule/cancel controls.
- relay: WebSocket heartbeat (ping/pong, 30s) terminates sockets that miss a pong window, so dead agent/browser/stream connections (Wi-Fi loss, sleep, cable pull) are detected promptly instead of lingering until the TCP timeout — evicting stale sessions and clearing the duplicate "Stale" card.
- ios: `capture-wait` diagnostic metric under `TAPFLOW_STREAM_METRICS=1` — the polling gap between an IOSurface change and when the frame is encoded, emitted per 150-sample window. Capture behavior is unchanged.

### Changed

- cli: `tapflow setup` reports per-step state (found / created / repaired) instead of a binary result, so you can see which prerequisites were already in place versus newly provisioned. Android SDK env registration that was already present is reported as "repaired" rather than "found".
- relay: build-upload validation errors are returned in English, matching the rest of the API (previously the `.app.zip` format, missing-`.app`-directory, and device-only-slice messages were Korean only).

## [0.9.2] - 2026-06-20

### Changed

- cli: unify the stream-quality tier label to "Smooth".

### Fixed

- cli: `tapflow start` now wires TLS like `relay start`, so the all-in-one path can serve HTTPS/WSS for secure-context streaming (Smooth/WebCodecs) to LAN teammates — previously only `relay start` did. The co-located agent trusts the localhost `wss://` cert only (it never leaves the machine); external relays keep full verification.
- cli: include `--token` in the agent connect hint for remote relays.
- agent: prevent display sleep by default (`caffeinate -di`) so the host Mac keeps streaming during a session.
- relay/agents: dedup agent re-register by machine id, removing duplicate "Stale" cards.
- relay: reject in-flight screenshots when an agent is evicted on re-register.
- ios: 16-align downscaled encode dimensions to remove the WASM (tinyh264) green edge on the no-downscale tier.

### Security

- Bump nodemailer to 9.0.1 — the message-level `raw` option bypassed `disableFileAccess`/`disableUrlAccess`, enabling arbitrary file read and full-response SSRF (GHSA-p6gq-j5cr-w38f). relay uses a plain SMTP send path, so real-world exposure was nil.
- Bump undici to 7.28.0 (TLS certificate validation bypass via SOCKS5 ProxyAgent, GHSA-vmh5-mc38-953g) and override dompurify to 3.4.11 (`ALLOWED_ATTR` pollution via `setConfig()`, GHSA-cmwh-pvxp-8882) — both dev/build-only transitive dependencies. Remove an orphaned dashboard lockfile the security graph scanned as a duplicate manifest.

## [0.9.1] - 2026-06-18

### Changed

- relay: every secret can now live in `.tapflow-data/.env`, not just DNS/ACME tokens. The relay loads `.env` before reading its config, so `JWT_SECRET`, the SMTP password, and the tunnel token are picked up from there too. Precedence is shell env > `.env` > config file (a shell variable still overrides the file); `TAPFLOW_DATA_DIR` is the exception since it determines where `.env` lives.

## [0.9.0] - 2026-06-17

### Added

- LAN HTTPS: the relay terminates TLS in-process with automatic certificates — Let's Encrypt via DNS-01 (Cloudflare / Vercel) or bring-your-own — backed by a disk certificate store with automatic renewal. It auto-publishes the detected LAN IP to the configured domain's A record and self-heals it so the HTTPS hostname keeps resolving on the local network. `tapflow init` gains a guided HTTPS setup step; DNS/ACME credentials load from a gitignored `.env` file namespaced under `TAPFLOW_`. This enables WebCodecs-based low-latency streaming, which requires a secure context. Requires Node >= 20.12.0.
- dashboard: a performance-mode indicator in the session info strip shows the active decode path, with a Standard-mode upgrade notice.
- relay: upload size limits are configurable via `TAPFLOW_MAX_BUILD_BYTES` / `TAPFLOW_MAX_COMMENT_BYTES`.

### Changed

- relay: serves brotli-precompressed static assets with immutable caching for faster dashboard loads.
- dashboard: route-level code splitting (`React.lazy`) and a lighter chart stack (visx, replacing recharts) shrink the initial bundle; variable fonts are trimmed to woff2 + latin subsets.
- relay: hardened for public exposure — CORS is restricted to the configured origins instead of `*`, cookie-authenticated state-changing requests need a same-origin / allowlisted origin (lightweight CSRF guard; PAT requests exempt), and invite links are built from the configured base URL instead of the request `Host` header.

### Fixed

- relay: handler exceptions are logged (method, path, stack) instead of silently swallowed, so 5xx failures are diagnosable. Response bodies still return a generic message and PATs are masked.
- relay: robust `Accept-Encoding` negotiation for static assets.

### Security

- Bump esbuild, hono, and other transitive dependencies to clear open Dependabot advisories. Add `.github/dependabot.yml` for weekly grouped updates, excluding semver-major (reviewed manually).

## [0.8.2] - 2026-06-13

### Changed

- relay: a per-install JWT secret is now generated and persisted automatically when `JWT_SECRET` is unset, replacing the shared development default. No action is needed for a single relay; set `JWT_SECRET` only to share one key across multiple instances.
- relay: login attempts are rate-limited with exponential backoff (per IP + account).
- relay: first-time bootstrap (`auth/init`) is restricted to localhost. On headless servers, run `tapflow admin init` on the relay host.

### Added

- relay: `TAPFLOW_TRUSTED_PROXIES` — when the relay runs behind a same-host reverse proxy, set this so it resolves the real client IP from `X-Forwarded-For` instead of treating every proxied client as localhost. Configure the proxy to forward `X-Forwarded-For`.

## [0.8.1] - 2026-06-12

### Changed

- relay: agents connecting from another machine now authenticate with a token. A relay only accepts a remote agent that presents a PAT with the new `agent` scope (create one in Settings → Tokens; pass it via `tapflow agent start --token` or `TAPFLOW_AGENT_TOKEN`). Agents on the same machine as the relay (`localhost`, e.g. `tapflow start`) stay unauthenticated. See [Remote relay authentication](https://github.com/jo-duchan/tapflow/blob/main/docs/guide/agent.md#remote-relay-authentication).
- ios: `tapflow agent start --device` is a relay-exposure filter (which simulators are offered), not a boot target. `connect` no longer pre-boots a simulator — booting stays on-demand via the dashboard.

### Fixed

- relay: restore remote agent connections (#271). A prior security fix closed every non-loopback WebSocket without a credential, so no remote agent could register and the agent hung at "Connecting ios agent…". Remote agents connect again, authenticated; the agent also fails fast with a clear reason instead of hanging on a rejected or malformed handshake.
- relay: bind dual-stack (IPv4 + IPv6) so an agent on another Mac connecting over `ws://<ipv4>:4000` no longer times out (#269).
- ios: auto-recover a simulator whose data directory vanished from disk (an Xcode/macOS update can prune it) — the agent erases and retries the boot once instead of failing.

## [0.8.0] - 2026-06-11

### Added

- cli: `tapflow setup [platform]` — guided, one-pass environment setup. Auto-detects platforms when run without an argument. iOS opens the App Store for Xcode, activates it (license / first-launch), and downloads a simulator runtime. Android installs a JDK and builds a self-contained SDK at `~/Library/Android/sdk` (command-line tools, platform-tools, emulator, system image — no Android Studio GUI), then creates a set of AVDs across form factors. Booting stays on-demand via the relay.
- cli: `tapflow doctor [platform]` — checks a single platform or all. iOS shows Xcode / simctl / Simulator; Android shows SDK / adb / AVD (symmetric). `--json` emits machine-readable output; a device/AVD only needs to exist, not be running.

### Changed

- cli: `doctor` reports a missing prerequisite as a failure consistently across iOS and Android, and no longer triggers the macOS Command Line Tools install popup on a machine without Xcode.

## [0.7.0] - 2026-06-08

### Added

- android: emulators now capture over gRPC and encode H.264 on the Mac host (VideoToolbox). The gRPC backend is the default for emulators (auto-detected, 30fps cap), with automatic scrcpy fallback; real devices continue to use scrcpy.
- streaming: unified per-session downscale. Resolution is chosen from the viewer's connection context — native on a secure context, 1280px on LAN-HTTP, 1000px external — and is tunable via `TAPFLOW_MAX_SIZE` and the per-platform / `_LAN` / `_EXTERNAL` overrides.
- relay: request an IDR keyframe when a browser (re)joins a booted device, so a late joiner paints immediately.

### Changed

- dashboard: iOS/Android decoding and perf telemetry are unified behind a single `useDecoderStream` hook (hardware WebCodecs on a secure context, WASM fallback otherwise).
- ios-agent: static-frame skip — unchanged H.264 frames are no longer re-sent.

### Fixed

- ios: tear-free framebuffer snapshots via a seed-stable copy, and keyframe-aware backpressure on the agent→relay stream.
- android: keyframe-aware backpressure on the agent→relay stream, and 16-aligned encode sizing to avoid macroblock padding on the WASM decoder.

## [0.6.1] - 2026-06-06

### Fixed

- android: fix a crash when the scrcpy video stream is cancelled. The v0.6.0 socket-close cleanup could call `close()`/`error()` on an already-closed stream controller, throwing inside the socket event handler.

## [0.6.0] - 2026-06-06

### Added

- android: opt-in stream throughput metrics (`TAPFLOW_STREAM_METRICS=1`) logging fps / KB·s / drop every 5s, matching the iOS agent.
- agents: hold a macOS power assertion (`caffeinate -i`) while connected so an unattended/idle Mac doesn't throttle the simulator/emulator. macOS-only; no-op elsewhere.

### Changed

- android: H.264 frames now carry the codec/keyframe flags in the stream envelope, so the relay's keyframe-aware backpressure drops to the next keyframe under LAN congestion instead of forwarding P-frames that tear. (scrcpy `send_frame_meta=true`; the public `stream()` contract is unchanged.)
- android: on-demand IDR recovery — `stream:request-idr` now resets the scrcpy encoder (RESET_VIDEO), resyncing fast instead of waiting for the periodic IDR (parity with iOS).

### Fixed

- android: the scrcpy stream now terminates on socket close, so the agent's pump and its timers no longer leak after a device shuts down.

## [0.5.1] - 2026-06-06

### Fixed

- android: screen rotation on Android 15+ (API 35+). `AdbWrapper.setRotation` now uses `wm user-rotation lock` instead of the legacy `settings put system user_rotation`, which newer Android silently ignores (only a rotation suggestion appears). The bundled scrcpy server is upgraded 3.1 → 3.3, fixing the locked capture-orientation direction (scrcpy #6010) that left the stream sideways after rotation. Verified on API 34 and API 36 emulators.

## [0.5.0] - 2026-06-04

### Added

- H.264 streaming pipeline: iOS streams H.264 by default via a VideoToolbox encoder, cutting bandwidth ~10× vs JPEG (~16–27 KB/frame vs ~235 KB) for noticeably lower latency. Android streaming moves to a runtime decoder layer.
- Automatic codec negotiation: the browser advertises its decode capability (`acceptH264`) at boot; the agent picks H.264 only when the client can decode it, otherwise falls back to JPEG — no black screens on older browsers. Opt out with `TAPFLOW_IOS_CODEC=jpeg`.
- Tiered browser decoders: HTTPS → WebCodecs, plain-HTTP LAN → WASM (tinyh264), both WebGL2-rendered.
- cli: `tapflow start` prints the public tunnel URL banner (Tailscale MagicDNS host / tailnet IP auto-detected); a missing rathole token now falls back to local-only instead of exiting.
- dashboard: 404 error page and rectangular auth submit button.

### Changed

- envelope: codec/keyframe marker added to the frame header (byte5 flags). Backward compatible — older clients read frames as JPEG and the relay forwards payloads untouched; agents without `acceptH264` (version skew) default to JPEG.
- ios-agent: lower the default JPEG stream quality `0.95` → `0.8`, cutting iOS frame bandwidth ~40% on idle/simple screens to reduce relay→browser frame drops on LAN. Tune with the `TAPFLOW_JPEG_QUALITY` env var (`0`–`1`).

### Fixed

- android: landscape rotation and recording via a locked stream + local intent.

## [0.4.1] - 2026-06-01

### Security

- relay: fix path traversal in `/uploads/` — `serveUpload` now validates that the resolved file path stays within `uploadsDir`; requests that escape the directory return 403.
- relay: `/uploads/` route now requires view authentication — unauthenticated requests return 401 before file serving.
- relay: WebSocket connections from non-localhost clients without a valid JWT cookie or PAT are rejected with close code 1008.
- relay: WebSocket role gating — browser-role sockets that send agent-only messages (`agent:register`, `agent:resources`, etc.) are disconnected immediately.

## [0.4.0] - 2026-06-01

### Breaking Changes

- `tapflow init` no longer creates an admin account. It now scaffolds `tapflow.config.json`.
  - **Before:** `tapflow start` (auto-created config) → `tapflow init` (admin creation via CLI)
  - **After:** `tapflow init` (scaffold config) → `tapflow start` → open `/setup` in browser (admin creation)
  - **Migrate:** use the `/setup` page on first launch, or `tapflow admin init` in headless environments.
- `tapflow start` and `tapflow relay start` no longer create `tapflow.config.json` as a side effect. Run `tapflow init` explicitly, or skip it to use built-in defaults (port 4000, `.tapflow-data/`).

### Added

- `tapflow init` — scaffold `tapflow.config.json` interactively; `--tunnel tailscale|rathole` for non-interactive mode; `--force` to overwrite.
- `tapflow init` auto-updates `.gitignore` — creates the file if absent, appends `.tapflow-data/` if not already present.
- `tapflow admin init` — create the first admin account via CLI (headless / CI fallback).
- Dashboard `/setup` page — web-based first admin account creation; auto-redirected from `/login` when no accounts exist.
- `GET /api/v1/auth/status` — public endpoint returning `{ initialized: boolean }`.
- Tailscale tunnel provider (`tunnel.provider: "tailscale"`) — E2E encrypted, no VPS required.

### Removed

- Automatic `tapflow.config.json` creation as a side effect of `tapflow start` / `tapflow relay start`.

[Unreleased]: https://github.com/jo-duchan/tapflow/compare/v0.19.0...HEAD
[0.19.0]: https://github.com/jo-duchan/tapflow/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/jo-duchan/tapflow/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/jo-duchan/tapflow/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/jo-duchan/tapflow/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/jo-duchan/tapflow/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/jo-duchan/tapflow/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/jo-duchan/tapflow/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/jo-duchan/tapflow/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/jo-duchan/tapflow/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/jo-duchan/tapflow/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/jo-duchan/tapflow/compare/v0.9.2...v0.10.0
[0.9.2]: https://github.com/jo-duchan/tapflow/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/jo-duchan/tapflow/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/jo-duchan/tapflow/compare/v0.8.2...v0.9.0
[0.8.2]: https://github.com/jo-duchan/tapflow/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/jo-duchan/tapflow/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/jo-duchan/tapflow/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/jo-duchan/tapflow/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/jo-duchan/tapflow/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/jo-duchan/tapflow/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/jo-duchan/tapflow/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/jo-duchan/tapflow/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/jo-duchan/tapflow/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jo-duchan/tapflow/compare/v0.3.1...v0.4.0
