# @tapflowio/mcp-server

## 0.18.0

### Minor Changes

- 7637be3: Add `@tapflowio/protocol`, one wire contract for the WebSocket messages exchanged between browser, relay and agents, and type every place that originates a message against it.

  Nothing checked those messages before. The relay built them as inline object literals passed to `JSON.stringify`, the dashboard's `send()` took `object`, and mcp-server's took `Record<string, unknown>` — so the definitions each package kept were descriptions, not contracts, and three of them had already drifted from the wire:

  - `stream:request-idr` was sent by the relay from two places while absent from its own `MessageType`.
  - `input:key` was documented as `payload: { key: string }`. Every sender and both agents use `{ code, modifiers }`, with `modifiers` a HID bitmap — so the field name and the type were both wrong.
  - `input:touch:end` and `app:clear-state` carried payloads from mcp-server that no definition mentioned.

  All three are fixed by the contract now describing what actually travels. The relay's 25 originating sends go through a typed `sendTo`, which also folds in the `readyState` check that was repeated at most call sites and missing at some. `Session.chromeData` is `ChromePayload` rather than `unknown`; the relay still only stores and forwards it, but a new platform now extends the union instead of the relay.

  No message changed shape on the wire. This is types only, and `@tapflowio/protocol` emits no runtime code — consumers import it with `import type`, so nothing reaches a browser bundle.

### Patch Changes

- Updated dependencies [2aebd34]
- Updated dependencies [f4235e5]
- Updated dependencies [7637be3]
- Updated dependencies [a391b85]
- Updated dependencies [273c016]
  - @tapflowio/protocol@0.18.0
  - @tapflowio/flow-runner@0.18.0

## 0.17.0

### Minor Changes

- eaa78ac: MCP input tools now report what actually happened instead of always reporting success.

  `tap`, `swipe`, `press_key` and `press_button` were fire-and-forget: the tool answered `{tapped: true}` no matter what the agent did with the input. Against a session whose device is not booted the input was dropped and still reported as success — a false positive that also makes parallel test results untrustworthy.

  Agents now acknowledge a gesture's terminal message with `input:done` or `input:error`, and the tools surface that. `done` means the agent dispatched the input to a booted device; as with the existing `input:type-done`, it is not a guarantee the app reacted.

  Additive: an agent that does not send the ack is handled as before.

### Patch Changes

- @tapflowio/flow-runner@0.17.0

## 0.16.0

### Minor Changes

- Flow-runner reliability and MCP session lifecycle.

  - **flow-runner: retry transient ui-tree query errors while polling.** Wait steps (`tapOn` / `assertVisible` / `assertNotVisible`) no longer fail the instant a query throws — e.g. the app not being in the foreground yet right after `launchApp`. The poll loop distinguishes transient failures (foreground race, idle timeout, network) from permanent ones (bad request, auth, missing session) and retries the transient ones until the step deadline, so waits are truly condition-based (no `sleep` workarounds). A stalled query is also bounded by an abort signal so it can't block past the deadline.
  - **flow-runner: `role` and `index` selector disambiguators.** The object-form selector takes two new optional fields — `role` (narrow by element kind, e.g. `{ label, role: button }` when a button and its inner text share a label) and `index` (0-based, pick the Nth remaining match, e.g. `{ role: cell, index: 2 }` for a label-less row). Additive: bare-string and `{ id }` / `{ label }` selectors are unchanged; the object form now needs at least one of `id` / `label` / `role`.
  - **mcp: `run_flow` installs the build before replaying** when `buildId` is set (parity with `tapflow flow run --build`), so `clearState` / `launchApp` find the app present; pass `install: false` to skip.
  - **mcp: `shutdown_device` tool** — powers a session's booted simulator/emulator down to free resources or force a cold boot, distinct from `disconnect_device` (which only leaves the session, keeping the device running).
  - Security: pinned `axios`, `protobufjs`, `body-parser`, and `js-yaml` past their advisories via `pnpm.overrides`.

### Patch Changes

- Updated dependencies
  - @tapflowio/flow-runner@0.16.0

## 0.15.0

### Patch Changes

- @tapflowio/flow-runner@0.15.0

## 0.14.0

### Minor Changes

- ba0a3d8: Automated QA axis: UI accessibility tree queries and the deterministic flow runner.

  - `query_ui_tree` (MCP) / `GET /api/v1/sessions/:sessionId/ui-tree` — unified element schema (`role`/`label`/`identifier`/`frame`/`enabled`), frames normalized 0-1 so a frame center feeds straight into `tap`. iOS reads the tree via a resident XCUITest runner inside the simulator — window-agnostic (no Simulator.app window required) and still no WebDriverAgent; Android via `uiautomator dump` with a device-side timeout.
  - `@tapflowio/flow-runner` (new package) + `tapflow flow run` — replay YAML flows with zero LLM calls: 10-step vocabulary, identifier/label selector resolution, condition-based waits, JUnit reports, failure screenshots, CI exit-code contract (0/1/2).
  - `run_flow` (MCP) — agents author a flow once, then replay it deterministically over the existing session.
  - New relay messages `app:clear-state` (reset app data — `pm clear` on Android, data-container wipe on iOS) and `input:type-done`/`input:type-error` (text-entry completion ack, so a following key press stays ordered). Text entry now waits for this ack: a self-hosted agent older than this release will not send it, so text steps time out — update the agent alongside the relay.
  - mcp-server and flow-runner graduate from the `experimental` dist-tag to the standard npm channel, versioned with the repo-wide fixed group.

### Patch Changes

- Updated dependencies [ba0a3d8]
  - @tapflowio/flow-runner@0.14.0

## 0.7.0
