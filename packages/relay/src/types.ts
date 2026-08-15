// The wire contract lives in @tapflowio/protocol. This file holds what the relay adds on top of it —
// today only the re-exports and aliases below.
//
// **`RelayMessage` and `MessageType` were removed here (#550).** They were a flat interface where
// `type` was the only required member and a hand-copied union of 63 literals beside it, and they were
// the relay's *inbound* type: `route` took a `RelayMessage`, so every field it read was optional by
// construction and every one it needed came with a `!`. That is why the two type systems could
// disagree about the same wire field — `format?` here against a required `format` in the protocol —
// with nothing to report it.
//
// What replaced them is not another declaration but a parse: `@tapflowio/protocol/validate` turns an
// inbound frame into a discriminated union at the door, and the relay's own membership assertions
// went with the literal list they were holding, because there is no longer a second copy to hold.

import type { AgentResources, UIElement } from '@tapflowio/agent-core'
export type { AgentResources, UIElement }

// The wire contract lives in @tapflowio/protocol so the relay, the dashboard and mcp-server cannot
// drift apart. `DeviceInfo` is kept as an alias while call sites move over.
import type { DeviceSummary } from '@tapflowio/protocol'
export type { DeviceDetails, DeviceReport, DeviceSummary, SessionInfo, SessionTerminatedReason } from '@tapflowio/protocol'

export type DeviceInfo = DeviceSummary

