---
'@tapflowio/flow-runner': minor
---

fix(flow-runner): await the input ack, and read the refusal's reason

Two of the four findings in #512 — the two that need no retyping of the inbound.

## A refused input was reported as a UI problem

`tap`, `swipe` and `pressKey` were fire-and-forget. They minted the correlator the terminal frame
declares required and then read nothing, so a refused input passed silently: the next `assertVisible`
polled until its step deadline and the flow failed with "selector not found". The cause was
`not-booted`, `channel-starting` or `channel-unavailable`, and none of them reached the report.

For a test runner that is the worst place to lose a cause. The agents answer every terminal input (#484,
#488) and the relay answers when it cannot reach one (#492), so the information was already on the wire.

What this fixes is the **message**, not the classification: `runFlow` catches every step throw as a flow
failure and the CLI maps that to exit 1, so a refusal whose cause is entirely environmental still reaches
CI as a flow failure rather than the exit 2 this package's AGENTS.md reserves for it. Routing it there
needs a failure kind the engine can distinguish, which is a separate slice.

The three now await `input:done` / `input:error` correlated by `requestId`, and a refusal fails the
step with the reason on it. **`RelayClient.tap` and `pressKey` therefore return `Promise<void>` rather
than `void`.** `FlowDriver` already declared them `Promise<void>` and `RelayDriver` was swallowing the
synchronous return inside an `async` wrapper, so the engine is unchanged; a direct caller of
`RelayClient` that ignored the return now has a promise to ignore, and a refusal it ignores becomes an
unhandled rejection rather than silence.

**No automatic retry, deliberately.** `channel-starting` is the reason that would succeed 200ms later
and retrying it here would be one line, but the retry belongs to whoever owns the step's timeout, not
to a transport method that cannot see it. Naming the reason is what makes that decision possible;
today it is not even visible.

**A missing ack fails the step, but is never reported as a drop.** `mcp-server` treats ack silence as
success (#457) because an LLM re-observes the screen and recovers; a flow replays a fixed script and
cannot, so it fails. It does not, however, claim the input was dropped: `IOSAgent.ackInput` awaits an
untimed `simctl list` on the first input after a boot, on the same Mac the relay gates at 80% CPU, so a
late ack can belong to an input that landed. The failure says "not confirmed — may have reached the
device", and a `console.error` names the two causes the client cannot tell apart (an agent predating
input correlation, whose acks carry no `requestId` and will never match, or a slow one) once per session.

## The join read the prose and discarded the reason

`session:start` refusals were reported by throwing `msg.message`. `reason: SessionStartFailure` is
required on that message and #506 added it precisely because branching on free prose was the bug — the
dashboard handled two of three wordings and dropped `Session busy` silently. This client was still
doing the thing the field exists to replace, so three outcomes wanting different responses were
indistinguishable: retry works, nothing is ever coming, or the Mac is over its ceiling.

`joinSession` now throws `SessionJoinError`, exported from the package entry, carrying `reason`. It
deliberately does **not** rank the three. A draft exposed a `retryable` getter true for `session-busy`
alone, and reading the relay refutes it in both directions: `session-busy` is another browser socket
being open, which is a person holding the device in the dashboard and can last hours, while
`agent-resources-exhausted` is a *sampled* CPU/memory reading over 80% — a build spike that clears in
seconds and is re-read on the next attempt. The transient one was the one marked permanent. Ranking them
needs to know whether the caller can wait and what else it could pick, which is the run's business.

A reason this build does not know reads as `'unknown'` rather than passing through. The guard's member
list lives in this package because `protocol`'s entry must erase under `import type`, and it is a
`Record<SessionStartFailure, true>` rather than a string array, so the union growing is a compile error
here instead of a silent widening.

Findings 1 and 4 of #512 are not in this change. The first is already fixed (`error` carries an address
as of L5d). The fourth — no client handles `session:terminated`, `session:agent-away` or
`session:rebound`, so an agent dying mid-run costs a 120s install deadline instead of a first-second
diagnosis — is a separate slice.
