---
'@tapflowio/protocol': minor
'@tapflowio/relay': minor
---

fix: enforce union membership in both directions, not just narrowing

The wire-contract program made every message's **fields** checked and left its **set membership**
checked in one direction only. Narrowing was held by the compiler and held well — `sendTo` refuses a
message outside its union. Widening was free: measured on `main`, adding `DeviceBooting` to
`BrowserToRelay` left `pnpm typecheck` at zero errors and all 294 static tests green.

## The copy with the security consequence

`AGENT_MSG_TYPES` in the relay is a hand-maintained second list of what an agent produces, and the
door check closes a `browser`-role socket with 1008 for any member. The forwards it guards mostly
resolve a session from the message and send to *that session's* browser with no check that the sender
is that session's agent — `clipboard:*` is the deliberate exception. So an agent→browser message added
to the protocol and forgotten in that list makes a viewer drivable by anyone who knows a session id,
with the type union claiming otherwise.

Measured before this change: dropping `keyboard:toggled` from the set left both suites green.
`clipboard:data` was held only because somebody had written that one test by hand.

Types erase, so no runtime array can be derived from a union. What is available is the compiler
checking two lists against each other, and that is what this adds — as type-level assertions, so a
violated invariant is a compile error at the declaration rather than a test somebody has to run.

Three invariants now hold:

- the relay's `MessageType` covers every protocol literal and invents none. It was missing
  `stream:request-idr` — the exact drift `protocol/AGENTS.md` cites as this package's reason to exist,
  still alive in the copy underneath it;
- `AGENT_MSG_TYPES` equals what the agent directions declare, both ways;
- **nothing a browser may send is something an agent produces.** This is the one that catches widening
  without restating 63 literals, and it is the invariant the door enforces at runtime. Not blanket
  disjointness: `device:shutdown` is deliberately a member of both `RelayToAgent` and `BrowserToRelay`.

## And the half a type cannot state about itself

A message declared in the protocol but placed in **no** direction reaches none of the above — it is
absent from the union those assertions read, so nothing is ever obliged to know it. Types cannot
enumerate their own declarations, so that one is checked as source text alongside the two facts
`protocolMessageNames.test.mjs` already checks that way. All 65 declared messages reach a direction
today.

`AnyWireMessage` is new and public: the seven directions unioned, so a consumer can assert its own
list is complete rather than merely correct so far.
