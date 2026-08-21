---
"@tapflowio/relay": patch
---

**Take the device off the network from the browser.** The control that #607 asked for is on screen.

A button in the simulator toolbar puts an Android emulator into airplane mode and takes it back out, so the offline banner, the failed retry and the stale cached screen can be seen without touching a terminal. It appears only for an agent that says it can do this, which today means Android — iOS follows, and will need no dashboard change when it lands.

It has four positions rather than two, and that is deliberate. A device nobody has heard from yet and one whose report never came are drawn differently from each other and from both on and off — because saying "on the network" about a device nobody has heard from is exactly the mistake this feature exists to catch. Neither is disabled: clicking is what asks the device, so a session with no report has a way out rather than a dead end.

A device tapflow can no longer steer still shows where it is. That is a separate thing from not knowing, and the button says which of the two it is.

The toggle never moves on the click. It moves when the device answers, so what is on screen is where the device is rather than where someone asked it to go.
