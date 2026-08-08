---
'@tapflowio/protocol': patch
'@tapflowio/agent-core': patch
'@tapflowio/flow-runner': patch
'@tapflowio/mcp-server': patch
'@tapflowio/relay': patch
---

refactor(protocol): wire payload types are declared once, and a check keeps them that way

Every wire payload type was declared separately in three to five packages, and they had drifted **in
both directions**: `@tapflowio/protocol` was missing the `payload` field on `clipboard:error` that both
agents send and the viewer reads, while the dashboard's `session:chrome` declaration was missing three
fields its own `DeviceViewer` reads. Nothing checked either side, which is the situation
`@tapflowio/protocol` was created to end — it had been half done.

Protocol now owns them and everyone else imports: `ChromeData`, `ChromeButton`, `ChromeRect`,
`AndroidButton`, `AgentResources`, `SessionInfo`, `Point`, and `ClipboardErrorPayload` (which moves out
of `agent-core`, since neither the dashboard nor `mcp-server` can reach that package). `agent-core`,
`flow-runner` and the relay re-export the names they published, so no consumer of those packages
changes — including third-party agents built on `AgentRegistry.register()`.

Three shapes were also the same thing under different names, which is how the duplication survived:
protocol's `DeviceSummary` was `AgentDevice` in the dashboard and `DeviceInfo` in `mcp-server` and
`flow-runner`, and that last name collided with the relay's own `DeviceInfo`, which is a *different*
shape. `DeviceSummary` is now the one name; `flow-runner` keeps exporting `DeviceInfo` as an alias
because the CLI imports it.

**The comments moved with the types, and that mattered more than the types.** `ChromeData`'s fields
were described accurately only in `ios-agent`, which produces them: the viewer lays out against an
*expanded* composite canvas (the device frame grown by the button margins), and protocol's copy said
`compositeWidth` was "full PDF width including devicePadding" — a different quantity. Deleting the
producer's declaration would have deleted the only correct description of the coordinate space three
viewers compute against. Protocol's fields now carry it, with the two spaces named explicitly.

A new check (`scripts/__tests__/protocolPayloadTypes.test.mjs`) fails if any package re-declares a
protocol payload shape. It matches on **field sets, not names** — the inventory that planned this work
grepped for names and missed two of the five copies of one shape for exactly the reason above, so a
name-scoped check would have passed with all five standing and would be bypassed by a rename. It found
two more copies during implementation: the relay's own `SessionInfo` and `agent-core`'s `Point`.

No behaviour change: type declarations, imports and comments only. Every package's test count is
unchanged.
