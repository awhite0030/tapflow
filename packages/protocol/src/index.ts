// tapflow wire protocol — the WebSocket message contract shared by browser, relay and agents.
//
// Scope: JSON messages only. The binary frame envelope (TFFE) is not here — see
// contributing/frame-envelope.md. Runtime validators, if they ever exist, belong in this package
// next to the types they validate.
//
// Types only, deliberately. Consumers use `import type`, so nothing from this package reaches a
// runtime bundle. Do not add `enum` or const objects: they compile to runtime values, which would
// put JavaScript into the dashboard bundle the moment someone referenced one as a value.

// ── Domain shapes carried by messages ────────────────────────────────────────

/** Agent resource sample, reported on `agent:resources` and echoed in a session listing. */
export interface AgentResources {
  cpuPercent: number
  memUsedMB: number
  memTotalMB: number
  slotsAvailable: number
  slotsTotal: number
  /** Date.now() */
  reportedAt: number
}

/** What an agent reports about a device in `agent:register`. No `sessionId`/`busy` — the relay
 *  owns those. */
export interface DeviceReport {
  id: string
  name: string
  platform: string
  status: string
  osVersion?: string
}

/** A device as the relay lists it, after adding what only the relay knows. Named `DeviceSummary`
 *  rather than `DeviceInfo` because both packages already used that name for different shapes:
 *  the relay for this, the dashboard for the `session:deviceInfo` payload (`DeviceDetails`). */
export interface DeviceSummary extends DeviceReport {
  sessionId: string
  busy: boolean
}

/** The `session:deviceInfo` payload — what the viewer shows in its info card. */
export interface DeviceDetails {
  deviceName: string
  osVersion: string
}

/** `agents:listed` groups devices by agent machine. */
export interface SessionInfo {
  agentName?: string
  platform?: string
  resources?: AgentResources
  devices: DeviceSummary[]
}

export interface ChromeRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ChromeButton {
  name: string
  accessibilityTitle: string
  anchor: string
  /** true = button is above the device frame (e.g. home button) */
  onTop: boolean
  /** button center in the **expanded composite** space at 2× px (retracted/default) */
  normalOffset: { x: number; y: number }
  /** button center at the rollover (extended/hover) position, same space */
  rolloverOffset: { x: number; y: number }
  /** button width in 2× composite px */
  buttonW: number
  /** button height in 2× composite px */
  buttonH: number
  /** HID usage page for SimulatorKit injection (0 = unknown) */
  usagePage: number
  /** HID usage code (0 = unknown) */
  usage: number
  /** base64 PNG of the button at 2× (for the CSS-animated overlay) */
  buttonPng?: string
  /** base64 PNG of the pressed state (imageDown asset) */
  pressedPng?: string
  /** position + size in the **expanded composite** space at 2× px */
  pressedRect?: ChromeRect
}

export interface AndroidButton {
  name: string
  accessibilityTitle: string
  keyCode: number
}

/** Payload on every `clipboard:error` from a read. `sentinelParked` answers the one question the
 *  viewer needs to decide its fallback: is a marker still sitting on the device clipboard?
 *
 *  If it is, the agent's restore is about to overwrite whatever the device copies next, so
 *  pressing the plain chord as a fallback would hand the user a stale value — the exact bug the
 *  sentinel exists to prevent. If it is not, the chord is safe and is the only way the copy
 *  happens at all. Absent means "assume parked": an agent from before this field cannot tell us,
 *  and the silent-stale-paste failure is worse than a copy that did not happen.
 *
 *  `unsupported` is narrower — this backend has no clipboard channel whatsoever — and drives the
 *  paste fallback and the wording of the toast. */
export interface ClipboardErrorPayload {
  unsupported?: boolean
  sentinelParked?: boolean
}

/**
 * iOS device chrome — the bezel artwork and hit regions the viewer composites around the screen.
 *
 * **Two coordinate spaces exist here and the field names do not distinguish them.** The composite
 * PDF is the device frame; the *expanded* composite is that canvas grown by the button margins, and
 * it is the space the viewer lays out against. `compositeWidth`/`Height`, `screenRect` and every
 * `ChromeButton` offset are in the **expanded** space; `padding` is the device's own padding inside
 * the un-expanded one. Getting this wrong puts buttons at an offset that looks almost right.
 *
 * These descriptions come from the producer (`ios-agent`'s `DeviceChromeLoader`, which computes
 * `expandedW = pdfSize.width + buttonMargins`). They were previously accurate only in that file —
 * this declaration said `compositeWidth` was "full PDF width including devicePadding", a different
 * quantity — so they moved here with the type rather than being lost with it.
 */
