---
type: rules
topics: [android, emulator, adb]
status: living
---

# android-agent — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

`AndroidAgent`: controls Android emulators/devices via ADB and streams H.264 video over two backends — **gRPC host-encode** (emulators, the default) and **scrcpy** (real devices, and the fallback when gRPC is unavailable). Runs alongside `ios-agent` on the same Mac.

## HOW

- ADB commands are isolated in `AdbWrapper`, swappable with an `AdbRunner` mock in tests.
- **UI tree** (`queryUITree` / `ui:tree:request`): `AdbWrapper.dumpUiHierarchy` runs `adb exec-out timeout 10 uiautomator dump /dev/tty` — the device-side toybox `timeout` bounds the dump because uiautomator waits for an idle window and can hang on continuous animation; a timed-out dump surfaces as an explicit `PlatformError`, never a silent empty tree. `uiTree.ts` parses the XML into the unified `UIElement[]` schema (agent-core); the screen size comes from the root node bounds, so landscape dumps normalize correctly without a `wm size` round-trip.
- On emulator boot: `EmulatorLauncher.waitForBoot(serial)` — polls `sys.boot_completed=1`.
- **Backend selection** (`pickAndroidBackend`): emulators (serial `emulator-*`) → **gRPC**; real devices → **scrcpy**. `TAPFLOW_ANDROID_BACKEND=grpc|scrcpy` overrides. On any gRPC failure (e.g. an emulator booted externally without `-grpc`), `startVideoStream` falls back to scrcpy so streaming still works.
- **gRPC backend (emulator default)**: `EmulatorGrpcClient` connects to the emulator's gRPC endpoint (`-grpc <port>`, default 8554, unsecured localhost) and reads `streamScreenshot` RGBA8888 frames → `EmulatorVideo` pipes them to the `emulator-encoder` Swift helper (Mac VideoToolbox: baseline, B-frames off, BT.709, force-IDR on demand), **bypassing the emulator's slow guest software H.264 encoder**. Mirrors the ios-agent VideoToolbox path so both platforms share one encode pipeline. The screenshot stream is frame-driven (no frames while static), so no static-skip is needed.
- **scrcpy backend (real devices + fallback)**: `ScrcpySession` → `ScrcpyVideo` pushes the scrcpy server to the device, runs it, and receives an H.264 Annex B stream over TCP. Two connections in order — video socket (1st) + control socket (2nd) — before the server begins streaming. `ScrcpyControl` keeps the control socket open. Pin `OMX.google.h264.encoder` (pure software) on a `google_apis/arm64-v8a` (android-34) image — the verified config; the default `c2.android.avc.encoder` (Codec 2.0) shows silent stalls under GPU load that the pump can't detect, and `google_apis_playstore` is untested (see `contributing/android-video-streaming-diagnosis.md`). This guest-encoder constraint applies to scrcpy only — the gRPC path never touches it.
- **Touch** (`PointerControl`): a backend-agnostic pointer interface satisfied structurally by both `EmulatorGrpcClient` (gRPC) and `ScrcpyControl` (scrcpy) — identical method shapes (sync for scrcpy, async for gRPC), so input handlers stay backend-agnostic. Falls back to `AndroidTouchHelper` (`adb input tap/swipe`) when neither video backend is active — and for **buttons on every backend**, which makes it the adb path that actually runs in production.

### Input acks answer with a reason, and the three paths fail differently

Terminal inputs used to ack on a proxy — a channel reference, a serial that resolved, or `state.touchHelper !== null`, which is a constant because that helper has no process. Every one of them reported success for input that never reached the device. The acks now answer on what the dispatch reported, in the vocabulary of `inputOutcome.ts`.

One interface, three unrelated failure signals — this is the part that is easy to get wrong:

| path | dispatch | how failure shows | client-side cancellation |
|---|---|---|---|
| `EmulatorGrpcClient` | promise | rejects; input RPCs carry a deadline | yes, of *our wait* — see the caveat below |
| `ScrcpyControl` | `socket.write()`, returns `void` | **nothing**. `write()` does not throw for a dead peer, so `isReady()` (`socket.writable`) is the only signal | n/a |
| `AndroidTouchHelper` | `adb shell input …` | promise rejects | no — the child is not killed |

Measured against a killed emulator: the gRPC RPC rejects in **4ms** with `14 UNAVAILABLE … ECONNREFUSED`, so an unreachable emulator answers on its own and the deadline never comes into it. `isReady()` stays `true` through that, because for this backend it only reports "we closed it"; the rejection carries the rest.

**What the deadline does and does not buy.** It cancels *our* call, not a request the emulator already applied. Since an unreachable emulator rejects immediately, the only case the deadline actually fires in is a client still connected but not responding — and there we cannot know whether the input landed, so a caller that retries on the error can double it. That is the same hazard that argued against bounding the adb path; it is accepted here only because the window is much narrower (1500ms of silence from a connected emulator, versus every stuck `adb` call). If it turns out to matter, the answer is a distinct outcome meaning "unknown, do not retry", not a shorter deadline.

