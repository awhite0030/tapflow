---
"@tapflowio/relay": patch
---

Keep a session alive across an agent restart — the relay half (#426).

Restarting a device agent ended every session it held: the browser was told `session:terminated` and sent back to the Mac list, losing its navigation for something that should have been invisible. The relay now recognises the restart for what it is on the wire — a second socket registering the same devices under the same identity — and re-points the session at it, keeping the id and telling the viewer with `session:rebound`, which the viewer answers with a fresh `device:boot`.

Only devices the restarted agent still reports are kept. One that is gone gets the old treatment: its session ends and its viewer is told why.

`SessionManager.rebind()` owns the whole move, rather than the call site doing it inline:

- **The index order is load-bearing.** The session's id has to leave the old socket's set *before* `agentSocket` is reassigned. Following the idiom in `remove()` — dereferencing the index through `session.agentSocket` — deletes it from the new set and leaves the old one holding it, so the old socket's close, which the relay itself triggers, evicts the session that was just re-pointed.
- **Agent-derived fields now have one writer.** `create()` and `rebind()` both take them from a single function, so a field added to a session cannot land on one path only — and `rebind` is the path that would be missed.
- Capabilities are refreshed, because an upgrade is the usual reason to restart an agent and `session:joined` is only sent once. The device's reported status is refreshed too: left stale, a device that came back down still reads `booted` to the REST guards.
- `readySent` goes false. Carried across, a browser joining just after the restart would be replayed a `device:ready` for a stream that died with the old process.
- The old socket's resource entry is dropped. `evictAgentSocket` normally does this, but it returns early when the socket has no sessions left — exactly the case where all of them were rebound — so the map would otherwise keep a dead socket per restart.

Two things that used to be handled by the eviction the rebind now skips: in-flight screenshot and UI-tree requests are rejected outright instead of waiting out their timeout, and a device that gets a new session is left out of `create()` so the same simulator cannot end up behind two of them. `agent:registered` pairs devices with sessions by id rather than by position, which stops holding the moment some devices are rebound and others are new.

Also answers a terminal input the agent would have silently dropped. A restarted agent holds no state for a session until it is asked to boot, and an input for a session it does not know is discarded with no ack — while the relay's existing "agent offline" reply stays quiet, because the socket is open and healthy. The caller was left to time out, which the MCP client reports as success. It now gets `input:error` with `device not ready`.
