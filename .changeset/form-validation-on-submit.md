---
'@tapflowio/relay': patch
---

Form fields no longer report an error when you leave them without typing. Every form in the dashboard validated on blur regardless of whether anything had been entered, and the first field is focused when the page or dialog opens — so moving the pointer anywhere else answered with `Enter a valid email` or `Password must be at least 8 characters` before the person had done anything.

In a dialog it also cost the first click on Close. The message enters the layout, everything below it moves, and a `click` needs its press and release on the same element, so the press that dismissed the dialog landed on nothing and it took a second one.

Validation now runs when the form is submitted, and from then on corrects as you type. A validation message also names its field now, and the field points back at it: submit is the moment focus moves to the first invalid input, and focus alone announces the field's name and nothing about what is wrong with it. This covers sign-in, first-run setup, the invitation and password-reset pages, and the team, token and settings forms.
