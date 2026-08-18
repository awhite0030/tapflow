---
'@tapflowio/relay': minor
'@tapflowio/mcp-server': patch
'@tapflowio/flow-runner': patch
---

A session belongs to whoever opened it, not to one of their connections

Two defects met on the same two lines, and both came from the relay answering "who holds this session?"
with a socket.

What a user can observe:

- **Nobody else can power off a device you are using.** Any signed-in client that knew a session id could
  shut down a colleague's simulator mid-test. The check that stops it could not be added before, because
  the browser tab that holds a session and the one that sends the shutdown when you navigate away are
  different connections — so refusing "not the holder" would have refused the tab's own cleanup and left
  devices running.
- **A Wi-Fi blip no longer costs you your session.** The relay treated a connection as present until TCP
  or a heartbeat noticed otherwise, up to a minute after a laptop went to sleep. Returning within that
  window meant being told the device was in use — by yourself. The tab is now recognised as the same tab, and the
  session is simply resumed — unless you reload while the connection is down, which gives the page a new
  identity even though it is the same tab, and waits out the window.
- **A device whose tester's connection died frees up in at most 45 seconds** rather than up to a minute,
  and no longer appears free while it is still in use. (A tester who leaves a tab open is a different
  case — that is the idle timer's, not this.) Both questions — "can I take this?" and the "In use" badge — now read the same signal, and
  that signal is when the holder last answered rather than a flag that read every healthy connection as
  gone for the length of a round trip.

The relay reads an optional `client` parameter on the WebSocket handshake and pairs it with the signed-in
user, so a leaked identifier is useless to anyone else's account. A connection that sends none is given one
of its own, which is per-connection ownership — what it had before. The shutdown check is then relaxed for
that session, because every one of such a client's connections is a stranger to the others and gating them
would refuse the client's own cleanup — **but only for the same signed-in user**, so an older build never
becomes a way to power off someone else's device. Whether an identity was claimed or granted is recorded by
the relay, not read back out of the identifier, which the caller supplies.

The dashboard sends one value per open page. Deliberately not stored: browsers copy that storage into a tab
opened from another one, and two tabs sharing an identity would take each other's devices silently.
