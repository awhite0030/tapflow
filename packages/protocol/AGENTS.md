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

## Every message is a named `interface`, and naming cost two things

A message is `export interface AppInstallDone { type: 'app:install-done'; … }`, and the unions are
unions of those names. That is what lets a consumer refer to one message, and what gives shared
structure (`SessionError`) and per-message documentation somewhere to live.

**`interface`, not `type X = { … }`** — the alias form cannot be `extends`ed, and the intersection
workaround (`type X = SessionError & { … }`) stops `Extract<Union, { type: 'x' }>` resolving to a single
member, which `useClipboardBridge` depends on to read a reply without a cast.

Two properties were given up for that, neither visible to the type-equivalence check that proved the
conversion, so they are written down here instead:

- **An `interface` has no implicit index signature.** An anonymous `type X = { … }` is assignable to
  `Record<string, unknown>`; a named interface is not. Nothing broke, because the three
  `Record<string, unknown>` sinks then in this repo were only ever handed fresh object literals — and
  **the fix when one of them needs a typed value is to type the sink**, not to widen the message. Two
  have been: both clients' `send` takes `BrowserToRelay` (`7637be3`, L4c), and their `RelayMsg` is now
  inbound-only. The third, `test-utils/src/socket.ts`, is the case where this constraint bites in the
  other direction: its comment claimed the looseness accommodated each importer's richer view via
  `waitForType<T extends SocketMessage>`, and that extension point is what an interface having no index
  signature **broke** — no protocol type satisfies the constraint. All 25 call sites violate it
  invisibly, because `src/__tests__` is outside that package's tsconfig.
