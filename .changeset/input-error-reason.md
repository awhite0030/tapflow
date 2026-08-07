---
'@tapflowio/protocol': patch
'@tapflowio/ios-agent': patch
'@tapflowio/android-agent': patch
'@tapflowio/mcp-server': patch
---

feat(protocol): give `input:error` a machine-readable `reason`, so a caller can tell "retry" from "reconnect" from "never"

`input:error` carried a human-readable `message` and nothing else, so three different situations
arrived looking identical: an input that would land if retried in 200ms, one that needs a reconnect,
and one that will never work. With nothing to switch on, a caller could only give up or blindly retry.
(This is not the same gap as `mcp-server`'s optimistic timeout fallback, which fires when no ack
arrives at all — that is #457.)

`InputErrorReason` is a closed string-literal union in `@tapflowio/protocol`, and the set comes from
**what a consumer must do differently** rather than from how many internal states an agent has. iOS
has one input path; Android has three. Each agent maps its own states onto the smaller set, so the
wire contract stays the same size while the platforms stay different.

- **`channel-starting` is the reason that had no name.** iOS's input helper needs a measured
  186–247ms after spawn before an injected frame reaches the device, and `device:ready` can arrive
  inside that window — so a caller tapping as soon as a boot returned was told the channel was gone
  when it was merely coming up. It now says so, and says to retry.
- **A refusal from a healthy channel is no longer reported as a dead one.** iOS's gesture-ownership
  guard answers `no-gesture`, which carries its own advice: the message was well-formed and the
  channel may be fine, but *this* frame can never land, so the caller opens a new gesture rather than
  retrying or giving up. Ownership is checked before readiness, because a gesture whose opening frame
  was refused inside the start-up window owns nothing — reading readiness first told that caller
  "never retry" for the very case `channel-starting` exists to serve.
- **`message` stays free prose.** That is what lets iOS keep `unknown key code: KeyFoo` while adding
  `reason: 'unsupported'` — the machine field is separate, so parameterised wording survives.
- `mcp-server` includes the reason in the error it raises. Acting on it — retrying `channel-starting`
  rather than failing, and dropping the optimistic fallback for reasons that say never retry — is
  separate work.

The field is **optional**, so an agent that predates it omits it and nothing breaks; absence means
*unknown*, never *fine*, and a consumer meeting an unfamiliar reason must treat it as
`channel-unavailable`. Making it required would be the breaking step and is not taken here. There is
deliberately no shared message table: one would be a runtime value, and the protocol entry point has
to erase under `import type` so it never reaches the dashboard bundle.
