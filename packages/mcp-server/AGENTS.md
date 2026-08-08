---
type: rules
topics: [mcp, ai-agent]
status: living
---

# mcp-server — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

`@tapflowio/mcp-server`: bridges tapflow to LLM agents via the [Model Context Protocol](https://modelcontextprotocol.io).

Published on the standard npm channel and versioned by changesets in the repo-wide fixed group (graduated from the `experimental` dist-tag in 2026-07). Publish only via the changesets flow — see [CONTRIBUTING.md § Branches & releases](../../CONTRIBUTING.md#branches--releases).

Connects to the relay over WebSocket + REST (`TapflowClient`), registers MCP tools, and exposes them to any MCP-compatible client (Claude Code, Codex, Cursor, etc.) via stdio transport.

## HOW

- Entry: `src/index.ts` — reads `TAPFLOW_RELAY_URL` and `TAPFLOW_TOKEN` env vars, connects `TapflowClient`, calls `registerTools`, starts `StdioServerTransport`.
- Client: `src/client.ts` — WebSocket connection to relay + REST calls for build/app data. Its `send()` takes `BrowserToRelay` from [`@tapflowio/protocol`](../protocol/AGENTS.md), so a new outbound message goes in that union first. Receiving stays loose (`Record<string, unknown>` + a predicate) because the relay's replies are validated by nothing on the way in.
- Tools: `src/tools.ts` — all MCP tool definitions. One `registerTools(server, client)` call registers everything.
- Screenshots are saved to a temp file and returned as MCP `image` content with base64 encoding.

### Tool semantics (non-obvious)

`disconnect_device` only leaves the session (`session:leave`) — the device stays booted. `shutdown_device` powers the device down (`device:shutdown` → agent runs simctl/adb shutdown → `device:shutdown-done`); use it to free resources or force a cold boot.

`run_flow` replays a `@tapflowio/flow-runner` YAML flow deterministically (no LLM at replay time) over this process's existing relay connection — it shares the session joined via `connect_device`, so it never opens a second WebSocket or hits "Session busy".

`query_ui_tree` returns the unified element schema (`role`/`label`/`identifier`/`frame`/`enabled`/`rawRole`) via `GET /api/v1/sessions/:sessionId/ui-tree`. Frames are normalized 0-1, so a frame center multiplied by the screenshot pixel size feeds straight into `tap`.

### Input acks: silence is answered "could not confirm", and never retried here

`awaitInputAck` used to report **success** when no ack arrived within 2s. That fallback was for agents
predating the ack protocol and it outlived them, so a tap that never reached the device was reported as
landed to a model that then moved on (#457). Three things about the fix are easy to undo.

- **Silence is "could not confirm", not "dropped".** `ackInput` on both agents awaits a `simctl list` /
  `adb` device verify on the first input after a boot or reconnect, on the same Mac the relay gates at
  80% CPU — so an ack past the window can belong to an input that **did** land. Calling that a drop
  invites a retry, and a retry of a landed input duplicates it. The thrown text says the input may have
  landed and to check device state rather than repeat.
- **Whether silence is fatal is decided by what the session has already done**, not by a negotiated
  flag: `ackedSessions` records any session that has answered an input, and only those are judged
  strictly. An agent that never acks is never judged, which is the safe direction, and it needs nothing
  on the wire. A capability flag was designed for this and discarded — it would have to be advertised by
  both agents, kept in step by a static check, and would then sit inert forever once every install had
  it, unremovable because consumers key on its absence. It would also have pre-decided the fork #491 is
  open on. The residual gap is a session's **first** input, which stays optimistic; silence there
  genuinely does mean an agent that does not ack.
  The ledger is written in `dispatch`, not where the ack is awaited, so an ack that missed its own
  window still counts — that is the case worth learning from, and a ledger kept at the waiter would see
  nothing.
- **Nothing is retried here.** A per-reason retry was designed and discarded: `no-gesture` means either
  "nothing reached the device" or "the opening frames landed and only the last was refused", and the
  wire cannot tell them apart, so a client that retried would sometimes apply a drag twice with nobody
  able to see it had (tapflow#491 carries the vocabulary question). `TapflowClient` also drives
  `run_flow`, so a retry here makes deterministic replay non-deterministic. Retrying is the caller's
  decision, and `REASON_ADVICE` is what it decides on — including the warning that `no-gesture` may
  already have applied part of the input.

## HOW NOT

- Do not add relay-side logic to this package — it is a client only.
- **Do not retry an input inside `TapflowClient`.** See above — the reason vocabulary cannot express
  whether a refused gesture partially landed, so the client cannot know a retry is safe.
- Do not introduce stateful session management beyond what `TapflowClient` already tracks.
