---
type: rules
topics: [protocol, websocket, contract, types]
status: living
---

# protocol — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

The wire contract for tapflow's WebSocket traffic: the message types exchanged between the browser, the relay, and the device agents. One definition, three consumers — `relay`, `dashboard`, `mcp-server`.

It exists because the relay and the dashboard each kept their own copy and they drifted. Two drifts were found when this package was created:

- `stream:request-idr` was sent by the relay in two places but was absent from its `MessageType` union.
- `input:key` was declared as `payload: { key: string }` in the dashboard union while **every** sender — both viewers and mcp-server — sent `{ code, modifiers }`. The declaration was wrong, not merely incomplete, and nothing caught it because `send()` took `object`.

## Why this name

`protocol` is deliberately broader than what the package holds today, because the alternatives age worse.

- `protocol-types` would become a lie the moment a runtime validator lands, and one plausibly will — the relay validates nothing on the way in.
- `relay-protocol` reads narrower than the truth: these messages are exchanged by browser ↔ relay ↔ agent, not owned by the relay. It also sits one letter away from `@tapflowio/relay` at every import site.
- `messages` cannot hold anything that is not a message, which is the same corner `protocol-types` paints into.

The cost of a broad name is ambiguity about what belongs — answered by the two Scope sections below rather than by the name. In particular the repo has a *second* wire format (the binary frame envelope), and the name alone does not say which one this is.

## Scope — what belongs here

- **JSON message types** over the relay WebSocket, grouped by direction. That is all the package holds today, and the main entry point is **runtime-free** — see HOW NOT.
- **Runtime validators** would belong here *conceptually* — next to the types they validate, since splitting them recreates the drift this package removes. But they cannot go in the main entry: that would break the erasure the dashboard depends on. Adding them means a second entry point (`@tapflowio/protocol/validate`) that only server-side consumers import, which is an explicit scope change, not a drive-by addition. Tracked in #444.

## Scope — what does not

- **The binary frame envelope (TFFE).** That is a separate wire format with its own header layout — see [`contributing/frame-envelope.md`](../../contributing/frame-envelope.md). It is currently implemented separately in the relay and the dashboard, which is the same kind of drift risk, but unifying it is not this package's job today.
- **Domain types that are not on the wire.** `Build`, `ReleaseGroup`, UI view models — those stay in their own packages.

## Browser-inbound messages are split by producer, and one union is shared

A browser receives 28 message types. They come from two producers, and the difference matters to the
**relay**, not to the consumer:

- **`RelayToBrowser`** — the relay builds these itself, so `sendTo(socket, msg: RelayOutbound)` holds
  them to the union. The compiler is the check.
- **`AgentToBrowser`** — an agent builds these and the relay forwards them with
  `JSON.stringify(msg)`. Nothing on the relay's send path references them, so **no compiler sees
  them.** That is why all twelve forward-only messages were absent from this file until L3, and why
  `scripts/__tests__/browserInboundRouting.test.mjs` exists: it compares the relay's forward case
  labels against this union in both directions.
- **`RelayOrAgentToBrowser`** — the ten with *both* producers (the relay replays session state to a
  re-joining viewer, and answers a request it cannot deliver). Declared **once** and referenced by
  both unions. Two copies of one message drift, which is not hypothetical: the dashboard kept its own
  copy of this whole surface and four members had diverged with nothing reporting it.

**Consumers should use `BrowserInbound`** — the union of both. A viewer does not care who sent it.

`RelayToStream` is its own direction for one message (`stream:registered`). It sat in
`RelayToBrowser` while that union meant "everything that is not an agent"; its consumer is
`agent-core`'s stream registration and no browser reads it.

### `sessionId` stays required, even where the relay cannot prove it

The relay reaches seven of its own error sites through `msg.sessionId!` — an assertion the compiler
cannot verify — and `JSON.stringify` drops a key whose value is `undefined`. The fix is **not** to
widen the declaration:

- Every in-repo sender does supply one. `BrowserToRelay` declares `sessionId: string` on every member
  but `agents:list`, and the untyped senders (`mcp-server`, `flow-runner`) set it too.
- `'Session not found'` answers a sessionId that did not **match** — a stale tab, a terminated
  session — not one that was absent.
- `{ type: 'error'; message: string }` is the escape hatch for a genuinely uncorrelatable failure. So
  the right move when there is no sessionId is to send *that*, and the required field is what forces
  the choice.

Widening would let #444 delete those `!` with no consumer forced to care, and the guarantee would go
quietly with them. It is also close to irreversible: once optional, every consumer grows a guard.

The same reasoning applies to "no producer sends this yet, so leave it open." `mcp-server` has no
clipboard tool today; when one is added, `requestId` being **required** is what makes a missing id a
compile error instead of a reply the dashboard drops on `if (!msg.requestId) return`.

## `input:error` carries a reason

`input:error` used to travel with a human-readable `message` and nothing else, so a consumer could
not tell three different situations apart: an input that would land if retried in 200ms, one that
needs a reconnect, and one that will never work. All three read as the same failure, so a caller had
nothing to branch on and could only give up or blindly retry. (It is *not* why `mcp-server` falls
back to optimistic success on a timeout — that path fires when no ack arrives at all, and no field on
a message that never arrives could inform it. #457 is that one.)

`InputErrorReason` is the machine-readable half. Two rules make it usable:

- **The set comes from what a consumer must do differently**, not from how many internal states an
  agent has. iOS has one input path (a HID helper process); Android has three (a scrcpy socket, an
  emulator gRPC channel, `adb shell input`). Each agent maps its own states onto this smaller set —
  `android-agent`'s `wireReason()` is that map, and it collapses two of its reasons because a
  consumer's move is identical for them.
- **`message` stays free prose and `reason` is closed.** That is what lets iOS keep
  `` `unknown key code: ${code}` `` — the parameterised wording survives because the machine field is
  separate. Consumers switch on `reason` and display `message`.

The field is **optional**, so an agent that predates it omits it and nothing breaks. Absence
therefore means *unknown*, never *fine*, and **a consumer meeting a reason it does not know must
treat it as `channel-unavailable`** — the conservative reading. Making the field required is the
breaking step and has not been taken.

Every in-repo producer now sends one. The relay was the last that did not (#492) — it answers a
terminal input it cannot dispatch, and being the only producer that reads a socket rather than
inferring from its own state, it was the one whose reason was least in doubt. So absence today means
an agent older than this field and nothing else, which is what #491 needs before the field can become
required.

There is deliberately **no shared message table**. One would be a runtime value, and this entry point
must erase under `import type` (see HOW NOT) — so each agent owns its own wording. A static check in
`scripts/__tests__/inputErrorReason.test.mjs` holds both **agents** to the one union, since neither
agent's own test suite can see the other. The relay is the third producer and needs no such check: it
sends through `sendTo(socket, msg: RelayOutbound)`, so its literal is checked by the compiler.

## HOW NOT

- **No `enum`, no const objects, no runtime values of any kind — in the main entry.** They compile to JavaScript, so the moment a consumer references one as a value it stops being erased by `import type` and lands in the dashboard's browser bundle. String literal unions only. (`src/typeAssertions.ts` is checked by `tsconfig.assertions.json` and excluded from the build for exactly this reason — it declares values, so it must not reach `dist`.)
- **Do not add a dependency.** This package is a leaf — it must stay importable from the browser bundle, the relay, and mcp-server alike.
- Do not widen a message to `unknown`/`Record<string, unknown>` to make a call site compile. That reopens the hole this package closes; fix the call site or correct the type.

## Consuming it

The relay is composite (TS project references), so it needs both the dependency **and** a `references` entry pointing here — see [`contributing/monorepo-project-references.md`](../../contributing/monorepo-project-references.md). `dashboard` and `mcp-server` are not composite; they resolve `src` directly through the `source` export condition and need only the dependency.