export interface ChromeData {
  /** composite with buttons baked in, at 2× — screen hole transparent */
  framePng: string
  /** composite minus devicePadding, at 2× px */
  bezelWidth: number
  bezelHeight: number
  /** **expanded** canvas width — composite + button margins — at 2× px */
  compositeWidth: number
  /** **expanded** canvas height, at 2× px */
  compositeHeight: number
  /** devicePadding at 2× px, inside the un-expanded composite */
  padding: { left: number; right: number; top: number; bottom: number }
  /** screen position in the **expanded** composite space, at 2× px */
  screenRect: ChromeRect
  /** screen corner radius in 2× px (0 if the device has no rounded corners) */
  screenCornerRadius: number
  /** screen width in iOS logical pixels (pt) */
  logicalWidth: number
  /** screen height in iOS logical pixels (pt) */
  logicalHeight: number
  buttons: ChromeButton[]
}

/** Android chrome — no bezel artwork; the emulator frame carries it. */
export interface AndroidChrome {
  buttons: AndroidButton[]
  streamType: 'h264'
  screenWidth?: number
  screenHeight?: number
  cornerRadius?: number
}

/** The `session:chrome` payload. The relay never reads it — it stores and forwards — but the
 *  contract still states the shape, because the viewer parses it. A new platform adds its variant
 *  here; relay and dashboard code stay unchanged, which is what the OCP rule asks for. */
export type ChromePayload = ChromeData | AndroidChrome

// ── relay → agent ────────────────────────────────────────────────────────────

export type RelayToAgent =
  | { type: 'agent:registered'; registeredSessions: Array<{ deviceId: string; sessionId: string }> }
  | { type: 'stream:request-idr'; sessionId: string }
  | { type: 'device:shutdown'; sessionId: string; payload: { deviceId: string } }
  | { type: 'app:install'; sessionId: string; payload: { filePath: string; bundleId: string | null } }
  | { type: 'app:launch'; sessionId: string; payload: { bundleId: string } }
  | { type: 'screenshot:request'; sessionId: string; requestId: string; format: 'png' | 'jpeg' }
  | { type: 'ui:tree:request'; sessionId: string; requestId: string }

/**
 * Why a session stopped existing, server-side. A literal union rather than a string so that adding
 * a case is a compile-time event for every consumer that switches on it.
 *
 * Named `session:terminated`, not `session:ended`: `session:end` is already a message the *browser*
 * sends to ask for shutdown, and the two would sit one letter apart in the same switch. This one
 * travels the other way and is not an acknowledgement of that request.
 */
export type SessionTerminatedReason = 'agent-disconnected'

/**
 * Why a terminal input was not delivered — the machine-readable half of `input:error`.
 *
 * The set is derived from **what a consumer has to do differently**, not from how many internal
 * states an agent has. Those differ per platform (one HID helper on iOS; a scrcpy socket, an
 * emulator gRPC channel and `adb shell input` on Android) and each agent maps its own states onto
 * these. A closed set that is smaller than either agent's internals is the point.
 *
 * | reason | consumer should |
 * |---|---|
 * | `not-booted` | boot the device |
 * | `channel-unavailable` | reconnect or rebind; do not blindly retry |
 * | `channel-starting` | **retry shortly** — the channel exists and is coming up |
 * | `dispatch-failed` | may retry once |
 * | `unsupported` | never retry; this agent does not implement it |
 * | `malformed` | fix the call; never retry |
 * | `no-gesture` | **open a new gesture** — retrying this frame can never land |
 *
 * `channel-starting` is the one that had no name. On iOS the input helper needs a measured
 * 186–247ms after spawn before an injected frame reaches the device, and `device:ready` can arrive
 * inside that window — so a caller that taps as soon as a boot returns was being told the channel
 * was gone when it was merely coming up.
 *
 * **A consumer that meets a reason it does not know must treat it as `channel-unavailable`** — the
 * conservative reading. The field is optional precisely so an older agent can omit it, so absence
 * means "unknown", never "fine".
 *
 * A string literal union rather than an enum, per this package's HOW NOT: it must erase under
 * `import type` so it never lands in the dashboard's bundle.
 */
