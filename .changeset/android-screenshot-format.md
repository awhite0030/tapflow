---
'@tapflowio/protocol': patch
'@tapflowio/android-agent': patch
'@tapflowio/relay': patch
'@tapflowio/mcp-server': patch
---

fix: a screenshot's format is what the bytes are, not what was asked for

An Android screenshot requested as JPEG came back as **PNG bytes labelled `image/jpeg`** (#508).
`AdbWrapper.screenshot()` runs `screencap -p` and takes no format argument, so Android always produces
PNG — but the reply echoed the *requested* format, and the relay turns that field into the HTTP
`Content-Type`.

## The part that is not cosmetic

`mcp-server`'s `getImageDimensions` picks a parser **by format**. Handed PNG bytes and told they are
JPEG, it scans for a JPEG SOF0 marker; in a few hundred KB of IDAT a stray `ff c0` is close to certain,
so it returned a **wrong** width and height. Those numbers go into the response text the LLM reads and
hands back as `tap`'s `screenshotWidth` / `screenshotHeight`, which are its divisors — so the tap lands
somewhere else on the screen. The usual reassurance that decoders sniff magic bytes and render anyway
does not apply here: this format is not deciding how to render, it is deciding how to measure.

## What changed, and what each edit is worth on its own

- **`protocol`** now says what the request's `format` means: a **preference**, not a requirement. That
  asymmetry is the platform contract rather than slack — `DeviceAgent.screenshot()` takes no format
  argument, so no agent was ever asked to honour it. iOS happens to (`simctl io … --type`), Android
  cannot, and a third-party platform registered through `AgentRegistry` is free to produce whatever it
  can. Only `ScreenshotDone.format` describes an outcome, and even that is a claim.
- **`android-agent`** answers `format: 'png'` unconditionally, because that is what it produced. On its
  own this fixes **no in-repo consumer** — it makes the HTTP `Content-Type` honest for anything reading
  the REST endpoint directly, and makes protocol's declaration true.
- **`mcp-server`** reads the magic bytes instead of the request. This is the edit users feel, and it
  works against an agent that has **not** been upgraded — agents are separate processes on separate
  release lines and this protocol has no version handshake, so a self-hosted install running an older
  Mac agent is the ordinary case, not an edge one. When the format differs from what was asked for, the
  response says so; when the bytes match neither signature it falls back to the request and says that
  too, rather than presenting a guess as a reading.
- **`relay`** logs a mismatch between the bytes and the agent's claim, and **does not overwrite it**.
  Correcting the field there would make the relay the authority on something only the agent can know,
  which is a contract change where this is a drift detector. It costs four bytes of a buffer the relay
  had already decoded. Without it the consumer-side sniff would hide a lying agent forever — #508 was
  found by a person noticing, and nothing reported it.

The MCP `screenshot` tool keeps its `format` parameter: dropping it is a change to a published tool
schema, and it is a working feature on iOS. Its description and the docs now name the platform
difference.

Not addressed: `relay/src/types.ts` keeps its own `format?: 'png' | 'jpeg'` while protocol declares it
required — the drift that package exists to remove, and a separate slice.
