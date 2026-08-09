---
'@tapflowio/protocol': patch
'@tapflowio/flow-runner': patch
---

fix(protocol): app:clear-state must carry a bundleId, and flow-runner's sends are checked against the contract

`AppClearState` declared `payload?: { bundleId?: string }` — looser than every producer **and** every consumer.
`mcp-server` and `flow-runner` are its only senders and both supply a string, and both agents answer
`app:clear-state-error` with `'bundleId missing'` when it is absent. So the declaration permitted a message whose
only possible outcome was that error, and it compiled. Now `payload: { bundleId: string }`.

**No in-repo producer changes** — both senders already comply and the dashboard does not send this message at
all. It is a `patch` on that basis, not on a claim about every consumer: `AppClearState` is a published export and
this package advertises `declare module` re-opening, so adding a required field is source-breaking for an
out-of-repo producer that omits it. None is known to exist; the wording is scoped so the next tightening does not
cite this as precedent for "required fields are patches".

`flow-runner`'s `engine.ts` no longer reaches `driver.clearState` through `flow.appId!`. `parseFlow` rejects a
bare `clearState` with no flow-level `appId`, but `runFlow` is exported and does not parse — an embedder can hand
it a `Flow` built by hand, and the assertion laundered that into `payload: {}` for the device to reject a network
hop later. It fails the step with a nameable cause instead.

`flow-runner`'s `RelayClient.send` takes `BrowserToRelay` instead of `Record<string, unknown>`, so its 15
outbound literals are checked. `mcp-server`'s equivalent was already typed in `7637be3`; this finishes the pair.

**Zero compile errors came out of it, and that is the honest result.** Every `sessionId` in that file arrives as
a required `string` parameter, so the root cause that produced 30 errors when the agents were typed (#509) does
not exist here. The value is regression defence, and `scripts/__tests__/clientOutboundTyped.test.mjs` is what
carries it.

That check took two attempts. Its first draft asserted the signature `private send(msg: BrowserToRelay)` — and
review defeated it with a second helper, `private sendRaw(msg: RelayMsg)`, which passed all seven assertions with
`tsc` and the package suite green while putting a misspelled type on the wire. Keying on a name is the failure
`agentSendTyped.test.mjs` had already been through three times. So it now anchors where its sibling does:
`JSON.stringify` appears once per file and the function enclosing it takes `BrowserToRelay`. Two further gaps
review found in it are closed too — the file list is derived by inspection rather than hardcoded (the pair it
started with excluded the **dashboard**, which has the most send sites of the three), and `BrowserToRelay` is
asserted to still be a union of named messages, because appending `| Record<string, unknown>` to it passed all
250 static assertions while making every literal in all three files accept anything.

Two comments corrected while passing through, since a stale reason argues for the thing that was removed:

- `test-utils`'s `SocketMessage` said its looseness accommodates each importer's richer view of the wire via
  `waitForType<T extends SocketMessage>`. #505 broke that — named interfaces have no implicit index signature, so
  no protocol type satisfies the constraint, and all 25 call sites already violate it invisibly because
  `src/__tests__` is outside the package's tsconfig. The looseness now blocks the richer views rather than
  accommodating them; it stays only because a narrowing nothing type-checks is decoration.
- `mcp-server`'s AGENTS.md presented its loose *inbound* as a settled decision. It is a deferral, tracked in
  #512 along with the live defect narrowing would catch.