export type InputErrorReason =
  | 'not-booted'
  | 'channel-unavailable'
  | 'channel-starting'
  | 'dispatch-failed'
  | 'unsupported'
  | 'malformed'
  /**
   * A frame that only means something as part of a gesture arrived with no gesture behind it — the
   * opening frame never landed, or the process serving it was replaced. Distinct from `malformed`
   * because the advice differs: the message was well-formed and the channel may be perfectly
   * healthy, but *this* frame can never be delivered, so the caller re-opens the gesture rather than
   * giving up. Distinct from `channel-starting` for the same reason — waiting does not help.
   */
  | 'no-gesture'

// ── relay → browser ──────────────────────────────────────────────────────────
//
// `stream:registered` goes to a stream socket rather than a viewer. It is grouped here because the
// relay treats "everything that is not an agent" alike on the way out; splitting the outbound union
// by socket role is a later refinement, and the roles are already distinguished at runtime
// (`wsRoles`, `AGENT_MSG_TYPES`).

/** Browser-inbound messages with **two** producers: an agent sends it and the relay also originates
 *  its own copy — replaying session state to a re-joining viewer, or failing fast when it cannot
 *  reach the agent at all.
 *
 *  Declared once here and referenced by both directions rather than written into each, because two
 *  copies of one message drift. That is not hypothetical: the dashboard kept a hand-copy of this
 *  whole surface and four members had diverged from it, with nothing reporting the difference. */
export type RelayOrAgentToBrowser =
  // `sessionId` is optional on these three and required on the errors below, because here the two
  // producers genuinely disagree. Both agents stamp it on every one of these
  // (`IOSAgent.ts:401,411,606`, `AndroidAgent.ts:461,867,878`) and the forward gate resolves the
  // session before forwarding, so a *forwarded* copy always carries it — but the relay's own replay
  // to a re-joining viewer does not (`RelayServer.ts:1079,1082,1089`), and it is the same declaration.
  // Optional is what one declaration can honestly say about two producers that differ. Bringing the
  // replay up to the agents' shape, and tightening this to required, belongs with L4 — the layer that
  // types the relay's own sends.
  | { type: 'session:chrome'; sessionId?: string; payload: ChromePayload }
  | { type: 'session:deviceInfo'; sessionId?: string; payload: DeviceDetails }
  | { type: 'device:ready'; sessionId?: string; payload: { deviceId: string } }
  // `sessionId` is what makes a failure findable. A dashboard viewer holds one session per socket,
  // so an uncorrelated error still lands somewhere sensible — but an MCP caller waits for the reply
  // that carries its own sessionId, and without one it waits out the deadline instead (#445).
  //
  // Required here is a **specification the relay does not yet meet**, not a description of the wire.
  // Nothing validates inbound messages, so a client that sends `{"type":"input:touch:end"}` with no
  // sessionId reaches `sessions.get(undefined)`, misses, and the relay answers `'Session not found'`
  // through `msg.sessionId!` — `JSON.stringify` then drops the key. Seven sites do this
  // (`RelayServer.ts:719,743,752,786,803,1109,1138`). No in-repo client omits a sessionId, so the
  // gap is reachable only from a third-party one.
  //
  // Optional would describe that wire accurately and still be the wrong contract: an MCP caller that
  // receives an uncorrelatable `input:error` has nothing it can do with it — it waits out the
  // deadline either way. The producer is what has to change, and the only correct thing for it to
  // send with no sessionId is `{ type: 'error' }` below, which exists for exactly that. So this
  // required field is what makes #444 "send `error` instead" rather than "delete the `!`".
  | { type: 'app:install-error'; sessionId: string; message: string }
  | { type: 'app:launch-error'; sessionId: string; message: string }
  | { type: 'device:boot-error'; sessionId: string; message: string }
  | { type: 'open-url:error'; sessionId: string; message: string }
  | { type: 'app:clear-state-error'; sessionId: string; message: string }
  | { type: 'input:error'; sessionId: string; message: string; reason?: InputErrorReason }
  // `requestId` is required on the same terms, and with a narrower guarantee behind it: the forward
  // gate resolves `sessionId` only, and both agents read the id as optional
  // (`IOSAgent.ts:1078`, `AndroidAgent.ts:1262`) and pass it straight through. What holds today is
  // that `ClipboardRequest.requestId` is required and the only requester — the dashboard's bridge —
  // is typed with it; `mcp-server` and `flow-runner` send no clipboard message at all. When one of
  // them gains a clipboard tool, this required field is what turns a missing id into a compile error
  // instead of a reply the bridge drops on `if (!msg.requestId) return`. Holding the untyped senders
  // to it is L4.
  | { type: 'clipboard:error'; sessionId: string; requestId: string; message: string; payload?: ClipboardErrorPayload }

