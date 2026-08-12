---
type: rules
topics: [relay, websocket, server]
status: living
---

# relay — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

WebSocket relay server + dashboard serving: handles NAT traversal, session routing, and JWT auth, while also serving the dashboard static files from `public/` over HTTP.
A single process on a single configurable port (default: 4000) handles both WebSocket connections and HTTP static serving. With `tls` configured it terminates HTTPS + WSS on that same port (LAN secure context, required for WebCodecs hardware decode) — full setup in [`docs/reference/configuration.md`](../../docs/reference/configuration.md).

## Domain Structure — apps / builds separation (migration 004+)

`apps` and `builds` are separate entities.

- **apps**: product-level app identity, keyed by `bundle_id_key` alone (migration 007 dropped the old `UNIQUE(bundle_id_key, platform)`; uniqueness is enforced in `upsertApp`). `platform` is `ios` | `android` | `both` — the same bundle ID uploaded on both platforms is **one** row promoted to `both`, not separate rows.
- **builds**: build artifacts. `app_id FK → apps.id`. Contains `version_name`, `build_number`, `file_path`.
- `bundle_id_key` is used to auto-lookup/create the `apps` row → re-uploading the same app adds only a new `builds` row.

Build file storage path: `uploads/builds/`.

iOS build format: `.app.zip` **or** `.tar.gz`/`.tgz` (EAS `eas build` simulator artifacts). `.ipa` uploads return 400. `.tar.gz` is stored natively (no re-zip) so the `.app`'s exec bits / symlinks survive to install time; `tar` extraction happens on the macOS agent.
- Auto-extracts `CFBundleIdentifier`, `CFBundleShortVersionString`, `CFBundleVersion`, `CFBundleDisplayName`/`CFBundleName` from the top-level `*.app/Info.plist` (zip: `unzip -p`; tar: `tar -xzOf`).
- Validates simulator slices via `lipo -info`. **Skipped in Linux environments (lipo not available) — errors surface at install time instead**.
- `.tar.gz` uploads are validated before storage (`validateTarGz`): rejects path traversal (`..`/absolute), symlink/hardlink entries, corrupt gzip, and gzip bombs (`TAPFLOW_MAX_UNPACKED_BYTES`, default upload cap ×4). `tar` resolves PAX/GNU long names so header parsing can't be bypassed.

## HOW

