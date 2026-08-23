---
"@tapflowio/ios-agent": patch
---

Three corrections to the library tapflow injects into the app under test (#635, #640, #643).

**A network banner no longer risks crashing the app it is testing.** When you take a simulator
offline, tapflow re-delivers the app's own network-path handler so the app finds out. That handler
was being called on tapflow's thread rather than the one the app asked for — which for an app that
updates its UI from that handler means doing it off the main thread. The handler now runs where its
owner said it should.

**Cutting the app's open connections says when it might have cut the wrong one.** A file descriptor
is read twice — once to check where it points, once to shut it down — and nothing stops another
thread reusing it in between. That window cannot be closed from outside the process, so it is
checked afterwards and reported instead of passing silently.

**And a branch that had never run is gone.** The injected library was reaching for an app's WebView
processes, which measurement showed it never loads into. One consequence is worth stating plainly:
in a hybrid app, the web half is **not** told it is offline. Its requests still fail — the host
filter blocks traffic for every process — but a WebView that draws its own offline banner will not
draw it.
