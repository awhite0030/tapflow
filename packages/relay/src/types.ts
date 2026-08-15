export type MessageType =
  | 'agent:register'
  | 'agent:registered'
  | 'agent:resources'
  | 'agents:list'
  | 'agents:listed'
  | 'session:start'
  | 'session:joined'
  | 'session:chrome'
  | 'session:deviceInfo'
  | 'session:end'
  | 'session:leave'
  | 'session:terminated'
  | 'session:agent-away'
  | 'session:rebound'
  | 'stream:register'
  | 'stream:registered'
  // Was missing. The relay sends it from two places and its own union did not declare it — the
  // very drift `protocol/AGENTS.md` cites as this package's reason to exist, still alive in the
  // copy underneath it. The assertion below is what makes a third omission a compile error.
  | 'stream:request-idr'
  | 'device:boot'
  | 'device:booting'
  | 'device:ready'
  | 'device:boot-error'
  | 'device:shutdown'
  | 'device:shutdown-done'
  | 'app:install'
  | 'app:install-done'
  | 'app:install-error'
  | 'app:launch'
  | 'app:launch-done'
  | 'app:launch-error'
  | 'open-url'
  | 'open-url:done'
  | 'open-url:error'
  | 'app:clear-state'
  | 'app:clear-state-done'
  | 'app:clear-state-error'
  | 'input:touch:start'
  | 'input:touch:move'
  | 'input:touch:end'
  | 'input:pinch:start'
  | 'input:pinch:move'
  | 'input:pinch:end'
  | 'input:key'
  | 'input:type'
  | 'input:type-done'
  | 'input:type-error'
  | 'input:done'
  | 'input:error'
  | 'input:button'
  | 'input:rotate'
  | 'input:keyboard:toggle'
  | 'keyboard:toggled'
  | 'screenshot:request'
  | 'screenshot:done'
  | 'screenshot:error'
  | 'ui:tree:request'
  | 'ui:tree:response'
  | 'ui:tree:error'
  | 'clipboard:read'
  | 'clipboard:write'
  | 'clipboard:data'
  | 'clipboard:write-done'
  | 'clipboard:error'
  | 'error'

import type { AgentResources, UIElement } from '@tapflowio/agent-core'
export type { AgentResources, UIElement }

// The wire contract lives in @tapflowio/protocol so the relay, the dashboard and mcp-server cannot
// drift apart. `DeviceInfo` is kept as an alias while call sites move over.
import type { AnyWireMessage, DeviceSummary, SessionInfo, SessionTerminatedReason } from '@tapflowio/protocol'
export type { DeviceDetails, DeviceReport, DeviceSummary, SessionInfo, SessionTerminatedReason } from '@tapflowio/protocol'

export type DeviceInfo = DeviceSummary

// ── membership, enforced in both directions (#532) ───────────────────────────────────────────────
//
// The wire-contract program made every message's *fields* checked and left its *set membership*
// unchecked in one direction. Narrowing was held by the compiler and held well — `sendTo` refuses a
// message outside its union. **Widening was free**: measured on `main`, adding `DeviceBooting` to
// `BrowserToRelay` left `pnpm typecheck` at zero errors and all 294 static tests green.
//
// These are type-level and cost nothing at runtime. `Assert` fails to instantiate when its argument
// is not `true`, so a violated invariant is a compile error at the declaration rather than a test
// somebody has to run.
export type Assert<T extends true> = T
/** `[T] extends [never]` rather than `T extends never`: a bare conditional distributes over a union
 *  and answers `never` for an empty one *and* for a non-empty one, which would pass either way. */
export type IsEmpty<T> = [T] extends [never] ? true : false

/**
 * The relay's own literal list is complete against the protocol.
 *
 * Both directions. Missing an entry is what happened to `stream:request-idr`; an extra one means a
 * literal the protocol no longer declares, which reads as deliberate and gates nothing.
 */
type _MessageTypeCoversProtocol = Assert<IsEmpty<Exclude<AnyWireMessage['type'], MessageType>>>
type _MessageTypeInventsNothing = Assert<IsEmpty<Exclude<MessageType, AnyWireMessage['type']>>>


// `agents:listed` groups devices by agent machine. Protocol owns the shape; this file used to
// declare an identical copy. Its `devices` element is protocol's `DeviceSummary`, which the alias
// below already points at.

export interface RelayMessage {
  type: MessageType
  sessionId?: string
  payload?: unknown
  message?: string
  agentName?: string
  // agent:register: stable per-machine id (macOS IOPlatformUUID). Unique per Mac, unlike agentName
  // (os.hostname() can collide). Absent from older agents → relay falls back to agentName for dedup.
  agentId?: string
  // agent:register: raw device list (without sessionId/busy — added by relay)
  devices?: Array<{ id: string; name: string; platform: string; status: string; osVersion?: string }>
  platform?: string  // agent:register: agent platform ('ios' | 'android')
  // agent:register: what this agent implements (e.g. ['clipboard']). Absent from agents that
  // predate a capability, which is exactly how a viewer tells them apart — see agent-core.
  // Echoed back on session:joined so the dashboard knows before it sends anything.
  capabilities?: string[]
  // agents:listed: grouped by agent
  sessions?: SessionInfo[]
  // agent:registered: per-device sessionId assignments
  registeredSessions?: Array<{ deviceId: string; sessionId: string }>
  buildId?: number
  resources?: AgentResources
  requestId?: string
  data?: string
  format?: 'png' | 'jpeg'
  // ui:tree:response: unified element schema (normalized 0-1 frames), mapped agent-side
  elements?: UIElement[]
  // session:terminated: why the relay dropped the session
  reason?: SessionTerminatedReason
}
