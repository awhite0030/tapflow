---
"@tapflowio/protocol": minor
"@tapflowio/relay": minor
"@tapflowio/mcp-server": minor
---

Add `@tapflowio/protocol`, one wire contract for the WebSocket messages exchanged between browser, relay and agents, and type every place that originates a message against it.

Nothing checked those messages before. The relay built them as inline object literals passed to `JSON.stringify`, the dashboard's `send()` took `object`, and mcp-server's took `Record<string, unknown>` — so the definitions each package kept were descriptions, not contracts, and three of them had already drifted from the wire:

- `stream:request-idr` was sent by the relay from two places while absent from its own `MessageType`.
- `input:key` was documented as `payload: { key: string }`. Every sender and both agents use `{ code, modifiers }`, with `modifiers` a HID bitmap — so the field name and the type were both wrong.
- `input:touch:end` and `app:clear-state` carried payloads from mcp-server that no definition mentioned.

All three are fixed by the contract now describing what actually travels. The relay's 25 originating sends go through a typed `sendTo`, which also folds in the `readyState` check that was repeated at most call sites and missing at some. `Session.chromeData` is `ChromePayload` rather than `unknown`; the relay still only stores and forwards it, but a new platform now extends the union instead of the relay.

No message changed shape on the wire. This is types only, and `@tapflowio/protocol` emits no runtime code — consumers import it with `import type`, so nothing reaches a browser bundle.