- **An `interface` can be reopened by a consumer.** `declare module '@tapflowio/protocol'` can add a
  field to any message, which an anonymous union member could not. Measured: a consumer can give
  `GenericError` a `sessionId` and defeat the assertion in `typeAssertions.ts` that says it has none.
  It takes deliberate augmentation, so the risk is low — but the HOW NOT rule below ("do not widen a
  message") is now bypassable without editing this package.

### The name must be derivable from the literal

`InputDone` ↔ `input:done`: PascalCase over the literal's `:` and `-` segments. Five names deliberately
break the rule and are listed in `scripts/__tests__/protocolMessageNames.test.mjs` — `GenericError`
(`Error` would shadow the global), and `AppInstall`/`AppLaunch` × `ToAgent`/`ToRelay`, because those two
literals travel in both directions carrying **different shapes**: the browser sends `buildId`, the relay
resolves it into `payload: { filePath, bundleId }`. Naming forced that split into the open.

`device:shutdown` is the opposite case — identical in both directions, so it is **one** interface that
`RelayToAgent` and `BrowserToRelay` both reference, which states that the relay forwards it untouched.

The derivation is checked in source, and it is the only guard here that a regeneration cannot satisfy.
The per-message bindings in `typeAssertions.ts` (`_InputDone: InputDone['type'] = 'input:done'`) compare
two copies of one fact, so they catch an author who edits one of them; measured, editing both left every
assertion green.

## Request/response correlation — `requestId`, required on both sides

Four pairs correlate by `requestId` today: `screenshot`, `ui:tree`, `clipboard`, and the app commands
(`open-url`, `app:install`, `app:launch`, `app:clear-state`). The rest still correlate by `sessionId` +
message type, which is the root of #499 and of #512's first finding — a reply for one request satisfying
another's waiter. Each remaining pair is scheduled; the reason a pair is *not* in the set is always one of
the two below.

**Required on the reply, not optional.** The tempting asymmetry is to leave the reply optional so an agent
predating the field does not falsify the declaration. It was measured and rejected:

- `required` yields complete, precise in-repo compile errors, because every agent send goes through a typed
  helper. Ten sites for `open-url`, nothing else.
- `optional` needs a static check to stand in for the compiler, and that check **cannot exist**. Presence is
  checkable; the property is *provenance* — that the id is the request's. A check built against the
  clipboard family, which is 100% correlated, produced seven false positives (a `respond` helper puts the
  `type` literal and the id in different object literals) and passed when an echo was replaced with a
  freshly minted id.
- Absence would carry **two** meanings wanting opposite handling: "an old agent", and "not a reply at all".
  The relay's `device:ready` replay is a permanent producer of the second.

**What enforces the echo, exactly.** Omission is a compile error — from `requestId: string` on the reply
interfaces, reached through the agents' send helper. A freshly minted id written as a *literal* at the
`respond(...)` call is an excess property — that is `<Pair>ReplyBody`, the reply minus the ids. Everything
else is tests, and **each pair needs its own**: an echo test per outcome and a concurrency test, because
hoisting the correlator out of per-request scope compiles clean and passes every other test in the suite.
The helper does not remove that work; a slice that assumed it did shipped six unverified `respond` helpers.

**Do not build a request-direction body type.** Four candidate guards were designed and broken. A branded
correlator is laundered by any cast to the brand, because a brand names a *kind* while provenance is a
property of the *instance* and TypeScript has no value-dependent types. A generic `Omit`-body helper does
not compile without a cast of its own, which is worse than the literal it replaces. The reply side earns its
type from ~20 literal sites; the request side has one per pair, on the line below the helper that builds it.

**A transformation carries the correlator.** `open-url` and `app:clear-state` are re-serialised whole, so it
rides for free. `app:install` / `app:launch` arrive with a `buildId` and the relay sends the agent a
*different* message after a DB lookup — the id must be copied, or the agent's reply, which the relay
forwards without inspecting, cannot be attributed. Required on the `…ToAgent` members makes dropping the
copy a compile error; only a test says the copied value is the request's.

**No fallback, and one policy at the door.** There is deliberately no fall-back to `sessionId` + type: a
second correlation strategy is what this work removes. Every browser request declaring a required
`requestId` is gated at the relay before it is forwarded, rebuilt or answered, because every reply it can
produce declares the correlator required too — answering without one means shipping a frame whose required
field `JSON.stringify` erases, which every correlating consumer then discards, turning a diagnosis into a
caller waiting out its deadline. That was a live defect twice (`open-url:error`, then `clipboard:error` a
slice later), so it is checked rather than asserted in prose:
`scripts/__tests__/correlatedRequestsGated.test.mjs` derives the request set from this file and fails if one
is ungated.

**Two properties make a correlator `optional` rather than absent**, and both were found by trying. They were
first written here as putting a pair *outside* correlation, which was wrong by one step: what they rule out is
`required`, and the pair still correlates — see 「Lifecycle correlation」 below.

- **The relay originates the request.** `device:shutdown` is sent by the relay itself when a browser socket
  closes, and it is one interface shared by both directions — so a required correlator would force the relay
  to invent an id for a request nobody made.
- **The reply is also sent unsolicited.** `device:shutdown-done` is read by `SessionList` as a device-status
  broadcast, the relay replays `device:ready` from cache on a re-join, and `AndroidAgent.restartVideoStream`
  sends `device:boot-error` for a stream that died mid-session. A consumer that discards on a correlator
  mismatch stops learning about state it did not ask about — the cross-requester delivery that is a bug for
  `open-url` is the feature here.

## Lifecycle correlation — where the correlator is optional, and what that costs

`device:boot` / `device:shutdown` correlate, but not in the shape above: the **request** side of `device:boot`
is required and every reply is `requestId?`. Absence has exactly one meaning, and it is the one worth stating
at each declaration: **this frame is not the answer to a request.** Not "an old agent" — that reading is what
made the first draft of this pair wrong.

**Optional means the reply's echo is enforced by tests alone.** `<Pair>ReplyBody` cannot be built for an
optional field — `Omit<T,'sessionId'|'requestId'>` is satisfied by an object that simply has no correlator, so
the excess-property trick that catches a freshly minted id has nothing to bite on. Everything the compiler does
for the app commands, tests do here. D24 applies at full strength, and the surface it applies to is wider than
the reply declarations, because **almost none of the fixtures constructing these five messages are typed.**
Deliberately no count here: three different greps for them disagree, and a number in this paragraph was wrong
within one commit of being written. The structural fact is what holds. The dashboard's are typed and checked —
its test channel is `useRef<(msg: BrowserToRelay) => void>` and its injected replies are annotated
`BrowserInbound`, which is why that package has a rule against `as never` and local shapes. Everyone else's
are `JSON.stringify({ … })` literals at an untyped `ws.send`, so they are `any` at the call site; the agent and
`mcp-server` tsconfigs also exclude `src/__tests__`, but typechecking those folders would not have helped,
because there is no annotation for a compiler to check against. The consequence is concrete: promoting
`DeviceBoot.requestId` to required produced no error in those files and instead **hung two agent suites**, and
several of those fixtures send `device:ready` with no `payload` at all — a shape the wire cannot produce.

**Because the correlator is optional, `correlatedRequestsGated` cannot see it.** That check derives its set
from *required* declarations (`/^ {2}requestId: string$/`), so every door gate and echo obligation on this pair
is outside its reach. The one that matters most is the relay's own: the relay answers a `device:boot` itself
when the agent is offline or the session is unknown, and that `device:boot-error` must echo the id or an MCP
caller reads a diagnosis as unsolicited and waits out its deadline instead. That is the defect this file already
records as having shipped twice, in a position no check reaches. A test is the only thing holding it.

**A consumer correlating one of these replies is a bug, and one of them is load-bearing.** The dashboard must
**not** gate `device:boot-error` on the correlator — it is the sole surface reporting a mid-session stream
death, which carries no id by construction. `device:booting` is not correlated for a stronger reason than
"nobody waits on it": `DeviceViewer` **must** act on a boot another client requested, tearing down chrome and
in-flight install records whoever asked, so correlating it would suppress the case the message exists for.
What the correlator does buy on the consumer side is narrower and real — `DeviceViewer` decrements a pending
rebind on `device:ready`, and a replayed ready currently consumes one and fires a duplicate `app:install`.

**The request side is asymmetric for a mechanical reason, not a stylistic one.** A request passes *through* the
relay, so one door gates and logs every sender at once. A reply does not — the relay forwards it with
`JSON.stringify` without inspecting it — so "log the uncorrelatable frame" has to be written once per consuming
client, and one of those clients must not drop at all.

## Every direction is declared, and an agent's send is typed

The six unions cover the whole wire: `BrowserToRelay`, `AgentToRelay`, `RelayToAgent`, `RelayToBrowser`,
`AgentToBrowser`, `RelayToStream` / `StreamToRelay`. Both agents route every send through two typed helpers
rather than touching `ws.send`, and `scripts/__tests__/agentSendTyped.test.mjs` holds them to it — by matching
**serialization**, because three drafts keyed on the spelling `this.ws` were bypassed simply by giving the socket
another name.

**The helpers take `AgentControlOutbound = AgentToRelay | AgentToBrowser`, which excludes `StreamToRelay`.** A
union covering both sockets is the obvious thing to write and it undoes the direction split: the relay's
`case 'stream:register'` calls `setStreamSocket(session.id, ws)` with no role gate, so a control socket able to
type-check that message could take over the session's video path. The stream socket's one message is typed at its
own send site in `agent-core/src/utils/stream.ts`.

That mattered because an agent's literal was the one thing no compiler saw — the relay forwards replies with
`JSON.stringify(msg)`, so nothing typed re-creates them. #489 and #490 are what the gap cost, and
`inputErrorReason.test.mjs` exists because a script had to stand in for a compiler.

**The browser side is the same rule and the same check shape.** All three browser-role producers — the dashboard's
`useRelay`, `mcp-server`'s client, `flow-runner`'s `RelayClient` — serialize through one `BrowserToRelay` sink, and
`scripts/__tests__/clientOutboundTyped.test.mjs` holds them to it. Its first draft asserted the *signature*
`private send(msg: BrowserToRelay)` and was defeated by a second helper named `sendRaw`: the assertion kept
passing on the typed one while the untyped one put a misspelled type on the wire. So it anchors on serialization
too, and derives its file list by inspection — the hardcoded pair it started with silently excluded the dashboard,
which has the most send sites of the three (47, against 32 for both clients).

Both checks read a union's *name* at the sink. Neither read its contents, and appending
`| Record<string, unknown>` to `BrowserToRelay` passed every static check while making all three clients accept
anything. Guards that name a type also have to assert the type is still a union of named messages.

**`screenshot:error` and `ui:tree:error` do not extend `SessionError`, and that is the boundary of the
family.** `SessionError` is for a failure a *session* is waiting on. Those two are request-scoped: the relay
resolves the pending promise by `requestId` alone and never reads their `sessionId`.

Their `sessionId` is nevertheless **required**, like every other producer field. A draft made it optional because
the agents passed through an optional id — true when written, and false by the end of the same change, which
required it on both dispatchers. A field weaker than every producer describes a message nobody sends, and here it
would also have removed the one field a symmetric ownership check could read: the clipboard replies beside these
verify `session.agentSocket === ws` before resolving, and these two do not.

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
  but `agents:list`, and since L4c all three senders are typed against that union, so the compiler
  enforces it rather than convention. (This bullet used to read "the untyped senders (`mcp-server`,
  `flow-runner`) set it too" — true when written, and falsified by the work that typed them.)
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

The relay is composite (TS project references), so it needs both the dependency **and** a `references` entry pointing here — see [`contributing/monorepo-project-references.md`](../../contributing/monorepo-project-references.md). `dashboard` and `mcp-server` are not composite and need only the dependency — but they do **not** read `src` under `tsc`. Neither sets `customConditions` (`dashboard` is `moduleResolution: bundler`, `mcp-server` is `Node16`), so both take the first key in this package's `exports`, which is `./dist/index.d.ts`. The `source` condition is wired into **vitest** only, via `vitest.shared.ts`'s `ssr.resolve.conditions`.

That has a consequence worth knowing before measuring anything: **`pnpm typecheck` lies about these two until this package is rebuilt.** Tightening a field here and running the dashboard's typecheck against a stale `dist` reports 0 errors. And `tsc -b` never sees them at all — neither is in the root `references`, so a change whose fallout is entirely in `dashboard` builds clean.
