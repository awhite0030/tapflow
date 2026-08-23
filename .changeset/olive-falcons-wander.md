---
"@tapflowio/ios-agent": minor
---

Take one iOS simulator off the network and put it back (#607), the iOS half of the toggle Android
already answers with airplane mode.

A simulator has no radio to switch off — it is host processes sharing the Mac's network stack — so
there is nothing to ask. Three mechanisms are applied together instead, and each one alone produces
a result a tester would sign off on and be wrong about:

- a **host content filter** drops that simulator's flows at the kernel. It is a content filter and
  not a transparent proxy because the proxy was measured and could not see simulator traffic at
  all: 217 flows reached its handler and every one was a host process.
- an **injected library** tells the app its path is unsatisfied. Without it the offline banner never
  appears — an app reads `nw_path_get_status` inside its update handler, the real path never
  changed, so the handler never fires again. Measured with the filter alone: traffic dead, path
  satisfied for the life of the process.
- the **status bar** stops showing service.

**Which simulator a flow belongs to is recovered from the process tree.** A flow carries a bundle id
and never a device, so the filter walks the flow's process up to its `launchd_sim` and reads the
UDID out of that process's arguments — the only place it appears, since simulator binaries live in
a shared runtime and the working directory is `/`. Two simulators running at once resolve to their
own UDIDs with no misattribution, which is the isolation RocketSim cannot do: it filters by bundle
id, so the same app on two simulators is one target.

**Connections the app already holds are cut, and they have to be.** `URLSession` keeps one
connection for a whole session, so a tester who goes offline mid-session would otherwise watch the
app keep talking over the socket it already had while only *new* requests failed. The host cannot do
this — Apple is explicit that allowing a connection is one-way, and keeping every flow under a data
verdict instead was built and measured unusable — so the injected library shuts down the app's own
non-loopback sockets when it goes offline. `shutdown`, not `close`: the owner sees the connection go
away, which is what losing signal looks like, and nothing can reuse the descriptor underneath it.

**Loopback keeps working**, so a dev build talking to Metro on the host, and tapflow's own
in-simulator instrumentation, are unaffected.

`network:state` reports `available: false` with a reason until an app has actually run under the
injection, because the injection arms at boot and names its target when an app is launched. A
control that claimed to work before then would be the false green this feature exists to prevent.

**This needs a signed system extension on the host, which is not yet distributed** — an agent
without it reports `available: false` rather than failing, so nothing else about a session changes.
