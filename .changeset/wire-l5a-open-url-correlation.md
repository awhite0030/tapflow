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

So the echo is enforced **structurally** instead: `OpenUrlReplyBody` is the reply minus the correlation
ids, mirroring `ClipboardReplyBody`. A body cannot declare `requestId`, so the send helper is the only
place it can come from — omit it and the call does not compile, mint a fresh one and the excess property
is rejected. No static check, and no per-site edits as the remaining pairs land.

There is deliberately **no fallback** to `sessionId` + type. The `fixed` version group locks protocol,
agent-core, both agents and the relay together, so the in-repo skew window is zero. An `open-url` that
arrives without a `requestId` is dropped with a warning rather than answered, because a reply to it could
not be correlated by anyone and minting an id would make it look like an answer to a request nobody made.
Validating such frames at the relay's door is #444.

`RequestReplies` declares which replies answer which request — one entry so far. Nothing declared that
before, which is why any check over the echo obligation would have had to hard-code the mapping. It also
gives the awkward pairs somewhere to be declared rather than argued about: `device:boot` has four
replies, `session:start` up to five, and three reply types are also sent unsolicited.

`OpenUrl` joins `RelayToAgent`, because the agent has to *read* the id to echo it and its inbound
parameter had no correlator on it. The rest of what the relay forwards is still absent from that union;
each pair brings its own request in as it lands rather than waiting for #444.

**The dashboard was a producer nobody had counted, and correlating it fixes a live bug.** It sends
`open-url` from `DeepLinkDialog`, and `DeviceViewer` toasts the reply — but a reply does not go to whoever
asked, it goes to whichever socket holds the session, so the viewer was showing "Deeplink opened" for
`mcp-server`'s deeplinks. The viewer mints and records the id now and toasts only its own. The id comes
from `getRandomValues`, not `crypto.randomUUID`, which is secure-context only and therefore absent on the
plain-HTTP LAN deployment that is tapflow's primary path.

Also: `open-url` had **no test on the iOS side** — the whole change passed that suite because nothing
exercised the handler, and `SimctlWrapper`'s test double had no `openUrl` at all. Both agents now cover
the echo and the drop.