/** Messages the relay originates and no agent sends. */
export type RelayToBrowser =
  | RelayOrAgentToBrowser
  | { type: 'agents:listed'; sessions: SessionInfo[] }
  | { type: 'session:joined'; sessionId: string; capabilities: string[] }
  | { type: 'session:terminated'; sessionId: string; reason: SessionTerminatedReason }
  // The socket carrying this session's agent went away and the relay is holding the session open
  // in case the agent comes back. Nothing is streaming. Sent so the viewer can say what is going on
  // instead of showing a frame that stopped updating — the symptom #426 opened with.
  //
  // While the same browser socket stays attached, at most one of `session:rebound` (it came back)
  // or `session:terminated` (it did not) follows. Both are addressed to `browserSocket`, so a
  // viewer that disconnects in between gets neither, and re-joining re-sends this one.
  | { type: 'session:agent-away'; sessionId: string }
  // The agent behind this session restarted and the relay re-pointed the session at its new socket
  // — same sessionId, nothing streaming. The viewer has to ask for the device again, because the
  // codec negotiation and tier live in its own `device:boot` payload and nowhere the relay can see.
  // `capabilities` rides along because `session:joined` is sent once and a restarted agent may
  // advertise a different set (an upgrade is the usual reason to restart one).
  | { type: 'session:rebound'; sessionId: string; capabilities: string[] }
  // The escape hatch for a failure the relay cannot correlate to a session. Every typed member above
  // carries a sessionId; when there is genuinely none to carry, this is the message to send — not a
  // typed error with the key dropped by `JSON.stringify`.
  | { type: 'error'; message: string }

/** Messages an agent produces. The relay forwards them byte-for-byte (`JSON.stringify(msg)`) rather
 *  than re-creating them, so it never constructs one — which is exactly why they were missing from
 *  this file until L3: nothing on the relay's own send path referenced them.
 *
 *  The twelve declared below carry `sessionId` as required, on two independent grounds: both agents
 *  include it in every send literal, and the relay's forward gate resolves `sessions.get(msg.sessionId!)`
 *  before forwarding, so a message with no sessionId never reaches a browser by this path.
 *
 *  The ten inherited from `RelayOrAgentToBrowser` are **not** all required — three are `sessionId?`,
 *  which is looser than what an agent actually sends. Tightening them here needs the three declared
 *  twice, or the shared union mapped through `Omit<T,'sessionId'> & { sessionId: string }`. Both were
 *  weighed and rejected for this layer:
 *
 *  - Declaring them twice reintroduces the thing this layer exists to remove. Two copies of one
 *    message drift; that is the whole finding — four of them, between this file and the dashboard's.
 *  - The mapped version turns those members into intersections, so `Extract<BrowserInbound, …>` stops
 *    yielding a single member. `useClipboardBridge` depends on that (its three replies are read
 *    without a cast because each `Extract` resolves to one declaration).
 *
 *  And no consumer could read the stricter claim today: `BrowserInbound` merges both directions, and a
 *  union merge collapses to the looser field. Nothing consumes `AgentToBrowser` on its own — the relay
 *  forwards untyped. **L4 is where it pays**: once the relay's forward path is narrowed to this union,
 *  required `sessionId` is checkable, and the relay's replay (`RelayServer.ts:1079,1082,1089`) is
 *  brought up to the agents' shape in the same change. Tracked there rather than left implicit. */
export type AgentToBrowser =
  | RelayOrAgentToBrowser
  | { type: 'device:booting'; sessionId: string }
  | { type: 'device:shutdown-done'; sessionId: string; payload: { deviceId: string } }
  | { type: 'app:install-done'; sessionId: string }
  | { type: 'app:launch-done'; sessionId: string }
  | { type: 'app:clear-state-done'; sessionId: string }
  | { type: 'open-url:done'; sessionId: string }
  | { type: 'input:done'; sessionId: string }
  | { type: 'input:type-done'; sessionId: string }
  | { type: 'input:type-error'; sessionId: string; message: string }
  // iOS only — Android's `input:keyboard:toggle` is a client-side forwarding flag with no device
  // side effect, so it has nothing to report back.
  | { type: 'keyboard:toggled'; sessionId: string; payload: { visible: boolean } }
  | { type: 'clipboard:data'; sessionId: string; requestId: string; payload: { text: string } }
  | { type: 'clipboard:write-done'; sessionId: string; requestId: string }

