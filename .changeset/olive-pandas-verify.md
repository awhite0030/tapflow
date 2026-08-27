---
"@tapflowio/ios-agent": minor
"tapflow": minor
---

Check the hook's symbols before use, and stop telling a tester to launch an app they already launched

Two halves of the same failure. Before a launch: `doctor ios` now reads the iPhoneSimulator SDK's
export stubs and warns if this Xcode no longer provides a symbol the injected library rebinds — the
install is all-or-none, so one missing symbol takes iOS network control down, and a tester would find
out by launching an app and reading a dead control. Reading only: no simulator is booted, installed to
or launched into.

After a launch: a library that is present and armed but never loaded by dyld writes no verdict, and
that was reported as `awaiting-app` — "launch an app through tapflow", to someone who had, for the life
of the session. It is now reported as what it is once a launch has had time to produce a verdict. The
window is derived from the library rather than picked: its verdict is written from a constructor, but
that constructor waits up to three seconds inside its own self-check first.
