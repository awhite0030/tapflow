---
"@tapflowio/protocol": minor
"@tapflowio/relay": minor
---

Tell an open dashboard tab when its session ends because the agent went away, instead of leaving it to spin.

Restarting a device agent used to orphan the viewer: the relay deleted the session, the browser kept a live socket addressed to a `sessionId` that no longer existed, and everything it sent was dropped as unknown. The tab sat on `Waiting for first frame...` forever with no message, and only a manual page refresh recovered it.

The relay now sends `session:terminated` (with `reason: 'agent-disconnected'`) to whoever is attached, before removing the session — after removal the socket reference is gone. The viewer reports it upward and the dashboard returns to the Mac list with an explanation, then refreshes the agent list immediately so picking the same Mac again does not try to join the dropped session.

The relay also logs one line when an agent connects and one when it disconnects. It previously printed `Waiting for agents...` at startup and then said nothing either way, so a terminal gave no signal about whether an agent was attached.

This is the first half of the fix. Rebinding the tab to the restarted agent's new session — so a restart is invisible rather than merely announced — is tracked separately.
