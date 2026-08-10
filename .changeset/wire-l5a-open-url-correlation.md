---
'@tapflowio/protocol': minor
'@tapflowio/relay': patch
'@tapflowio/mcp-server': patch
'@tapflowio/flow-runner': patch
'@tapflowio/ios-agent': patch
'@tapflowio/android-agent': patch
---

feat(protocol): open-url carries a requestId, and both replies echo it

First pair of the request/response correlation work. `open-url` requests carry a `requestId` and
`open-url:done` / `open-url:error` echo it, so a caller matches its own reply instead of matching on
`sessionId` + message type and taking whichever arrives first.

Nine request/response pairs correlate that way today, and it is the shared root of #499, #512's first
finding, and the seven relay reply sites in #444. Three other pairs — `screenshot`, `ui:tree`,
`clipboard` — already carry a `requestId` and have no such issues. This layer extends what works rather
than inventing anything.

**`requestId` is required on the reply, not optional, and the reasoning is worth keeping.** A first draft
made it optional so that an agent predating the field would not falsify the declaration. Review measured
that decision and reversed it:

- Required yields **complete, precise** in-repo compile errors — ten, at exactly the ten production sites
  for this pair, nothing else. L4a's typed agent sends are what make the write side fully covered.
- Optional needs a static check to replace the compiler, and that check **cannot exist.** Presence is
  checkable; the property is *provenance* — that the id is the request's. A check built and run against
  the clipboard family (100% correlated today) produced seven false positives, because
  `respond({ sessionId, requestId, ...body })` puts the `type` literal and the id in different object
  literals; and it passed when an echo was replaced with a freshly minted id.
- Absence would carry **two** meanings wanting opposite handling — "an old agent" and "not a reply at
  all". The relay's `device:ready` replay is a permanent producer of the second, and reading it as the
  first is the `{booted: true}` for a boot that never happened that #516 measured and refused to ship.
- The repo had already decided this seven times: of the eleven messages declaring `requestId`, seven are
  agent-produced replies and all are required.

The echo is enforced by a mix, and the mix is worth stating precisely because review measured 13 attacks
and the type caught 3. **Omitting the correlator is a compile error** — from `requestId: string` being
required on the reply interfaces, reached through the agents' typed send helper. **A freshly minted id
written as a literal at the `respond(...)` call is an excess property** — that one is `OpenUrlReplyBody`,
the reply minus the ids, mirroring `ClipboardReplyBody`. The agents spread `...body` **first** so that a
body *variable* carrying an id cannot override the real one; excess-property checking does not fire on
variables, and an earlier draft had the ids first, which let a wrong id win.

What the types do **not** cover: the agents' send helper accepts any `string`, so a site that bypasses
`respond` type-checks. Each agent's echo tests are what catch that, including a **concurrency** test —
hoisting the correlator out of per-request scope compiles clean, passes every other test, and answers two
in-flight requests with the second one's id, which is precisely the class this layer removes. So each
remaining pair needs its own echo tests; this helper does not remove that work.

There is deliberately **no fallback** to `sessionId` + type. The `fixed` version group locks protocol,
agent-core, both agents and the relay together, so the in-repo skew window is zero. An `open-url` with no
`requestId` is dropped rather than answered — by both agents **and by the relay**, which is one policy
instead of the two an earlier draft had: it answered with `requestId: msg.requestId!`, and that is not the
`sessionId!` beside it in kind. `sessionId!` feeds a read, so a miss still produces a visible error;
`requestId!` feeds a write into an outbound frame, where `JSON.stringify` drops the key and ships an
`open-url:error` whose required correlator is absent — which every correlating consumer then discards,
turning "agent offline" into a caller waiting out its full deadline. Validating such frames at the door is
#444's job; until then the relay declines to construct a frame it knows is invalid.

**A reply from a third-party agent predating this field is dropped the same way** — the dashboard shows no
toast and `mcp-server` / `flow-runner` wait out 15s. In-repo that cannot happen (the `fixed` group), but an
independently installed older `mcp-server` or `flow-runner` will time out `openUrl` against a current
relay. That is the upgrade note for this release.

Two additions from an earlier draft were **removed** after review measured them inert: a `RequestReplies`
/ `ReplyOf` mapping with zero consumers repo-wide (deleting it left `tsc` and all 255 static assertions
green — exactly the unenforced-mapping property its own doc comment criticised), and `OpenUrl` in
`RelayToAgent`, whose stated reason was false: neither agent consumes that union, both still read a
hand-written inbound literal, and removing the member changed nothing. They come back when a second pair
needs them and something checks them.

**Routing is unchanged and this does not fix it.** Replies are still delivered to whichever socket holds
the session rather than to the requester, so an `mcp-server` deeplink on a dashboard-held session now has
its reply dropped silently by the dashboard instead of toasted as a lie. Correct at both endpoints, still
misaddressed in the middle — the relay already keys replies by `requestId` for `screenshot` / `ui:tree`
via a pending map, and the same shape would fix it.

**The dashboard was a producer nobody had counted, and correlating it fixes a live bug.** It sends
`open-url` from `DeepLinkDialog`, and `DeviceViewer` toasts the reply — but a reply does not go to whoever
asked, it goes to whichever socket holds the session, so the viewer was showing "Deeplink opened" for
`mcp-server`'s deeplinks. The viewer mints and records the id now and toasts only its own. The id comes
from `getRandomValues`, not `crypto.randomUUID`, which is secure-context only and therefore absent on the
plain-HTTP LAN deployment that is tapflow's primary path.

Also: `open-url` had **no test on the iOS side** — the whole change passed that suite because nothing
exercised the handler, and `SimctlWrapper`'s test double had no `openUrl` at all. Both agents now cover
the echo and the drop.
