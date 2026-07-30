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

- **JSON message types** over the relay WebSocket, grouped by direction.
- **Runtime validators**, if they are ever added. They belong next to the types they validate; splitting them would recreate the drift this package removes.

## Scope — what does not

- **The binary frame envelope (TFFE).** That is a separate wire format with its own header layout — see [`contributing/frame-envelope.md`](../../contributing/frame-envelope.md). It is currently implemented separately in the relay and the dashboard, which is the same kind of drift risk, but unifying it is not this package's job today.
- **Domain types that are not on the wire.** `Build`, `ReleaseGroup`, UI view models — those stay in their own packages.

## HOW NOT

- **No `enum`, no const objects, no runtime values of any kind.** They compile to JavaScript, so the moment a consumer references one as a value it stops being erased by `import type` and lands in the dashboard's browser bundle. String literal unions only.
- **Do not add a dependency.** This package is a leaf — it must stay importable from the browser bundle, the relay, and mcp-server alike.
- Do not widen a message to `unknown`/`Record<string, unknown>` to make a call site compile. That reopens the hole this package closes; fix the call site or correct the type.

## Consuming it

The relay is composite (TS project references), so it needs both the dependency **and** a `references` entry pointing here — see [`contributing/monorepo-project-references.md`](../../contributing/monorepo-project-references.md). `dashboard` and `mcp-server` are not composite; they resolve `src` directly through the `source` export condition and need only the dependency.
