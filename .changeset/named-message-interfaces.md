---
'@tapflowio/protocol': patch
'@tapflowio/relay': patch
---

refactor(protocol): give every wire message a name

58 messages were anonymous members of a union, which meant two things could not be done. A single
message could not be referred to — consumers reached for `Extract<Union, { type: 'x' }>`, one of them
needing `extends { payload: infer P }` to get at a payload. And shared structure had nowhere to live:
eight session-scoped failures carry the same `{ sessionId, message }` contract with no place to say so,
and the comment explaining it floated above a union line.

Each message is now an `export interface`, and the unions are unions of those names.

- **`SessionError`** — the eight session-scoped failures extend it. Not for DRY (two fields) but so
  that "this is a failure addressed to a session" is something a reader and a check can see, and the
  contract note has a home. `error` does not inherit: it has no `sessionId`, which is the whole point
  of that member.
- **Direction suffixes where a literal means two things.** `app:install` and `app:launch` travel in
  both directions with *different* shapes — the browser sends `buildId`, the relay resolves it and
  sends `payload: { filePath, bundleId }`. Naming forced the split: `AppInstallToRelay` /
  `AppInstallToAgent`. `device:shutdown` is identical in both directions, so it is one interface both
  unions reference, which now says out loud that the relay forwards it untouched.
- `GenericError`, because `Error` would shadow the global.

**Names were derived from the `type` literals mechanically, not typed by hand.** The conversion's real
hazard is a copy-paste that leaves two interfaces holding each other's literal, and `AgentToBrowser`
has seven members whose shape is identical apart from the literal. A type-level equivalence check
cannot see it — a union is a set, so which name owns which literal is not part of the comparison, and
the routing check compares membership, so the literal set is unchanged. Measured: the swap produced
zero errors from the nine equivalence assertions.

So `typeAssertions.ts` carries one binding per message (`_InputDone: InputDone['type'] = 'input:done'`),
and `scripts/__tests__/protocolMessageNames.test.mjs` asserts every message has one — plus that the
eight failures declare `extends SessionError`, which no type can state about itself because every
object with `{ sessionId, message }` is assignable to it.

The conversion itself was proven with `Equals<Union, UnionOld>` against verbatim snapshots and then
deleted along with them; that net was for the conversion window, not for keeping.

**Two properties were given up, neither visible to that proof.** A named `interface` has no implicit
index signature, so a message is no longer assignable to `Record<string, unknown>` — nothing breaks
today because the three such sinks in this repo only ever receive fresh object literals, and the fix
when one needs a typed value is to type the sink rather than widen the message. And an `interface` can
be reopened by a consumer via `declare module`, which an anonymous union member could not. Both are
recorded in `packages/protocol/AGENTS.md`.
