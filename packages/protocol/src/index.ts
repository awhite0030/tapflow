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
  /** button center at retracted/default position, in 2× composite px */
  normalOffset: { x: number; y: number }
  /** button center at extended/hover position, in 2× composite px */
  rolloverOffset: { x: number; y: number }
  buttonW: number
  buttonH: number
  /** HID usage page for SimulatorKit injection (0 = unknown) */
  usagePage: number
  /** HID usage code (0 = unknown) */
  usage: number
  /** base64 PNG of the button at 2× (for the CSS-animated overlay) */
  buttonPng?: string
  /** base64 PNG of the pressed state (imageDown asset) */
  pressedPng?: string
  pressedRect?: ChromeRect
}

export interface AndroidButton {
  name: string
  accessibilityTitle: string
  keyCode: number
}

/** iOS device chrome — the bezel artwork and hit regions the viewer composites around the screen. */
export interface ChromeData {
  /** full composite PDF at 2× — device frame visible, screen hole transparent */
  framePng: string
  bezelWidth: number
  bezelHeight: number
  /** full PDF width including devicePadding, at 2× px */
  compositeWidth: number
  compositeHeight: number
  padding: { left: number; right: number; top: number; bottom: number }
  screenRect: ChromeRect
  /** screen corner radius in 2× px (0 if the device has no rounded corners) */
  screenCornerRadius: number
  logicalWidth: number
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

// ── relay → browser ──────────────────────────────────────────────────────────
//
// `stream:registered` goes to a stream socket rather than a viewer. It is grouped here because the
// relay treats "everything that is not an agent" alike on the way out; splitting the outbound union
// by socket role is a later refinement, and the roles are already distinguished at runtime
// (`wsRoles`, `AGENT_MSG_TYPES`).

export type RelayToBrowser =
  | { type: 'agents:listed'; sessions: SessionInfo[] }
  | { type: 'stream:registered' }
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
  | { type: 'session:chrome'; payload: ChromePayload }
  | { type: 'session:deviceInfo'; payload: DeviceDetails }
  | { type: 'device:ready'; payload: { deviceId: string } }
  | { type: 'error'; message: string }
  // `sessionId` is what makes a failure findable. A dashboard viewer holds one session per socket,
  // so an uncorrelated error still lands somewhere sensible — but an MCP caller waits for the reply
  // that carries its own sessionId, and without one it waits out the deadline instead (#445).
  | { type: 'app:install-error'; sessionId: string; message: string }
  | { type: 'app:launch-error'; sessionId: string; message: string }
  // Originated by the relay when it cannot reach the agent. The agent also sends this one, and that
  // copy is forwarded rather than re-created — only the relay's own is checked against this union.
  | { type: 'device:boot-error'; sessionId: string; message: string }
  | { type: 'open-url:error'; sessionId: string; message: string }
  | { type: 'app:clear-state-error'; sessionId: string; message: string }
  | { type: 'input:error'; sessionId: string; message: string }
  | { type: 'clipboard:error'; sessionId: string; requestId: string; message: string }

/** Everything the relay originates. Messages it merely forwards keep their inbound type — they are
 *  not re-created, so they are not checked against this union. */
export type RelayOutbound = RelayToAgent | RelayToBrowser

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
