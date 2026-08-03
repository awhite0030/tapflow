# @tapflowio/ios-agent

## 0.18.0

### Patch Changes

- 971e375: Remove the dead `Simulator.app` hide from `SimctlWrapper.boot`. On the supported Xcode (26.x) `simctl boot` does not open Simulator.app, so the `osascript` call failed with `-10006` on every boot while its callback swallowed the error — it hid nothing, and its silence meant nobody would notice if the assumption changed back. The occlusion throttle it was guarding against only applies to a window that is on screen. Verified by quitting Simulator.app entirely and booting from the dashboard: no Simulator process appears.

  Also make `SimctlWrapper.shutdown` tolerate an already-stopped device, mirroring the guard `boot` has had. Tearing down a session whose device is already `Shutdown` raised `code=405 / Unable to shutdown device in current state: Shutdown`, so a routine teardown logged `shutdown failed` and became indistinguishable from a device that genuinely refused to stop.

- bd9eb37: Fix Full reset erasing devices nobody asked to erase, and failing on the ones people did.

  Two defects that were only safe together. `resetMode` lived in a `useState` that nothing reset: leaving a session with `← All Macs` is a conditional re-render, not an unmount, so an armed toggle survived it and the _next_ device the tester picked was erased too. Separately, `IOSAgent` called `simctl erase` without checking device state, and `erase` refuses a device that is not shut down — so an explicit Full reset on a device that was already running died with `Boot failed: Command failed: xcrun simctl erase <udid>`.

  The second was containing the first: the unwanted erase usually targeted a booted device, so it threw and destroyed nothing. Fixing only the agent would have turned that loud failure into silent data loss, so both move together.

  - **dashboard**: Full reset is now a one-shot intent — arming it applies to the next device you pick and then disarms itself. Asking twice means turning it on twice. The mode the viewer was launched with is held separately from the toggle, so disarming does not disturb the running session.
  - **dashboard**: only the first `device:boot` of a viewer mount carries the reset. `session:joined` arrives again on every socket reconnect, so a Wi-Fi blip or a sleeping laptop would otherwise re-erase the device the tester is looking at, with no click involved.
  - **dashboard**: the toggle is not offered on Android, where nothing acts on it (#447). It used to stay visibly on having done nothing; self-disarming would have made that read as "done".
  - **ios-agent**: shut a running device down before erasing it. Any state other than `Shutdown` gets the shutdown — `Booting` and `Shutting Down` refuse an erase exactly as `Booted` does, and re-picking a device while its shutdown is still draining lands there. The request is never silently skipped.
  - **ios-agent**: if the erase itself fails, boot the device back up before reporting the error — but only when the device really was running and no newer boot has overtaken this one. The shutdown was ours to undo; a device that was already stopping, or one the tester has since asked to stop, is not.

- 535c726: Target the session's simulator, not "whichever one is booted".

  Every app command in `SimctlWrapper` passed `booted` — simctl's alias for the running device — instead of the session's udid: `install`, `launch`, `uninstall`, `terminate`, `get_app_container`, `io screenshot`. With one simulator up that happens to be right. With two, the command lands on whichever simctl picks, and the wrong device accepts it without complaint. Today the defect usually surfaces as `No devices are booted` — loud, and only because nothing was running at all. The quiet case is the one worth fixing.

  `AndroidAgent` already passes an explicit serial; this brings iOS in line.

  - The udid is a required leading parameter with **no default**. A default is how the alias would come back: every call site keeps compiling and every test stays green while the old behaviour returns. `ScreenCaptureStreamer`'s `udid: string = 'booted'` was exactly that, and it is gone too.
  - Session call sites pass `DeviceState.deviceId`. `MjpegStreamer` takes the device through its constructor rather than reaching for the alias mid-stream.
  - The three `DeviceAgent` entry points (`installApp`, `launchApp`, `screenshot`) have no device parameter — the interface is shared with Android and predates multi-session agents. They resolve the one **booted** session and throw when there is none, or when there is more than one. Filtering on booted matters: the relay opens a session per registered simulator, so "the first entry" is whichever simctl listed first, usually shut down — worse than the alias, which at least found the device that was running.

  The same lookup backed `queryUITree`, `stream`, `openUrl` and the input methods, so they went through it too. Input does nothing rather than throwing when the answer is ambiguous — refusing a tap is worse than dropping one.

  One call the compiler could not catch: `screenshot(format)` stayed type-correct when a leading `udid: string` was added — the format string simply became the device id. Tests assert the arguments rather than trusting the signature.

  - @tapflowio/agent-core@0.18.0
  - @tapflowio/audiotap-helper@0.2.8

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

- eaa78ac: Fix iOS sessions that silently dropped every tap, swipe and keystroke after an agent reconnect.

  The input channel was created only during `device:boot`. When an agent reconnected while the simulator stayed booted, the session came back without one, so touch, pinch, key and button input were discarded with no error — the device looked responsive because screenshots and UI-tree reads went through a different path. Input now sets the channel up on demand.

  Buttons addressed by name still need a fresh `device:boot`; that is a narrower gap tracked separately.

  - @tapflowio/agent-core@0.17.0
  - @tapflowio/audiotap-helper@0.2.7

## 0.16.0

### Patch Changes

- @tapflowio/agent-core@0.16.0
- @tapflowio/audiotap-helper@0.2.6

## 0.15.0

### Patch Changes

- @tapflowio/agent-core@0.15.0
- @tapflowio/audiotap-helper@0.2.5

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
  - @tapflowio/audiotap-helper@0.2.4

## 0.13.0

### Patch Changes

- @tapflowio/agent-core@0.13.0
- @tapflowio/audiotap-helper@0.2.3

## 0.12.0

### Minor Changes

- Accept EAS `eas build` iOS simulator artifacts (`.tar.gz` / `.tgz`) as a first-class build upload, alongside `.app.zip` and `.apk`. The archive is stored as-is (no re-zip) and extracted with `tar` at install time, so the `.app`'s executable bits and symlinks are preserved. Uploads are validated before storage — path traversal (`..`/absolute), symbolic/hard links, corrupt gzip, and gzip bombs (`TAPFLOW_MAX_UNPACKED_BYTES`, default upload cap ×4) are rejected. This removes the CI re-packaging step for Expo/EAS teams: `eas build → CI → tapflow` uploads the native `.tar.gz` directly.

### Patch Changes

- @tapflowio/agent-core@0.12.0
- @tapflowio/audiotap-helper@0.2.2

## 0.11.1

### Patch Changes

- Confine physical device-frame buttons to the bezel and add button press-and-hold.

  A tap inside the screen area is no longer hijacked as a button press (previously a circular hit-test around each button center could overlap the screen on devices where a button sits near the bezel, e.g. iPhone SE). HID buttons now support real-time hold: `input:button` accepts an optional `phase: 'down' | 'up'` so a button can be held instead of only tapped. The field is optional, so existing single-press clients (e.g. MCP sending `{ name }`) are unaffected.

  - @tapflowio/agent-core@0.11.1
  - @tapflowio/audiotap-helper@0.2.1

## 0.11.0

### Minor Changes

- 0c2b82c: Simulator audio output (device → browser) is now **on by default** for both iOS and Android. Opt out with `TAPFLOW_AUDIO=off` — one env for both platforms (`agent start --ios/--android` already selects the platform). The no-degradation contract (audio yields to video) keeps the video path safe whether audio is on or off.

  **iOS**: simulator processes are host processes, so tapflow taps the whole simulator's process tree with a Core Audio process tap (macOS 14.2+) — app audio + WebKit `WebContent` (web audio, e.g. YouTube in Safari) + system sounds, with no device routing, no dylib injection, no host-output hijack, on any signed build. The tap stays current as processes spawn and start/stop audio (process-tree polling + a Core Audio process-object listener); each simulator is isolated (no cross-bleed); the sim's own volume is reflected; and the host (agent Mac) stays muted so audio goes only to the browser. The audio-capture permission is primed at `tapflow agent start` — re-run it if browser audio is silent.

  **Android**: emulator audio is captured over gRPC `streamAudio`. Unlike iOS, the emulator also plays to the host Mac (it has no host-output-only mute) — use the Mac's own volume to silence it.

  Capture normalizes to 44100/Stereo/S16 and rides the existing `CODEC_AUDIO` transport. The capture runs in a small signed helper (`audiotap-helper`, iOS) launched via LaunchServices so it holds its own one-time audio-recording grant.

### Patch Changes

- 6bd8ebe: Symmetric host-mute for Android (#341): the emulator's audio no longer leaks to the agent Mac's speakers.

  The macOS Core Audio process-tap helper is now a shared package, `@tapflowio/audiotap-helper` (moved out of `ios-agent`), used by both platforms — so android-agent depending on it is a clean direction (no cross-platform-agent dependency). On macOS 14.2+, android-agent holds a **mute-only** `.muted` tap on the emulator's qemu process, silencing its host output while gRPC keeps capturing for the browser — matching iOS's `muteBehavior=.muted`. The helper self-exits when qemu dies; below 14.2 / non-macOS it's a no-op (fall back to the Mac's volume). `tapflow agent start` / `start` now also prime the audio-capture permission when Android is selected.

  `ios-agent` keeps the same public API (`requestAudioPermission`/`isAudioSupported` are re-exported from the shared package); only the helper's internal location changed.

- 3377bfe: Fix the package type entrypoint for npm consumers (#345). `exports.types` now points at the published `dist/*.d.ts` instead of `src/` — which isn't shipped in the tarball (`files` ships only `dist`/`bin`), so consumers couldn't resolve the package's types.

  The monorepo moves to **TypeScript project references** (each lib package gets `composite: true` + `references`, plus a root solution `tsconfig.json`). `typecheck`/`build` run via `tsc -b`, so workspace typecheck stays build-light (incremental, no manual dist build) while the published packages expose correct types from `dist`. No runtime or public API changes.

- Updated dependencies [6bd8ebe]
- Updated dependencies [3377bfe]
  - @tapflowio/audiotap-helper@0.2.0
  - @tapflowio/agent-core@0.11.0

## 0.10.0

### Patch Changes

- c3ea54c: The iOS screen-capture helper now reports a `capture-wait` metric under `TAPFLOW_STREAM_METRICS=1` — the polling gap between an IOSurface change and when the frame is encoded, emitted as `info: capture-wait avg/max/n` per 150-sample window. Diagnostic only; capture behavior is unchanged.
  - @tapflowio/agent-core@0.10.0

## 0.9.2

### Patch Changes

- 16-align downscaled encode dimensions to remove the WASM (tinyh264) green edge on the no-downscale tier.
- Updated dependencies
  - @tapflowio/agent-core@0.9.2

## 0.9.1

### Patch Changes

- @tapflowio/agent-core@0.9.1

## 0.9.0

### Patch Changes

- @tapflowio/agent-core@0.9.0

## 0.8.2

### Patch Changes

- @tapflowio/agent-core@0.8.2

## 0.8.1

### Patch Changes

- 80f4d78: iOS: auto-recover a simulator whose data directory vanished from disk. When an Xcode/macOS update prunes a runtime, `boot` fails with "cannot be located on disk"; the agent now erases the device to regenerate its data and retries the boot once (guarded so a healthy device is never erased), so dashboard/MCP sessions no longer dead-end on a broken simulator.

  Pre-boot is removed: `tapflow start` no longer boots a guessed device on startup. The agent only registers devices and boots on demand via `device:boot` (parity with android-agent). As a result, `--device` is now a relay-exposure filter (which simulators are exposed, default: all), not a boot target.

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

- 80f4d78: iOS: auto-recover a simulator whose data directory vanished from disk. When an Xcode/macOS update prunes a runtime, `boot` fails with "cannot be located on disk"; the agent now erases the device to regenerate its data and retries the boot once (guarded so a healthy device is never erased), so dashboard/MCP sessions no longer dead-end on a broken simulator.

  Pre-boot is removed: `tapflow start` no longer boots a guessed device on startup. The agent only registers devices and boots on demand via `device:boot` (parity with android-agent). As a result, `--device` is now a relay-exposure filter (which simulators are exposed, default: all), not a boot target.

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

### Minor Changes

- Robust Android LAN streaming — keyframe-aware backpressure, on-demand IDR recovery, and idle-throttle prevention.

  - Android H.264 frames now carry the codec/keyframe flags in the stream envelope, so the relay's keyframe-aware backpressure preserves the reference chain under LAN congestion — it drops to the next keyframe instead of forwarding P-frames that tear. (`scrcpy send_frame_meta=true`; the public `stream()` contract is unchanged.)
  - On-demand IDR recovery for Android: the relay's `stream:request-idr` now resets the scrcpy encoder (RESET_VIDEO), resyncing fast instead of waiting for the periodic IDR — bringing Android congestion recovery to parity with iOS.
  - Agents hold a macOS power assertion (`caffeinate -i`) while connected so an unattended/idle Mac doesn't throttle the simulator/emulator. macOS-only; no-op elsewhere.
  - Fixed: the Android scrcpy stream now terminates on socket close, so the agent's pump and its timers no longer leak after a device shuts down.
  - Added: opt-in Android stream throughput metrics (`TAPFLOW_STREAM_METRICS=1`), matching the iOS agent.

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

- @tapflowio/agent-core@0.1.0

## 0.1.0-alpha.8

### Patch Changes

- @tapflowio/agent-core@0.1.0-alpha.8

## 0.1.0-alpha.7

### Patch Changes

- @tapflowio/agent-core@0.1.0-alpha.7

## 0.1.0-alpha.2

### Patch Changes

- @tapflowio/agent-core@0.1.0-alpha.2
