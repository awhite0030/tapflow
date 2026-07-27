---
"@tapflowio/mcp-server": minor
"@tapflowio/relay": minor
"@tapflowio/ios-agent": minor
"@tapflowio/android-agent": minor
---

MCP input tools now report what actually happened instead of always reporting success.

`tap`, `swipe`, `press_key` and `press_button` were fire-and-forget: the tool answered `{tapped: true}` no matter what the agent did with the input. Against a session whose device is not booted the input was dropped and still reported as success — a false positive that also makes parallel test results untrustworthy.

Agents now acknowledge a gesture's terminal message with `input:done` or `input:error`, and the tools surface that. `done` means the agent dispatched the input to a booted device; as with the existing `input:type-done`, it is not a guarantee the app reacted.

Additive: an agent that does not send the ack is handled as before.
