---
'@tapflowio/relay': patch
---

The App Center remembers which releases you opened or closed, per app and per browser. A release you never touched follows the default, where the newest is open, so a version uploaded since your last visit arrives open, and one you collapsed stays collapsed.

With a status filter on, changing a build to a status the filter hides no longer drops focus to the top of the page. Focus moves to the next build in the release, or the previous one, or the neighbouring release's header, and that control says why the build disappeared. After a retry the first release is announced open from the start instead of collapsed and then expanded. Release headers are headings, so a screen reader can move between releases. Scheduling and cancelling a deletion now say so. Every control on a build row names the build it acts on, and the deletion icons show what they do on keyboard focus as well as on hover.
