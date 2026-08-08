// Compile-time assertions about the contract. This file exports nothing anyone imports — it exists
// so `tsc` fails if the guards ever loosen.
//
// Each `@ts-expect-error` says "the next line must not compile". If someone widens a union, adds an
// index signature, or turns a payload back into `unknown`, the error disappears — and an unused
// `@ts-expect-error` is itself a compile error. So the guard cannot rot silently, which is exactly
// the failure mode this whole package was built to remove.

import type { BrowserToRelay, RelayOutbound } from './index.js'

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

// ── input:error reason ───────────────────────────────────────────────────────
// The field is optional on purpose: an agent that predates it omits it, and a consumer must read
// absence as "unknown" rather than "fine". Making it required is the breaking step.

export const errorWithoutReason: RelayOutbound = { type: 'input:error', sessionId: 's', message: 'agent offline' }
export const errorWithReason: RelayOutbound = { type: 'input:error', sessionId: 's', message: 'agent offline', reason: 'channel-unavailable' }

// @ts-expect-error - the reason set is closed; a free string would let each agent invent its own
export const errorWithFreeReason: RelayOutbound = { type: 'input:error', sessionId: 's', message: 'x', reason: 'something-else' }
