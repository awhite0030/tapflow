---
"@tapflowio/ios-agent": patch
---

Stop refusing a simulator that never stopped running (#646).

After the relay restarts — an upgrade, a dropped Wi-Fi moment, a laptop waking — the agent
re-registers, and re-registering rebuilt its record of each device with "booted" set to false. The
simulators were still up. Anything that had to work out *which* device you meant then answered "no
booted device" about one running in front of you: taking a screenshot, launching an app, reading the
UI tree, opening a URL, installing a build. It stayed wrong until something else happened to correct
it, which for an idle session could be never.

Those five now ask the simulator rather than trusting the flag. The sixth, the video stream, cannot
ask without changing an interface both platforms implement, so the flag is instead refreshed once as
soon as the agent registers — which closes the version of this that lasted, and leaves only the
moment of reconnect itself.

You would have seen this as a tool or an MCP call failing after a reconnect while the screen kept
streaming normally.
