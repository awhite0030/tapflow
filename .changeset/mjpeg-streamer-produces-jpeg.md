---
'@tapflowio/ios-agent': patch
---

fix(ios-agent): make the MJPEG fallback actually produce JPEG

`MjpegStreamer` called `simctl.screenshot(udid)` with no format, and that argument defaults to PNG —
so the fallback streamer emitted PNG bytes while `IOSAgent` stamped `CODEC_JPEG` on every frame of
it. The class names its codec, and it was the last place still getting this wrong after #508 fixed
the same lie on the screenshot path.

Unreachable in production today: only tests pass `intervalMs`, which is what selects this streamer
over the IOSurface path. That is why nobody saw it, and it is also why the fix is one argument rather
than a migration — the browser would have been sniffing magic bytes to decode these frames if the
path were live.

Two sentences that described the old behaviour as correct are updated with it.
