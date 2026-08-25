---
"@tapflowio/ios-agent": patch
---

Stop a status-bar failure from failing a network toggle that worked, and stop a truncated verdict from claiming the app's hooks were proved broken.

Layer 3 only reports, so its failure is now swallowed in both directions — unswallowed, one `status_bar` failure threw out of `setOffline` with the two layers that do the work already applied, telling the caller a request failed on a device that really was offline. Coming back it errs the other way and the next successful toggle writes the bar again.

A verdict file caught mid-write resolved to `hooks-not-installed`, which means the library ran and proved its hooks did not take. A truncated file shows nothing of the sort — the library writes it non-atomically — so it now resolves to `state-unconfirmed`, whose remedy is to look again, which is what actually resolves it. Deliberately not `awaiting-app`, which would hand a healthy-looking control to a device nobody can vouch for, and deliberately not `not-armed`, which would tell a tester to reboot a simulator mid-session for a condition that had already cleared.

`hooks-not-installed` is now reserved for the one shape that says so. It was answered for every file that was not the library's success signal — `{}`, a bare number, an empty file — each of which supports no verdict at all.
