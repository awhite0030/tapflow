# @tapflowio/protocol

The wire contract for [tapflow](https://github.com/jo-duchan/tapflow)'s WebSocket traffic — the message types exchanged between the browser, the relay, and the device agents.

**Types only.** Nothing in this package emits runtime code, so importing it with `import type` leaves no trace in a bundle.

```ts
import type { RelayToBrowser, BrowserToRelay } from '@tapflowio/protocol'
```

It exists so the relay, the dashboard and the MCP server cannot drift apart on what a message looks like. It is published because `@tapflowio/relay` and `@tapflowio/mcp-server` depend on it; most users will never import it directly.

The binary frame envelope is a separate format and is not described here.

## License

MIT
