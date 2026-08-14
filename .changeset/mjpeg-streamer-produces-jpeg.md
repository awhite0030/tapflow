---
'@tapflowio/ios-agent': patch
---

fix(ios-agent): make the MJPEG fallback actually produce JPEG

`MjpegStreamer` called `simctl.screenshot(udid)` with no format, and that argument defaults to PNG —
so the fallback streamer emitted PNG bytes while `IOSAgent` stamped `CODEC_JPEG` on every frame of
it. The class names its codec, and it was the last place still getting this wrong after #508 fixed
the same lie on the screenshot path.

No in-repo entrypoint reaches it: `intervalMs` is what selects this streamer over the IOSurface path,
and nothing but tests passes one. That is why nobody saw it.

**It is not unreachable, and this is a behaviour change for one caller.** `IOSAgent`,
`IOSAgentOptions` and `MjpegStreamer` are all public exports of this package, so a consumer that sets
`intervalMs` has been receiving PNG bytes under a JPEG stamp and will now receive JPEG. Nothing in the
browser path breaks either way — `createImageBitmap` sniffs magic bytes and decoded the PNG regardless
— which is why the fix is one argument rather than a migration.

Two sentences that described the old behaviour as correct are updated with it.
