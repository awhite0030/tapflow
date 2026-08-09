---
'@tapflowio/protocol': patch
'@tapflowio/flow-runner': patch
---

fix(protocol): app:clear-state must carry a bundleId, and flow-runner's sends are checked against the contract

`AppClearState` declared `payload?: { bundleId?: string }` — looser than every producer **and** every consumer.
`mcp-server` and `flow-runner` are its only senders and both supply a string; the relay forwards without filling
anything in; and both agents answer `app:clear-state-error` with `'bundleId missing'` when it is absent. So the
declaration permitted a message whose only possible outcome was that error, and it compiled. Now
`payload: { bundleId: string }`.

Not a breaking change: the two in-repo senders already comply, and the dashboard does not send this message at
all.

`flow-runner`'s `RelayClient.send` takes `BrowserToRelay` instead of `Record<string, unknown>`, so its 15
outbound literals are checked. `mcp-server`'s equivalent was already typed in `7637be3`; this finishes the pair.

**Zero compile errors came out of it, and that is the honest result.** Every `sessionId` in that file arrives as
a required `string` parameter, so the root cause that produced 30 errors when the agents were typed (#509) does
not exist here. The value is regression defence, and `scripts/__tests__/clientOutboundTyped.test.mjs` is what
carries it — reading the *signature* rather than any spelling of `send(`, because the agents' equivalent check
was bypassed three times in review by renaming a socket.

Two comments corrected while passing through, since a stale reason argues for the thing that was removed:

- `test-utils`'s `SocketMessage` said its looseness accommodates each importer's richer view of the wire via
  `waitForType<T extends SocketMessage>`. #505 broke that — named interfaces have no implicit index signature, so
  no protocol type satisfies the constraint, and all 25 call sites already violate it invisibly because
  `src/__tests__` is outside the package's tsconfig. The looseness now blocks the richer views rather than
  accommodating them; it stays only because a narrowing nothing type-checks is decoration.
- `mcp-server`'s AGENTS.md presented its loose *inbound* as a settled decision. It is a deferral, tracked in
  #512 along with the live defect narrowing would catch.
