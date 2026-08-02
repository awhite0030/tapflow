---
"@tapflowio/protocol": patch
"@tapflowio/relay": patch
"@tapflowio/dashboard": patch
---

Make an agent restart survivable for the tab that is watching (#426).

The relay could already re-point a session at a restarted agent's socket (#458), but the trigger almost never fired. It required the old socket to still be registered when the new one arrived, and on a restart it never is: the close is processed in under 400 ms while a new agent takes about a second to register. Measured on a real simulator — the tab got the same bounce to the Mac list it got before any of this existed.

So a closed agent socket no longer ends its sessions on the spot. They are held for 15 seconds (`TAPFLOW_AGENT_GRACE_MS`), which is long enough for the agent to come back and reclaim them, and the tab keeps its place. If it does not come back the window closes and the session ends exactly as before.

The sessions stay where they are rather than moving to a holding area of their own — a returning agent is found by walking the sessions and reading the socket each one points at, so a session parked anywhere else could never be reclaimed.

**`session:agent-away`** tells an attached viewer what is going on. Without it the tab would sit on a picture that stopped updating for the length of the window, which is the complaint #426 was opened with. The viewer drops the frame and says the agent went away; whichever answer follows — reconnected, or ended — replaces it. A genuinely dead agent is now better reported than before, not worse: the wait is explained, and only the news that it is over arrives later.

Also, while an agent is away:

- **Its devices are not offered.** A held session is not something anyone can pick, and listing it would draw a Mac card carrying the dead agent's last CPU and memory reading with no warning attached — the existing staleness badge keys off a 30-second-old sample, far longer than the window. It also prevents a duplicate card when a returning agent identifies itself differently, which is what happens when the upgrade that prompted the restart is the one that starts sending a machine id.
- **Joining says so.** The join is allowed and answered with `session:agent-away`, rather than refused. Refusing looked simpler and was a trap: the viewer sends `session:start` once per reconnect and ignores a plain error, so a browser blip inside the window would strand the tab past any recovery.
- **Nothing from the previous process is replayed** to a viewer that joins — its chrome, device info and readiness all describe an agent that is gone.
- `device:boot` for a held session answers `agent offline` rather than `Session not found`. The id is valid, and retrying in a moment may well work.