- The agent connects to the relay via outbound WebSocket first (the key to NAT traversal).
- **Auth boundary**: connections from `localhost` are unauthenticated; every other origin must authenticate — browsers by JWT cookie / PAT, agents by a PAT with the `agent` scope (`Authorization: Bearer`). The role (browser / agent / stream) is decided in `classifyConnection` (`lib/connectionAuth.ts`); a `browser`-role socket that sends an agent-only message (`AGENT_MSG_TYPES`, which includes `stream:register`) is closed with 1008.
- JSON messages and binary frames share the same WebSocket connection, branched by the `isBinary` flag.
- Control message protocol: `input:touch:*`, `input:pinch:*`, `input:button`, `input:key`, `input:type`, `input:rotate`, `input:keyboard:toggle`, `device:boot`, `device:shutdown`, `session:start`, `session:end`, `clipboard:read`, `clipboard:write`.
- **The message shapes live in [`@tapflowio/protocol`](../protocol/AGENTS.md), not here.** Every message the relay *originates* goes through `sendTo(socket, msg: RelayOutbound)`, so adding one means adding it to that union first — the compiler will not let you do it in the other order. Messages the relay only *forwards* keep their inbound type and are re-serialised unchanged.
- **Clipboard bridge** (`clipboard:*`): browser→agent `clipboard:read` (`payload.press`: `'copy' | 'cut'` presses that chord on the device first) and `clipboard:write` (`payload.text`, `payload.pasteAfter`); agent→browser `clipboard:data` / `clipboard:write-done` / `clipboard:error`, correlated by `requestId`. Unlike the other agent→browser replies these are **bound to the session's own `agentSocket`** — their payload lands on the viewer's host OS clipboard, so a second agent must not be able to address someone else's session. An undeliverable request answers `clipboard:error` immediately rather than letting the caller's deadline expire. Agents advertise `capabilities: ['clipboard']` in `agent:register`; the relay echoes them on `session:joined` so a viewer can tell a capable agent from one that predates the feature instead of inferring it from silence.
- **An input the relay cannot dispatch is answered here, with a reason.** The four terminal frames get an
  `input:error` and `input:type` gets an `input:type-error`, so an MCP or browser caller fails now instead of
  waiting out its own timeout — which its fallback would report as success. `input:type` used to receive
  nothing and burn its full deadline; widening the terminal set would not have fixed it, because its waiters
  key on the `input:type-*` pair and ignore an `input:error`, and L5c did what the note here called the
  honest fix — a reply in the shape those waiters read.
  Two situations reach that reply and only one is the agent's fault, so they carry **different prose
  and the same reason**: a held session with a closed socket is `agent offline`, while no session at
  all is `Session not found` — evicted after the reconnect grace, or never valid, and the agent may be
  perfectly healthy. `device:boot` already told that pair apart with those two strings. The reason is
  `channel-unavailable` for both because the set is derived from what a consumer must *do* differently
  and both want a reconnect or a re-join; the machine field was right for both while the prose was
  wrong for one, which is the concrete case for reading `reason` rather than `message` (#492).
  **Everything else gets nothing, and that is the contract**: opening and move frames, `input:rotate` and
  `input:keyboard:toggle` have no waiter, so a reply would be one nobody is listening for.
  The eleven `input:*` cases are **two clauses**, split by whether an ack answers them, and the split is
  load-bearing rather than tidy — the correlator gate belongs on the answered five, and written into the
  shared body it would have dropped every opening and move frame with it.
- **A browser-role command is acted on only from the socket the session is bound to.** The mirror of the
  clipboard rule above, and it was missing until L5c on **every** branch: the relay resolved the session and
  forwarded without asking who was asking, so any authenticated client that knew a session id could drive a
  device another tester was looking at — `clipboard:write` pasting its text into that device,
  `clipboard:read` pressing copy or cut on it with the payload landing on *that* tester's host OS clipboard,
  `session:end` deleting their session. The reply then routed to the session's own browser, never to the
  injector.
  `dispatchTarget` decides it once for all of them — session exists, **this socket holds it**, agent
  connected — and each case wraps the prose it returns in the reply type its own waiter reads. The two
  ownership strings are one reason with different prose (`ownershipRefusal`), the treatment #492 settled:
  telling a caller the session is in use when it is idle steers it off a device it could have had.
  **A refusal is answered where a waiter exists and dropped where none does.** `input:*`, `device:boot`,
  `open-url`, `app:*` and `clipboard:*` are answered — `awaitInputAck` reports silence from a session that
  has never acked as *success*, so a silent refusal would report a command that never left the relay as
  having landed. `session:leave` and `session:end` are dropped, because neither has a reply and inventing
  one would grow the wire for a message no consumer reads.
  **`device:shutdown` is the one exception, and the blocker is not here** — three of the dashboard's four
  senders come from `useAgentSession`, whose socket never joins, so the gate would break going back and the
  unmount teardown. `SessionList` joins before shutting down and documents why, so the dashboard already
  carries two conventions for this message. Tracked in #527; the question there is whether
  `useAgentSession` should join, not whether the relay should check.
  The app-command handlers check ownership **after** the session lookup and **before** the build lookup,
  deliberately not through `dispatchTarget`: that resolver also decides agent liveness, and using it there
  would move `agent offline` ahead of `Build not found`, changing which of two simultaneous problems the
  caller is told about.
- JWTs are issued based on team invite links.
- Serves the `public/` directory as HTTP static files (dashboard build output).
- The relay does not buffer stream data — it forwards immediately on arrival.
- WebSocket upgrade requests and regular HTTP requests are split on the same port.
- A heartbeat (`runHeartbeat`, every `HEARTBEAT_MS`=30s) pings every socket (agent/browser/stream); one missed pong window → `ws.terminate()`, which fires the existing `close` cleanup — detects dead sockets without waiting for TCP timeout.

### API Endpoints (builds / apps)

Routes are registered in `RelayServer.ts`; user-facing reference: [`docs/reference/api.md`](../../docs/reference/api.md).

> **Deletion lifecycle (issue #258)**: review status and deletion are orthogonal. `status_label` (incl. `Done`) is a pure review state and never schedules deletion; purge keys off `delete_after` only, which is set by the explicit schedule-deletion action. `completed_at` is informational.

## Environment Variables

전체 목록 및 설명: [`docs/reference/configuration.md`](../../docs/reference/configuration.md)

비밀 기본 경로: `config.ts`의 `load()`가 dataDir 확정 직후 `<dataDir>/.env`를 로드한 뒤 나머지 `process.env`를 읽는다 → `JWT_SECRET`·`SMTP_*`·DNS/ACME 토큰 등 **모든 비밀이 `.env`를 기본 경로로** 쓴다. 우선순위는 **셸 env > `.env` > config.json**(`process.loadEnvFile`이 기존 값을 안 덮음). 예외는 `TAPFLOW_DATA_DIR` 하나 — `.env` 경로를 결정하는 값이라 `.env`에서 못 읽고 config.json/셸로만 받는다.

로컬 테스트 시 자주 쓰는 값:
- `TAPFLOW_BUILD_TTL_DAYS=0.001` — 빌드 자동 삭제를 즉시 확인할 때
- `TAPFLOW_WS_BACKPRESSURE_BYTES` — 브라우저 소켓 backpressure 임계값 (기본 1 MB)

## HOW NOT

- Do not store or analyze screen data in the relay.
- Do not allow session routing without authentication.
- Do not introduce designs that require more than a t3.small instance (cost principle).
- Do not modify files in `public/` directly — they are dashboard build output.
- Do not parse or deserialize binary frames as JSON — if `isBinary === true`, forward immediately.

---

## Compound

### Binary Frame Forwarding with Backpressure

**When**: relaying WebSocket binary messages from the Agent to the Browser

**How**: the binary branch of the `ws.on('message')` handler in `RelayServer.ts` — a per-session `createKeyframeAwareSender` (`@tapflowio/agent-core` `utils/stream.ts`) handles backpressure. Core call: `dropper.send(browserSocket, frame, threshold, isKeyframe, onDrop, requestIdr)`. `isKeyframe` comes from `readEnvelopeFlags(frame)` (JPEG, or H.264 IDR).

**Why** (not obvious from the code):
- Omitting `{ binary: true }` makes `ws` send the Buffer as UTF-8 text → `e.data` becomes a string in the browser. The relay must be content-agnostic, with zero parsing cost.
- **drop-to-keyframe**: a dropped H.264 P-frame tears the stream until the next IDR, so once it drops under backpressure it keeps dropping until a keyframe can be sent — the decoder never receives a P referencing a dropped frame. JPEG / no-envelope frames pass `isKeyframe=true`, reproducing drop-to-latest exactly.
- On a drop with no sendable keyframe, `requestIdr` sends a throttled `stream:request-idr` for an on-demand IDR (unsupported agents ignore it) → fast resync instead of waiting for the periodic IDR.
- Threshold default 1 MB (`TAPFLOW_WS_BACKPRESSURE_BYTES`). Per-session dropper / drop-warn (one warn/sec) / IDR-requester must be cleared on `session:end`.
