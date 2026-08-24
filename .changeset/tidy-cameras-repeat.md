---
"@tapflowio/protocol": minor
"@tapflowio/agent-core": minor
"@tapflowio/ios-agent": minor
"@tapflowio/relay": patch
---

Stop drawing a working network control as a dead one (#607).

`NetworkUnavailableReason` gains `awaiting-app`, for a device whose injection is in place and which
no app has run under yet. That is not an edge case on iOS — the library is delivered when the device
boots but can only name its target when an app is launched, so **it is the state every session is in
until its app starts**, and it is the first thing a tester meets.

It had been reported as `not-armed`, and that value means something else: nothing was delivered, and
the remedy it prescribes is a reboot. Rebooting does not help here, and neither does the sentence the
dashboard drew from it — *"tapflow can no longer change it"* was wrong twice over. Nothing had been
armed, so there was no "no longer"; and clicking the control **does** change the device, because
traffic-level control works in this state. What does not work is telling the app, which is the half
that needed saying.

So the control now says what is missing — *"Launch an app through tapflow so it is told too"* — and
is drawn as what it is: actionable. It keeps its plain action name rather than the `Retry:` prefix,
which claims a previous attempt that never happened, and a device taken offline here stays amber,
because it really is offline.

**A control tapflow cannot currently steer is drawn as unusable wherever the device is pointing**,
where before it was drawn that way only at `online` and left washed out at `offline` — the same faint
rendering that reads as disabled on a button that still works, in another hue. A device whose state
has not been read yet is untouched by this and stays muted: it has had no attempt, so drawing one as
a failure claims something that never happened, in the opening seconds of every session.

That colour says the control is unusable **now**, and deliberately not that the device will never do
it. The dashboard reads this one member and still ignores the rest of the set, for the reason
recorded where it ignores them: every Android read failure currently arrives as `unsupported-device`,
so a rebooting device and a permanently incapable one are indistinguishable here, and nothing the
dashboard draws may tell those apart. `awaiting-app` is not in that set — an agent emits it only
about a fact it knows — which is what makes it safe to read alone.
