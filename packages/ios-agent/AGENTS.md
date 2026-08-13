---
type: rules
topics: [ios, simulator, macos]
status: living
---

# ios-agent — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

`IOSAgent`: controls iOS simulators via `xcrun simctl`, streams frames using SimulatorKit IOSurface callbacks, and injects touch / keyboard / button events directly via SimDeviceLegacyHIDClient. No WebDriverAgent.

## HOW

- Assume macOS only. Throw a clear error on non-macOS environments.
- Wrap all xcrun/simctl calls in dedicated functions so they can be swapped with mocks in tests.
- Capture frames via SimulatorKit IOSurface and stream H.264 (default) or JPEG frames as WebSocket binary messages (≤30 fps).
- `connect` only registers devices with the relay — it never boots one. Booting is on-demand via `device:boot` (dashboard / MCP). The `deviceFilter` option (CLI `--device`) narrows which devices are exposed to the relay (parity with android-agent), not a boot target.
- **`device:ready` means the device is up, not that the boot was accepted.** `simctl boot` returns on
  *initiation* and the device reaches `Booted` seconds later — measured 7.6s on an iPhone 17 Pro / iOS 26.5 —
  so `handleDeviceBoot` awaits `SimctlWrapper.waitUntilBooted` before it sends anything (#486). Android has
  always waited (`EmulatorLauncher.waitForBoot`), and a caller that acts on `ready` immediately is the one that
  notices: #440's *No devices are booted* was this half of the race. A boot that never finishes ends at a 90s
  deadline as `device:boot-error`. Four details are load-bearing, and three of them are holes the first draft
  of that wait shipped:
  - **Every status other than `booted` counts as still coming up, `shutdown` included.** `toDeviceStatus`
    collapses `Booting` into `unknown`, and the wait only ever runs after a `boot` was accepted, so a
    `shutdown` reading is the transition not yet observed. A draft gave it a 3s grace and failed early on it;
    that was reverted, because the reading is indistinguishable from a slow machine's healthy boot.
  - **The boot is issued on every path, including when the list already said `booted`** — which is what makes
    the sentence above true. The original on-demand boot skipped it there as an obvious economy; that skip
    became the one route into the wait with *nothing bringing the device up*, so a tester who quit the
    simulator inside one `xcrun` round trip paid the whole deadline. `SimctlWrapper.boot` swallows
    `Unable to boot device in current state: Booted`, so the skip bought one no-op subprocess.
  - **A failed reading is not a reading.** This spawns `xcrun simctl list` up to 180 times where the old code
    spawned it once, each one a chance to kill a healthy boot while CoreSimulator is busiest. Failures are
    swallowed and retried, and the last is reported with the deadline — but only if it is genuinely the last,
    which is why the success path clears it. Android has always swallowed them; the claim of parity with
    `waitForBoot` was false until this did too.
  - **`isStale` cancels the poll from inside.** The handler is fire-and-forget and its `bootSeq` check runs
    only once the wait *returns*, so a shutdown mid-wait would otherwise leave a process spawning twice a
    second against a device that is deliberately off. The check after the wait stays as well — it covers the
    microtask-thin case where the wait has resolved and the seq moves before the handler resumes.

  Still open, and **not** fixed by the above: `mcp-server`'s `boot_device` waits 30s, *inside* the agent's 90s,
  so a cold boot past 30s reports a bare timeout to the LLM rather than the reason the agent is about to send.
  That ceiling was unreachable while the agent answered on boot acceptance.

### Input acks carry a reason

`ackInput` answers `'delivered'` or an `InputErrorReason` from `@tapflowio/protocol` (the contract and
the consumer rules are documented there). The mapping is small but two parts are easy to get wrong:

- **`channel-starting` is not `channel-unavailable`.** `TouchHelper.inputState()` separates them, and
  the difference is the measured 186–247ms in which the helper is up and injecting nothing. Telling a
  caller the channel is gone there sends it to reconnect when it only had to wait.
- **A refusal from a *ready* helper is `no-gesture`, not a channel error.** That is the
  gesture-ownership guard, and the reason carries its own advice: open a new gesture.
- **Ownership is asked before readiness, and the order is the whole point.** The two are decided at
  different times — readiness is about now, ownership was settled when the gesture opened. A gesture
  whose opening frame was refused inside the start-up window owns nothing, so by the time its terminal
  frame arrives the helper reads `ready` and a readiness-first derivation answered `malformed`
  ("never retry") for exactly the sequence `channel-starting` exists to serve. MCP's `swipe` defaults
  to 300ms, comfortably past the measured 247ms, so it lands there.
  A consequence worth knowing: `channel-starting` is **unreachable for a continuation frame**. Owning
  a gesture requires an opening frame to have landed, which requires readiness — so only standalone
  inputs (a key, a button) are ever refused merely because the channel is coming up.

`TouchHelper`'s write methods still return `boolean` **on purpose**. Every member of a string union is
truthy, so converting them would silently invert `this.gestureProc = sent ? this.proc : null` — the
guard that two reviews already fought over — and neither `tsc` nor eslint would say a word
(`no-unnecessary-condition` is not enabled, and tests are excluded from both). The reason is derived
at the ack site instead, which is safe because writes here are synchronous.

- **A terminal input for a session this agent has no state for answers too** (#489). It used to
  `break` silently in all four terminal handlers, so nothing answered at all and the caller waited out
  its own timeout — which MCP's fallback then reports as success. It maps to `channel-unavailable`,
  the same reason Android's `wireReason()` gives it. Reachability is disputed and deliberately not
  claimed: `relay/src/__tests__/sessionRebind.test.ts` records that a restarted agent is re-seeded
  from `agent:registered`, which argues it never fires — but that message carries one entry per
  *device* (`RelayServer.ts`, `byDeviceId`) and the relay's own comment there notes one device can now
  sit behind two sessions, which would leave the second unseeded. The answer costs four lines and the
  silence costs a swallowed input reported as success, so the asymmetry in cost decided it.
  **Opening** frames stay silent: they carry no ack obligation, and answering them would invent a
  reply the caller is not waiting for.

An unmapped **button** still answers success: the device genuinely has no such button (#484). An
unmapped **key code** answers `unsupported` and keeps its existing prose, which names the code. That
asymmetry is a decision, and it is why iOS never sends `unsupported` for a button while Android does.

## HOW NOT

- Do not expose iOS-specific methods as public API if they are not in the `DeviceAgent` interface.
- Do not reintroduce SCStream/ScreenCaptureKit — geometry coordinate mismatches cause double-frame issues.
- Do not stream JPEG frames over WebRTC DataChannel — the channel silently closes on large messages (~236KB+; details in "WebSocket Binary streaming — transport choice" below).

---

## Compound

### touch-helper interface

```bash
touch-helper <udid|booted>
```

Injects HID events directly into the iOS Simulator via `SimDeviceLegacyHIDClient` + IndigoHID.

stdin protocol (variable-length frames). Note the payload is **not** one layout: two of the four
rows carry integers and two carry floats, so reading the whole table as "two floats" is how a frame
ends up carrying garbage:

| types | size | payload |
|-------|------|---------|
| 1–3 | 9 bytes | `[type:u8][x:f32BE][y:f32BE]` |
| 4, 5, 10, 11 | 9 bytes | `[type:u8][a:u32BE][b:u32BE]` |
| 9 | 9 bytes | `[type:u8][modifiers:u8][pad:u8 ×3][usage:u32BE]` |
| 6–8 | 17 bytes | `[type:u8][x1:f32BE][y1:f32BE][x2:f32BE][y2:f32BE]` |

The **gesture role** column decides how a frame is treated when the helper process has been
replaced — see "Helper death and recovery" below. A frame that *continues* a gesture is delivered
only to the process that received the frame that opened it, and never revives a dead helper.

| type | action | gesture role |
|------|--------|--------------|
| 1 | touch start (x, y normalized 0–1) | opens |
| 2 | touch move (x, y) | continues — a move with no preceding down is not the gesture the tester made, and on the digitizer path the injected message is identical to a touch start's (`mask`/`contact` derive only from `isUp`), so a lone move lands as a fresh tap |
| 3 | touch end | continues — **injects `lastX/lastY`, ignoring the coordinates in the frame** |
| 4 | HID button (a=usagePage, b=usage) | self-contained — down→50ms→up completes inside the helper |
| 5 | legacy button (a=code) | self-contained — same |
| 6 | pinch start (x1,y1 = finger0, x2,y2 = finger1) | opens |
| 7 | pinch move | continues — as with type 2, a move with no preceding down is not the gesture the tester made, and that is the whole reason. Unlike type 2 the injected message *does* differ from a down (`injectTwoFinger` passes `direction` separately as well as deriving `eventType`), so the "reads as a fresh tap" argument does not apply here |
| 8 | pinch end | continues — **injects `pinchLast*`; `TouchHelper.pinchEnd()` sends all-zero coordinates precisely because the helper does not read them** |
| 9 | key press | self-contained — modifier down/up completes inside the frame |
| 10 | button down (a=usagePage, b=usage) | self-contained |
| 11 | button up (a=usagePage, b=usage) | self-contained — the helper keeps no record of which buttons are down, so a paired down is not a precondition |

When changing the Swift source, **always update both locations simultaneously**:
1. `src/touch-helper.swift` — stdin protocol changes
2. `src/TouchHelper.ts` — byte layout in the frame builders (`coordFrame` / `buttonFrame` / `twoFingerFrame`) and in `sendKey`, which builds its own

---

### Helper death and recovery

`touch-helper` can die on its own, and when it did the session accepted no further input for the
rest of its life while the stream kept flowing — the viewer tapped a screen that updated normally
and nothing happened (#482). `TouchHelper` now replaces the process **when it dies** rather than on
the next input — immediately, when the spawn budget below allows it — so the first tap after a death
does not pay the helper's start-up cost (`xcode-select -p`, two `dlopen`s, a `SimServiceContext`
device lookup).

Five things about it are easy to undo by accident:

- **Running is not usable, and the helper says which it is.** It announces itself on stderr once it
  holds its HID client and is about to read stdin (`touch-helper.swift:281`). Measured on a real
  simulator: **186–247ms** after spawn (n=5), and a gesture written before that announcement lands
  **nothing** — the frames sit in the pipe and are drained in one go when it finally starts reading,
  collapsing a swipe into microseconds. So `isReady()` requires the announcement and `isRunning()`
  does not, and they answer different questions: writes are gated on the first, replacement
  decisions on the second. Gating replacement on readiness would spawn a second helper while the
  first was still starting.
  This window is not only reached after a death. `sendChromeData` starts the helper and
  `device:ready` follows a local socket connect later — tens of ms — so **an MCP caller that taps
  as soon as `boot_device` returns lands inside it**, which is how it was found.
  A helper that never announces itself is replaced after `READY_DEADLINE_MS`. Without that,
  running-but-never-ready has no exit at all: nothing asks for a replacement because it is running,
  and every input is refused because it is not ready, so a wedge in the CoreSimulator device lookup
  would strand the session until the device was rebooted. The replacement goes through the same
  death path, so the rolling window bounds it.
- **A pid is what says the exec succeeded.** When the binary is missing, non-executable, or the
  wrong architecture (#464), libuv still returns an open stdin pipe and reports the failure a tick
  later. Measured: `stdin.writable` is `true` on a process that does not exist, and
  `stdin.write()` returning `false` is indistinguishable from ordinary backpressure. `spawnHelper`
  checks `proc.pid` and is the only gate — a process without one never becomes the active helper,
  and recovery from an exec failure is therefore lazy — the next self-contained frame retries.
  Not because node stays silent (it does emit `'error'`, which is why that branch attaches its own
  logger) but because the branch returns before wiring `handleDeath`, so nothing eagerly replaces
  a process that never lived.
- **A gesture belongs to the process that *received* its opening frame.** Because replacement is
  eager, a mid-gesture death normally leaves a healthy process standing by — so checking liveness
  is not enough. `TouchHelper` records the process that took the opening frame and refuses the rest
  of the gesture if it is no longer the current one. Writing a touch end to a fresh process would
  release the touch at (0,0), because that process's latches are zero, **and report it as
  delivered**.
  The ownership is recorded **only when the opening frame was actually delivered**, and that
  condition is load-bearing rather than defensive. Recording it unconditionally looks equivalent —
  "if the open failed there is nothing live to record" — and stops being equivalent the moment
  readiness exists: during the start-up window the open is refused while the process is alive and
  about to become ready, so identity would then pass and the continuation would reach a process
  that never saw the down. This was removed once as untestable and put back after a review found
  the case; see `.work/reviews/fix__touch-helper-death-recovery.md`.
- **Replacing is bounded by a rolling window** — at most 3 spawns in any 30s. Deliberately not a
  count of consecutive fast failures: the helper's start-up is expensive, so "died too fast" cannot
  be separated from "died slowly" without guessing how long start-up takes, and a helper that
  reliably dies just past that guess would reset such a counter every time and churn a process
  every few seconds for the life of the agent, with no input and no user involved. The window
  bounds it whatever the lifetime, and it self-clears, so a session that briefly could not start a
  helper is not left without input until the device is rebooted.
- **A helper must never outlive the reference to it.** `sendChromeData` stops the outgoing helper,
  and `cleanupDeviceState` bumps `bootSeq` so a boot still awaiting simctl cannot install one onto
  a state that reconnect has already dropped. Both used to leak a single child process; a
  self-reviving one would respawn for the life of the agent with nothing left to stop it.

Every write reports whether it reached a helper that is ready to inject — not whether the device
acted on it, which HID is fire-and-forget about — and `IOSAgent.ackInput` answers on that rather
than on `state.touchHelper !== null`. The wrapper object outlives its process, which is what made
the original failure silent.

Verified on a real simulator (iPhone 17 Pro, iOS 26.5), with an idle screenshot pair byte-identical
as the control: killing the helper while idle and swiping again opens Spotlight, so input recovers
without a reconnect; a gesture attempted inside the start-up window reports failure on every frame
and indeed changes nothing; and killing it mid-gesture leaves `isReady()` true — the replacement is
genuinely up — while the terminal frame is still refused, after which a fresh gesture works, so no
touch is left held.

Compile (output to `bin/`):
```bash
cd packages/ios-agent && swiftc src/touch-helper.swift -o bin/touch-helper
```

---

### screencapture-helper interface

```bash
screencapture-helper <fps> <udid|booted> [jpeg|h264]
```

Reads the `com.apple.framebuffer.display` port directly via SimulatorKit IOSurface callbacks. The 3rd arg picks the codec (default `jpeg`); `h264` uses VideoToolbox (`VTCompressionSession`, baseline, B-frames off, periodic IDR, BT.709).

Output framing (length-prefixed):
- **jpeg**: `[4-byte BE len][JPEG bytes] ...`
- **h264**: `[4-byte BE len][flags:u8][Annex B NAL] ...` — `len` counts the flags byte; flags bit0 = keyframe (IDR). Keyframes carry SPS+PPS prepended.

**stdin commands** (h264 only): a single `0x01` byte forces an IDR on the next frame. The relay sends this (via `stream:request-idr` → `ScreenCaptureStreamer.requestKeyframe()`) for drop-to-keyframe recovery, so the stream resyncs fast instead of waiting for the periodic IDR. JPEG ignores stdin.

**Env**:
- `TAPFLOW_JPEG_QUALITY` (0–1, default `0.8`) — JPEG quality; the LAN bandwidth ↔ design-QA fidelity trade-off. Lower = fewer relay→browser drops on LAN, but more artifacts.
- `TAPFLOW_IOS_CODEC` (default `h264`) — H.264 is the default on the IOSurface path; set `TAPFLOW_IOS_CODEC=jpeg` to opt out (force JPEG). H.264 also requires the browser to report it can decode it (`device:boot` `acceptH264`, from `canDecodeH264()`); old/unsupported browsers (~5%, no WebGL2) fall back to JPEG automatically (this fallback is iOS-only — see [`contributing/legacy-browser-fallback-ios-only.md`](../../contributing/legacy-browser-fallback-ios-only.md)). The MjpegStreamer fallback is always JPEG. Set on the agent process. The codec is signalled per frame in the TFFE envelope (byte5 bit0).
- `TAPFLOW_IOS_H264_BITRATE` (bits/s, default `8_000_000`) — H.264 `AverageBitRate` (soft target). Reduces scroll bandwidth to fit a WiFi LAN and avoid sustained relay backpressure; matches the Android 8 Mbps cap (scrcpy and the emulator gRPC encoder). Lower = fewer LAN drops, more motion blockiness. **Do not add `DataRateLimits` (hard cap)** — it corrupts frames (tearing) under high motion.

When the Swift binary interface changes, **always update both locations simultaneously**:
1. `src/screencapture-helper.swift` — argument parsing changes
2. `src/ScreenCaptureStreamer.ts` — `args` array + frame parsing

Requires a TypeScript dist rebuild after compilation:
```bash
cd packages/ios-agent
swiftc src/screencapture-helper.swift -o bin/screencapture-helper \
  -framework CoreVideo -framework ImageIO -framework VideoToolbox -framework CoreMedia
pnpm build
```

---

### XCUITest tree runner (UI tree backend)

The iOS UI tree comes from a resident **XCUITest runner** that runs *inside* the simulator and serves the accessibility tree over HTTP. It is window-agnostic — no Simulator.app window is required — which matches tapflow's headless simulator operation (`simctl boot` does not auto-open a window in current Xcode, and streaming reads the IOSurface directly). This replaced the macOS AXUIElement helper, which needed a Simulator.app window and so failed on the headless path (the AX bridge only exists while the window is on screen). Still no WebDriverAgent — this is a self-hosted XCTest target.

- Source: `xctest-runner/` — xcodegen `project.yml` → **committed `.xcodeproj`** (no xcodegen at runtime).
  - `TreeHost` — minimal host app the UI-test target attaches to.
  - `TreeRunner` — the UI-test target: `TreeServer.swift` opens an `NWListener` HTTP server; `TreeServerTest.swift` starts it and blocks so the process stays resident.
- Protocol: `GET /health` → `ok` (readiness); `GET /tree?bundleId=<id>` → the app's `XCUIApplication.debugDescription` (text). Port via `TAPFLOW_TREE_PORT` env (default `22087`). The simulator shares `localhost` with the host (WDA pattern), so the host reaches the in-simulator server directly.
- `XCUITreeReader.ts` builds the runner once (`build-for-testing`, cached under `xctest-runner/build/`, gitignored), launches it (`test-without-building`, resident), polls `/health`, then fetches `/tree`. `xcuiTree.ts` parses the debugDescription text into the unified schema — kept a **pure function** so it stays unit-testable against the `xcuiTree.test.ts` fixture (Open Q9: a future Xcode format change fails there).
- Queries by bundleId: the reader needs the foreground app's bundleId, tracked as `DeviceState.currentBundleId` on `app:launch`. `readUITree` throws an actionable `PlatformError` if no app has been launched — never a silent empty tree.
- Frames: debugDescription frames are points; the parser normalizes them 0-1 against the `Window` frame (same coordinate space as the touch path).
- Lifecycle: **lazy** — the runner starts on the first UI-tree query (so the manual QA / streaming path never pays the build/launch cost) and is killed on device shutdown / disconnect.
- `enabled`: debugDescription does not expose it, so elements default to `enabled: true`. If fidelity needs it, switch to the private snapshot API (plan Open Q9).

When changing the tree output shape, **update both locations simultaneously**:
1. `xctest-runner/TreeRunner/TreeServer.swift` — server / debugDescription source
2. `src/xcuiTree.ts` — the parser + refresh the `xcuiTree.test.ts` fixture

After editing runner sources, regenerate the committed project (the runner binary itself is built on first use by `XCUITreeReader`):
```bash
cd packages/ios-agent/xctest-runner && xcodegen generate
```

---

### keyboard-helper interface

```bash
keyboard-helper <show|hide> <udid|booted>
```

Loads `CoreSimulator.framework` directly and calls `SimDevice.setHardwareKeyboardEnabled(_:keyboardType:error:)`.
No macOS Accessibility permission required.

- `show`: `setHardwareKeyboardEnabled(false)` — disconnects the hardware keyboard → software keyboard appears on text field focus
- `hide`: `setHardwareKeyboardEnabled(true)` — connects the hardware keyboard → software keyboard hides immediately

Compile (output to `bin/`):
```bash
swiftc packages/ios-agent/src/keyboard-helper.swift \
  -o packages/ios-agent/bin/keyboard-helper \
  -sdk "$(xcrun --show-sdk-path --sdk macosx)"
```

---

### rotation-helper interface

```bash
rotation-helper <portrait|landscapeLeft|landscapeRight|portraitUpsideDown> <udid|booted>
```

Acquires the `PurpleWorkspacePort` mach port via `SimDevice.lookup:error:` and sends a `GSEventTypeDeviceOrientationChanged` event directly.
**No Simulator.app required. No Accessibility permission required.**

UIDeviceOrientation rawValues: `portrait=1`, `portraitUpsideDown=2`, `landscapeRight=3`, `landscapeLeft=4`

Unlike the legacy `osascript` approach (bringing Simulator.app to the foreground and pressing Cmd+Arrow), this sets the absolute orientation directly, so it works regardless of the current state.

Compile (output to `bin/`):
```bash
swiftc packages/ios-agent/src/rotation-helper.swift \
  -o packages/ios-agent/bin/rotation-helper \
  -sdk "$(xcrun --show-sdk-path --sdk macosx)"
```

---

### IOSurface capture — timer-driven strategy

IOSurface callbacks alone do not deliver frames when the screen is static.
Use `DispatchSourceTimer` alongside callbacks to maintain a consistent FPS regardless of callback activity.

```swift
// callback: only updates latestSurface
let onFrame: @convention(block) () -> Void = {
    captureQueue.async { updateLatestSurface() }
}

// timer: encodes the latest surface every tick
let timer = DispatchSource.makeTimerSource(queue: captureQueue)
timer.schedule(deadline: .now(), repeating: 1.0 / fps)
timer.setEventHandler {
    guard let surf = latestSurface, let jpeg = encodeJPEG(surf) else { return }
    writeFrame(jpeg)
}
```

---

### Tear-free framebuffer snapshot (`copySurfaceStable`)

**When**: reading the framebuffer IOSurface to encode (both the H.264 and JPEG paths go through it).

**How**: don't encode the live surface. `copySurfaceStable` memcpys it into a private, reused
buffer and brackets the copy with `IOSurfaceGetSeed`; if the seed moved, the simulator drew
during the copy (possibly sheared) → retry (budget 4). `encodeH264`/`encodeJPEG` then read that
snapshot.

**Why** (not obvious from the code):
- The simulator draws into a **single IOSurface in place** (the static-skip seed relies on that),
  asynchronously to our 30fps timer. Reading it mid-draw bakes a **horizontal tear** — top = old
  frame, bottom = new — into the encoded frame. It shows on **every tier and decoder** (native:
  VTEncode reads the surface directly; downscale: vImage reads it) and recovers on the next frame,
  so it reads as "intermittent scroll tearing." Measured during heavy scroll: **~40% of frames
  raced** a write; all resolved within the retry budget.
- `IOSurfaceLock(.readOnly)` (and `CVPixelBufferLockBaseAddress`, which calls it) is **cooperative**
  — it does not block the sim's GPU writes, so locking alone does **not** prevent the tear. The
  seed check is what makes the snapshot coherent. **Do not "simplify" the copy back to reading the
  live surface.**
- This is distinct from the relay/agent **keyframe-aware backpressure** fix (orphan P-frames under
  drop): that is a transport-drop artifact; this is a source-pixel tear. Both can look like scroll
  tearing; they need separate fixes.
- Reuse safety: downscale reads the snapshot synchronously (vImage) before the next tick; native
  hands it to VTEncode but full-res encode is far slower than the frame interval, so the in-flight
  encode never overlaps the next copy. `TAPFLOW_STREAM_METRICS=1` logs the retry/exhausted counts
  (and the per-frame `capture-wait` poll gap) — formats and the full instrumentation surface are in
  [`contributing/measurement.md`](../../contributing/measurement.md).

---

### Keyboard HID path

Keyboard injection uses `IndigoHIDMessageForKeyboardArbitrary(usage, op)`.  
`IndigoHIDMessageForHIDArbitrary(target=0x32, page=0x07, ...)` is the digitizer (touch) path — iOS does not recognize it as a hardware keyboard, so the CapsLock HUD and Korean/English toggle do not work.

→ Detailed analysis (target differences, symptom patterns, SimKeyboardInputController symbols): [`contributing/simkit-internals.md` §5](../../contributing/simkit-internals.md)

---

### DeviceChromeLoader

**Device identification**: `load(typeIdentifier)` takes a `typeIdentifier`, not an instance name.
- ❌ `"iPhone 16 (tapflow)"` — user-assigned name, does not match simdevicetype files
- ✅ `"com.apple.CoreSimulator.SimDeviceType.iPhone-16"` — the canonical identifier returned by xcrun simctl

`SimctlWrapper` parses `deviceTypeIdentifier` into `Device.typeId` and passes it through.

**Button layout**: `PhoneComposite.pdf` contains no physical buttons. Buttons are separate PDF assets; placement data is in `chrome.json`'s `inputs[]`.

Margin calculation (same logic as baguette `computeMargins`):
```text
left-anchor button:  margin.left  = max(imgWidth - rollover.x, 0)
right-anchor button: margin.right = max(imgWidth + rollover.x, 0)
```

Button center (expanded canvas): `left-anchor: margin.left + rollover.x`  
Render order: `behindBtns → composite → onTopBtns`  
Cache key: `tapflow-frame-v2-{chromeName}.png`

**Screen corner radius**: outer radius is read from `paths.simpleOutsideBorder.cornerRadiusX` in `chrome.json`.
```text
innerRadius = max(outerRadius - bezelInset, 0)
bezelInset  = max(leftWidth, topHeight)   // chrome.json images.sizing
```
`ChromeData.screenCornerRadius` is in 2× px units. CSS conversion in `IOSViewer.tsx`: `÷2 × displayScale`.

---

### WebSocket Binary streaming — transport choice

`ws.send(Buffer)` → Relay → `ws.send(data, { binary: true })` → Browser `e.data instanceof ArrayBuffer`. The codec is negotiated per frame via the TFFE envelope (H.264 default, JPEG fallback).

Why WebSocket instead of a WebRTC DataChannel:
1. **DataChannel instability**: `@roamhq/wrtc` silently closes the channel on messages ~236KB+.
2. **No P2P benefit**: tapflow has a fixed Agent → Relay → Browser path.
3. **HW decode doesn't need a Video Track here**: the browser decodes WebSocket frames directly — H.264 via WebCodecs (see dashboard), JPEG via `createImageBitmap`.

---

### Zombie simulator auto-recovery

A simulator's data dir can vanish from disk (an Xcode/macOS update prunes its runtime)
while `simctl list` still reports it `isAvailable: true` — the loss only surfaces when
`boot` runs, failing with "cannot be located on disk" / "data is no longer present".

`handleDeviceBoot` recovers in place via `bootWithZombieRecovery`: when
`isDeviceMissingError(e)` matches that signature it `erase`s the device (regenerating the
data dir) and retries `boot` once. Bounded — a second failure surfaces as
`device:boot-error`, never a loop.

**Why the guard matters**: `erase` wipes a device, so it runs *only* on the missing-data
signature — an unrelated boot failure (timeout, etc.) never erases a healthy device,
locked down by a negative test. Keep the match text-only and conservative; widen the
signature only with evidence.

---

### IOSAgent tests — streaming prerequisites

`startBinaryStream()` is called only inside `handleDeviceBoot()`. Any test involving streaming or TouchHelper must go through the `device:boot` flow first.

```typescript
browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
await waitForType(browser, 'session:joined')
// `requestId` is **required** on device:boot and the relay drops a boot without one at the door —
// silently, since an uncorrelatable request gets no reply. Omit it and this wait simply times out.
browser.send(JSON.stringify({ type: 'device:boot', sessionId: agent.sessionId, requestId: 'rq-1', payload: { deviceId: 'dev-1' } }))
await waitForType(browser, 'device:ready')
// device:ready alone does not mean the mock exists yet — see below. Sync on the mock itself.
await vi.waitFor(() => expect(MockTouchHelper.mock.results.length).toBeGreaterThan(0))
const touchHelper = MockTouchHelper.mock.results[0].value
```

`mockSimctl(true)` (booted=true) → skips `device:booting` and delivers `device:ready` immediately.

**`device:ready` is not a sync point.** It is sent as soon as the stream is handed off, before the helpers a test is usually about to read are observable — so `waitForType(browser, 'device:ready')` returning does not mean `MockCapture` or `MockTouchHelper` has been constructed. Always `vi.waitFor` on the mock you are about to read, never on the message alone.

There used to be a second reason: the relay replayed `device:ready` on `session:start` for any session whose device was up at registration, so the wait could latch an ack that belonged to no boot at all — that is what made the codec-negotiation test flake at ~2/10 suite runs. The replay now keys off whether the session announced a stream (relay `Session.readySent`), so a freshly registered `mockSimctl(true)` session no longer produces one. The `vi.waitFor` rule stands on the first reason alone.
