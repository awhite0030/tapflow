---
'@tapflowio/protocol': patch
'@tapflowio/agent-core': patch
'@tapflowio/ios-agent': patch
'@tapflowio/android-agent': patch
'@tapflowio/mcp-server': patch
---

refactor(protocol): declare the agent→relay direction, and type every agent send

An agent's outbound literal was the one part of the wire contract no compiler could see. The relay forwards
replies with `JSON.stringify(msg)`, so nothing typed ever re-creates them, and each agent handed its literal
straight to `ws.send`. #489 (an agent answering nobody) and #490 (a missing `reason`) both came out of that,
and `scripts/__tests__/inputErrorReason.test.mjs` exists because a script had to stand in for a compiler.

Seven message types were declared nowhere: `agent:register`, `agent:resources`, `screenshot:done`,
`screenshot:error`, `stream:register`, `ui:tree:response`, `ui:tree:error` — the last undeclared direction.
They are now `AgentToRelay` and `StreamToRelay`, and `AgentOutbound` is what a typed send takes.

`stream:register` is its own direction rather than part of `AgentToRelay`, mirroring `RelayToStream`: the
relay assigns the role `'stream'` from it, not `'agent'`, so folding it in would make the union's name
disagree with the runtime role — and would let a control socket claim to be a session's stream socket once
inbound is narrowed by role.

## Two helpers, and why not one

```ts
private sendMsg(msg: AgentOutbound): void { this.ws?.send(JSON.stringify(msg)) }
private sendOn(ws: WebSocket, msg: AgentOutbound): void { ws.send(JSON.stringify(msg)) }
```

`sendOn` takes the socket **as an argument**. Seven call sites sit behind an entry guard (`if (!this.ws)
return`) and are therefore compiler-proven non-null; reading `this.ws` inside a helper — or asserting it with
`!` — would make those guards optional to the compiler and turn deleting one from a compile error into a
runtime `TypeError`. One of them has a test whose subject is the window that guard covers.

## What the compiler found once it could see

- **30 sends passed an optional `sessionId` into a field declared required.** The agents' dispatcher took
  `{ sessionId?: string }` while every message it dispatches is session-scoped. It now takes a required one,
  with the check moved to the socket boundary — a message with no `sessionId` did not come from the relay's
  forward path, which resolves the session before forwarding.
- **`requestId` was read as optional in the clipboard cases and required in the screenshot and ui:tree ones**,
  for the same wire guarantee, in the same file. Now consistent. It is still an assertion about unvalidated
  JSON, as the other two always were; that is #444.
- **The clipboard `respond` helper took `object`**, so all three clipboard replies were unchecked. Typed with
  `ClipboardReplyBody`, which is `ClipboardReply` minus the ids the helper merges.

**Twenty-five `msg.sessionId!` assertions went away as a consequence**, along with the now-unreachable
`if (!sessionId) return` inside each agent's `ackNoSession`. That is the same payoff #444 is after on the relay
side, arriving here first: once the declaration is required, the assertion has nothing left to assert.

`screenshot:error` and `ui:tree:error` are the first `*-error` messages that do **not** extend `SessionError`.
They are request-scoped — the relay resolves them by `requestId` alone — and the convention check names them,
which draws the family's boundary rather than widening it. `SessionError` is for a failure a *session* is
waiting on.

Their `sessionId` is **required**, like every other producer field. A draft made it optional on the grounds
that the agents pass through an optional id; that was true when written and false by the end of this change,
which required it on both dispatchers. A field weaker than every producer describes a message nobody sends —
and here it would also have removed the one field a symmetric ownership check could read, since the clipboard
replies beside these verify `session.agentSocket === ws` before resolving and these two do not.

The agents' helpers take `AgentControlOutbound = AgentToRelay | AgentToBrowser`, **not** a union that also
includes `StreamToRelay`. An earlier draft merged all three, which handed back the exact hazard the direction
split exists to avoid: `case 'stream:register'` calls `setStreamSocket(session.id, ws)` with no role gate, so a
control socket that could type-check that message could take over the session's video path.

`UIElement`, `UIElementRole` and `UIElementFrame` moved from `agent-core` to `protocol` — `ui:tree:response`
cannot be typed without them and protocol is a leaf that cannot import agent-core. `mcp-server` had a
hand-written mirror with a comment saying so; it is now a re-export.

`scripts/__tests__/agentSendTyped.test.mjs` asserts nothing goes around the helpers, and it matches
**serialization** rather than any spelling of `.send`. Three drafts keyed on `this.ws` were bypassed in review
by renaming the socket — `streamWs.send(JSON.stringify(…))` walks past them, and that is not hypothetical:
`streamWs` is in scope in `startBinaryStream` and the relay dispatches a text frame from a stream socket
through the same agent cases. A commented-out copy of the canonical helper also satisfied the positive
assertion while the real one took `msg: object`, leaving all 66 of that agent's sends unchecked with the check
green. Both are closed, and a file in the agent packages that writes to a socket *and* serializes now has to
be listed with a reason.