- **`isReady()` is not a liveness probe.** `socket.writable` is a local-end flag: it goes false after our own destroy, after a FIN (`allowHalfOpen` defaults false, so node ends our writable side), or after an error was already observed. Edge-triggered and one turn late, so the first input after a silent death still reads ready. It cannot see a live socket whose guest stopped consuming. The ack promises delivery, not landing, so that is consistent — do not read more into it.
- **The adb path is deliberately unbounded.** Racing a timer would not help: the child cannot be killed (`bounded()` records why — killing `input` mid-write can leave the guest worse off), so a timeout would answer failure while the input was still on its way, invite a retry, and land it twice. Unbounded means a wedged guest produces no ack and the caller falls back to its own timeout, which is what happened before this change. One child per input the user actually made is the honest ceiling.
  Measured on a booted emulator (Pixel_6_tapflow): **86ms for the first tap** — it pays the `wm size` lookup, cached after — and **26–29ms steady state**. That is 23× under the MCP client's 2s window on the worst measured call and ~70× on a warm one, so a bound could only ever fire on a guest that is genuinely stuck, which is the one case where firing does harm.
- **The vocabulary is not identical to iOS's, and only part of that is a decision.** A *decision*: `unsupported` for an unmapped button, because iOS's unmapped case means the device genuinely has no such button (#484) while ours means we do not know the name. **Not** a decision: `no-session`. iOS's four terminal handlers also `break` silently on a missing state, and iOS actually clears `deviceStates` on disconnect and on reconnect, which makes it *more* reachable there than here — so that is an unfixed asymmetry, and the reason `channel-down` is narrower on this side than on iOS's. `not-booted` and `channel-down` keep their exact wording for the meanings that do overlap. Android also answers `failed`, `malformed` and `no-gesture`, none of which iOS distinguishes.
- `stream:request-idr` (`AndroidAgent.ts`, `scrcpySession.control.resetVideo()`) writes to the same control socket with no check. It is not an ack surface, so it was left alone — but it shares `isReady()`'s limits.
- **Downscale**: the gRPC encode size is capped by `TAPFLOW_ANDROID_MAX_SIZE` (or the cross-platform `TAPFLOW_MAX_SIZE`); the per-session tier (native / 1280 / 1000) comes from the viewer context. 16-aligned so H.264 macroblock cropping doesn't show padding on the WASM decoder.
- **Metrics**: `TAPFLOW_STREAM_METRICS=1` logs the throughput baseline (`stream metrics … fps/KB·s/drop`, every 5 s); gRPC capture fps is set by `TAPFLOW_ANDROID_FPS` (default 30). Full instrumentation surface and the user-facing tuning knobs are in [`contributing/measurement.md`](../../contributing/measurement.md).
- AVD name is the stable key for `Device.id` (`"avd:<name>"`). ADB serial is kept only in the internal `serialMap`.
- `ANDROID_HOME` or `ADB_PATH` environment variable is required. Missing → clear error and immediate exit.
- Apple Silicon Mac: `system-images;android-34;google_apis;arm64-v8a` image required.

### Mapping internal reasons onto the wire

`inputOutcome.ts` keeps this agent's seven internal reasons; `wireReason()` maps them onto the closed
set in `@tapflowio/protocol`. One collapses, and it is recorded rather than assumed:

- `no-session` → `channel-unavailable`. The consumer's move is the same, and promoting it would add a
  wire reason whose reachability is disputed — `relay/src/__tests__/sessionRebind.test.ts` records
  that a restarted agent is re-seeded with its sessions, so `!state` may never fire.

`no-gesture` passes through rather than collapsing into `malformed`, which was the first attempt: its
advice differs. `malformed` tells a caller to fix the call and never retry; a terminal frame with no
gesture behind it is well-formed on a channel that may be healthy, and the caller's move is to open a
new gesture. iOS reaches the same reason by a different route (its gesture-ownership guard).

**This agent produces no `channel-starting`.** iOS has a measured window where its helper is up but
not yet injecting; here a path either has a channel or does not. Written down so the gap is a fact
about the platform rather than an oversight.

## HOW NOT

- Do not hardcode the ADB path — use `$ANDROID_HOME/platform-tools/adb` or `$ADB_PATH`.
- Do not run ADB commands before confirming emulator boot is complete.
- Don't switch to `google_apis_playstore` AVD images without testing — untested, with historical H.264 encoder crashes (odd-width capture). `google_apis` is the verified image. (scrcpy path.)
- Do not revert the scrcpy `video_encoder` to `c2.android.avc.encoder` — it has shown silent stalls / encoder errors under GPU load; the pinned `OMX.google` software encoder is the tested one.
- Do not open only the video socket in `ScrcpySession.start()` and skip the control socket — violates the scrcpy protocol and the server will not start streaming.
- Do not break the `PointerControl` / `AndroidTouchHelper` interfaces to add low-latency touch — replace only the internal implementation. (Both did gain members for input-ack truthfulness — `isReady()`, and outcomes instead of `void` — which is a different reason and is documented above.)
- Do not pollute the `agent-core` `DeviceAgent` interface with Android-specific methods.
- Do not "correct" stream colors toward the Android emulator window (e.g. patching SPS VUI `transfer_characteristics` / colour metadata). Verified 2026-06-02 (scrcpy stream; the gRPC path also encodes BT.709 / limited-range): the stream is correctly signaled and the browser renders it faithfully — tapflow stays **closer to the design source** while the emulator window **over-saturates**. Measured flat `#FF8000`: source G=128 → tapflow G=119 → emulator G=108 (black/white/pure-RGB identical across all three). This fidelity is intended; see `docs/guide/troubleshooting.md` (#colors-look-different-from-the-emulator).
