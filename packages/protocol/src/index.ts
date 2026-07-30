// tapflow wire protocol — the WebSocket message contract shared by browser, relay and agents.
//
// Scope: JSON messages only. The binary frame envelope (TFFE) is not here — see
// contributing/frame-envelope.md. Runtime validators, if they ever exist, belong in this package
// next to the types they validate.
//
// Types only, deliberately. Consumers use `import type`, so nothing from this package reaches a
// runtime bundle. Do not add `enum` or const objects: they compile to runtime values, which would
// put JavaScript into the dashboard bundle the moment someone referenced one as a value.

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

// ── browser → relay ──────────────────────────────────────────────────────────

/** Key input. The payload carries `code` (a `KeyboardEvent.code` name) and a modifier list — NOT
 *  `key`. The dashboard union declared `{ key: string }` for a long time while every sender and
 *  the agents used `{ code, modifiers }`; that mismatch survived because `send()` took `object`. */
export interface InputKey {
  type: 'input:key'
  sessionId: string
  payload: { code: string; modifiers?: string[] }
}

export type BrowserToRelay =
  | InputKey

// ── relay → browser ──────────────────────────────────────────────────────────

export interface SessionJoined {
  type: 'session:joined'
  sessionId: string
  capabilities?: string[]
}

export interface ErrorMessage {
  type: 'error'
  message: string
}

export type RelayToBrowser =
  | SessionJoined
  | ErrorMessage
