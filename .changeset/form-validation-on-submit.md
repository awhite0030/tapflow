---
'@tapflowio/relay': patch
---

Form fields no longer report an error when you leave them without typing. Every form in the dashboard validated on blur regardless of whether anything had been entered, so leaving a field you had not touched showed `Enter a valid email` or `Password must be at least 8 characters` before you had done anything. Opening a dialog was enough on its own: it focuses its first control, so the next pointer move anywhere else triggered the message.

In a dialog it also cost the first click on Close. The message enters the layout, everything below it moves, and a `click` needs its press and release on the same element, so the press that dismissed the dialog landed on nothing and it took a second one.

Validation now runs when the form is submitted, and from then on corrects as you type. A message also names its field now, and the field points back at it, so it is read out with the field rather than left on screen for someone who cannot see it. Eight fields used to report the validation library's own developer text — "Too small: expected string to have >=8 characters" — and now say what they mean. This covers sign-in, first-run setup, the invitation and password-reset pages, and the team, token and settings forms, and the App Center's add-app dialog gained the announcement the others have.
