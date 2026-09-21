---
'@tapflowio/relay': patch
---

Switching apps in the App Center no longer flashes "No builds yet" on the way. The page cleared the list the moment you clicked, before it had asked the server anything, so for one frame an app nobody had fetched yet looked like an app with nothing in it — and what you saw on a single click was the list, then that message, then "Loading…", then the new list.

The list you were looking at now stays on screen until the new one arrives, with the release you had open still open.

Two things the same page got wrong for the same reason are fixed with it. A slow answer for one app could paint its builds under a different app you had since selected. And a failed request was shown as "No builds yet", so a relay you could not reach and an app with no builds looked identical; a failure now says so.
