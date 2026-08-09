// Compile-time assertions about the contract. This file exports nothing anyone imports — it exists
// so `tsc` fails if the guards ever loosen.
//
// Each `@ts-expect-error` says "the next line must not compile". If someone widens a union, adds an
// index signature, or turns a payload back into `unknown`, the error disappears — and an unused
// `@ts-expect-error` is itself a compile error. So the guard cannot rot silently, which is exactly
// the failure mode this whole package was built to remove.

import type { AgentToBrowser, BrowserInbound, BrowserToRelay, RelayOutbound } from './index.js'

// ── must NOT compile ─────────────────────────────────────────────────────────

// @ts-expect-error - a type that is not in the union
export const unknownType: RelayOutbound = { type: 'nope', message: 'x' }

// @ts-expect-error - `capabilities` is required on session:joined
export const missingField: RelayOutbound = { type: 'session:joined', sessionId: 's' }

// @ts-expect-error - `error` carries no sessionId
export const extraField: RelayOutbound = { type: 'error', message: 'x', sessionId: 's' }

// Kept on one line each: `@ts-expect-error` applies to the next line only, so a multi-line literal
// whose error lands three lines down leaves the directive unused — which reads as a failure of the
// assertion rather than of the thing it guards.

// @ts-expect-error - modifiers is a bitmap (number), not a list — the drift this package caught
export const wrongModifierType: BrowserToRelay = { type: 'input:key', sessionId: 's', payload: { code: 'KeyA', modifiers: ['Shift'] } }

// @ts-expect-error - `key` was never the field name; senders and agents use `code`
export const legacyKeyField: BrowserToRelay = { type: 'input:key', sessionId: 's', payload: { key: 'a' } }

// ── must compile ─────────────────────────────────────────────────────────────
// The other direction: if one of these breaks, the contract stopped describing something real.

export const validOutbound: RelayOutbound = { type: 'stream:request-idr', sessionId: 's' }
export const validInbound: BrowserToRelay = {
  type: 'input:key', sessionId: 's', payload: { code: 'KeyA', modifiers: 2 },
}
export const validClipboard: BrowserToRelay = {
  type: 'clipboard:write', sessionId: 's', requestId: 'r', payload: { text: 'x', pasteAfter: true },
}

// ── browser-inbound directions ───────────────────────────────────────────────
// `RelayOutbound` is what `sendTo` takes, so it must NOT accept a message only an agent produces —
// the relay forwards those with `JSON.stringify(msg)` and never builds one. Nothing else can state
// this: `browserInboundRouting.test.mjs` compares *membership*, so it would still pass if the relay
// gained a `sendTo` call constructing a forward-only message.

// @ts-expect-error - agents produce input:done; the relay only forwards it
export const relayCannotOriginateForward: RelayOutbound = { type: 'input:done', sessionId: 's' }

// @ts-expect-error - same, and this one carries a payload the relay has no source for
export const relayCannotOriginateKeyboard: RelayOutbound = { type: 'keyboard:toggled', sessionId: 's', payload: { visible: true } }

// A consumer reads the whole surface, whoever sent it — both of the above are valid here.
export const inboundFromAgent: BrowserInbound = { type: 'input:done', sessionId: 's' }
export const inboundFromRelay: BrowserInbound = { type: 'error', message: 'x' }

// @ts-expect-error - sessionId is required on every one of the twelve forward-only messages
export const forwardWithoutSession: AgentToBrowser = { type: 'app:install-done' }

// The shape an agent actually sends for the three shared messages the relay also replays. `sessionId`
// is optional on the shared declaration because the replay omits it, so this direction cannot reject
// the absence — pinning what the agent sends is what the union can state here. L4 tightens it.
export const agentStampsSession: AgentToBrowser = { type: 'device:ready', sessionId: 's', payload: { deviceId: 'd' } }

// The stream socket's one message is its own direction now, so it is still reachable through
// `sendTo` but is no longer part of what a browser can receive.
export const streamRegistered: RelayOutbound = { type: 'stream:registered' }
// @ts-expect-error - stream:registered does not go to a browser
export const streamIsNotBrowserInbound: BrowserInbound = { type: 'stream:registered' }

// ── input:error reason ───────────────────────────────────────────────────────
// The field is optional on purpose: an agent that predates it omits it, and a consumer must read
// absence as "unknown" rather than "fine". Making it required is the breaking step.

export const errorWithoutReason: RelayOutbound = { type: 'input:error', sessionId: 's', message: 'agent offline' }
export const errorWithReason: RelayOutbound = { type: 'input:error', sessionId: 's', message: 'agent offline', reason: 'channel-unavailable' }

// @ts-expect-error - the reason set is closed; a free string would let each agent invent its own
export const errorWithFreeReason: RelayOutbound = { type: 'input:error', sessionId: 's', message: 'x', reason: 'something-else' }
