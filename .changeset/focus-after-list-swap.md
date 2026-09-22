---
'@tapflowio/relay': patch
---

When the App Center's build list is replaced — by its failure state, by its empty state, or by the list again after a retry — focus moves to the first control in what replaced it, or to the search box when there is none, instead of falling to the top of the page. It moves only when replacing the view is what removed it. Wherever focus lands says what happened. A failed search fetched again in the background keeps its failure on screen with "Trying…" until the answer arrives, and "Trying…" keeps focus while it runs. Closing a build's "Schedule deletion" dialog returns focus to the button that opened it, and each release header says whether it is open.