/** Everything a browser socket can receive, whoever produced it. This is what a viewer's message
 *  handler should be typed with — the two unions above answer "who sends this", which matters to
 *  the relay and not to the consumer. */
export type BrowserInbound = RelayToBrowser | AgentToBrowser

/** The agent's *stream* socket, not a browser. Its own direction because it has its own audience:
 *  the consumer is `agent-core`'s stream registration, and nothing in a browser reads it. */
export type RelayToStream = { type: 'stream:registered' }

/** Everything the relay originates. Messages it merely forwards keep their inbound type — they are
 *  not re-created, so they are not checked against this union. */
export type RelayOutbound = RelayToAgent | RelayToBrowser | RelayToStream

// ── browser → relay ──────────────────────────────────────────────────────────

/** Key input. The payload carries `code` — a `KeyboardEvent.code` name — and `modifiers` as a
 *  **bitmap**, not a list and not `key`.
 *
 *  The dashboard union declared `{ key: string }` while every sender and both agents used
 *  `{ code, modifiers }`; the mismatch survived because `send()` took `object`. The authority is
 *  the consumer: `IOSAgent.ts` reads `{ code: string; modifiers?: number }` and passes the number
 *  straight to `touchHelper.sendKey(usage, modifiers ?? 0)`, where it is the HID modifier bitmap
 *  documented in packages/ios-agent/AGENTS.md (touch-helper type 9). */
export interface InputKey {
  type: 'input:key'
  sessionId: string
  payload: { code: string; modifiers?: number }
}

export interface Point {
  x: number
  y: number
}

/** The two clipboard requests a viewer can make. Kept as its own union because the bridge sends
 *  them through one call that takes the type as an argument. */
export type ClipboardRequest =
  | { type: 'clipboard:read'; sessionId: string; requestId: string; payload?: { press?: 'copy' | 'cut' } }
  | { type: 'clipboard:write'; sessionId: string; requestId: string; payload: { text: string; pasteAfter?: boolean } }

export type BrowserToRelay =
  | { type: 'agents:list' }
  | { type: 'session:start'; sessionId: string }
  // The relay handles `session:end`, but nothing in this repo sends it — the dashboard and
  // mcp-server both use `session:leave`. Kept because the relay's handler is the contract for any
  // client that does send it; remove it here only together with that handler.
  | { type: 'session:end'; sessionId: string }
  | { type: 'session:leave'; sessionId: string }
  // `external` is added by the relay on the way through — the browser never sets it.
  | { type: 'device:boot'; sessionId: string; payload: { deviceId: string; resetMode?: 'app-only' | 'full-erase'; acceptH264?: boolean; secureContext?: boolean } }
  | { type: 'device:shutdown'; sessionId: string; payload: { deviceId: string } }
  | { type: 'app:install'; sessionId: string; buildId: number }
  | { type: 'app:launch'; sessionId: string; buildId: number }
  | { type: 'app:clear-state'; sessionId: string; payload?: { bundleId?: string } }
  | { type: 'open-url'; sessionId: string; payload: { url: string } }
  | { type: 'input:touch:start'; sessionId: string; payload: Point }
  | { type: 'input:touch:move'; sessionId: string; payload: Point }
  // `payload` is accepted but ignored: the agents call `touchEnd()` without reading it. The
  // dashboard omits it, mcp-server sends the last point. Optional here because that is what the
  // wire actually carries — not because the coordinate means anything on this message.
  | { type: 'input:touch:end'; sessionId: string; payload?: Point }
  | { type: 'input:pinch:start'; sessionId: string; payload: { f0: Point; f1: Point } }
  | { type: 'input:pinch:move'; sessionId: string; payload: { f0: Point; f1: Point } }
  | { type: 'input:pinch:end'; sessionId: string }
  | InputKey
  | { type: 'input:type'; sessionId: string; payload: { text: string } }
  | { type: 'input:button'; sessionId: string; payload: { name: string; phase?: 'down' | 'up' } }
  | { type: 'input:rotate'; sessionId: string }
  | { type: 'input:keyboard:toggle'; sessionId: string }
  | ClipboardRequest
