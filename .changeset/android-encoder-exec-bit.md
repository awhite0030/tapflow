---
"@tapflowio/android-agent": patch
---

Fix missing Android audio, and the emulator's sound playing out of the agent Mac instead.

On a fresh install the bundled `emulator-encoder` binary lost its executable bit, so spawning it failed and the agent fell back from the emulator's gRPC backend to scrcpy. Audio capture and the host-mute tap only exist on the gRPC path, so that fallback silently took both: the dashboard got no audio, and the Mac running the agent played the emulator's audio out loud.

Only visible with the dashboard and the agent on separate Macs — on one Mac the local playback masked it. The agent now restores the bit just before spawning the encoder, so it self-heals however the bit was lost, and an install step sets it explicitly as well.
