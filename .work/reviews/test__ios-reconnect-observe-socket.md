The issue asks for an investigation into why replacing a polling loop with an observation of `internals(agent).ws` reaching `OPEN` within 25 seconds failed locally during the fix for the flaky reconnect test (#538).

The issue questions whether:
1. the reconnect path assigns it somewhere the observation cannot see
2. it assigns it later than `connect()` resolving suggests
3. the `internals` accessor does not see the instance the reconnect produced

My investigation reveals that **none of these are the case**. The reason `vi.waitFor(() => expect(internals(agent).ws!.readyState).toBe(WebSocket.OPEN))` failed is because `internals(agent).ws` is `null` until the socket receives the `agent:registered` message. A reconnect is implemented by `_scheduleReconnect` which calls `connect()`. In `connect()`, the new websocket instance is NOT immediately assigned to `this.ws`. Instead:

```ts
        if (msg.type === 'agent:registered') {
          registered = true
          clearTimeout(timer)
          this.ws = ws
          // ...
```

So `internals(agent).ws` is strictly `null` while the agent is connecting. If we assert `internals(agent).ws!.readyState` before registration completes, we try to read properties of `null` (`TypeError`), which `vi.waitFor` swallows and retries until the timeout.

Furthermore, when the test replaced polling (which explicitly sends `session:start` repeatedly) with just waiting for the websocket to open, it dropped the mechanism that tells the new websocket it wants to join the session. The agent reconnects to the relay, but the *client's websocket (`rejoined`)* needs to re-join the session! The test previously did this in a loop:
```ts
      for (let i = 0; i < 60 && joined === null; i++) {
        rejoined.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        joined = await waitForTypeOrNull(rejoined, 'session:joined', 250)
      }
```
If we replace this loop with just waiting for `agent.ws` to be open, we still need to send `session:start` and wait for `session:joined`.

I've tested this hypothesis by successfully replacing the polling loop with:
```ts
      await vi.waitFor(() => {
        expect(internals(agent).ws).not.toBeNull()
        expect(internals(agent).ws!.readyState).toBe(WebSocket.OPEN)
      }, { timeout: 25000 })
      rejoined.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(rejoined, 'session:joined')
```
This confirms that the original polling was doing two things: waiting for the agent to reconnect (by retrying), and re-joining the session. When the polling was replaced with an observation on the websocket, the test failed because 1) `internals(agent).ws!` threw an error when `ws` was null, causing `vi.waitFor` to time out, and 2) the client never sent `session:start` to join the session.
