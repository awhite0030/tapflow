---
"@tapflowio/relay": patch
---

<!-- changelog: internal — no behaviour changes; the one timing difference the refactor could have introduced was kept identical on purpose (see below) -->

The two device viewers no longer mirror the current rotation into refs, and neither file suppresses
an ESLint rule any more, so both now compile under the React Compiler.

The mirrors were a Rules of React violation rather than a style choice: `composeFrame` was handed to
`useClientRecording` and *then* the turn it reads was written into a ref the hook already held. The
recorder now takes a `setComposeFrame` setter and calls whichever composer was registered last, so a
rotation mid-recording reaches the frames through a dependency instead. Registration is a layout
effect because `requestAnimationFrame` fires before paint, which is the timing the old mirrors had.

The unmount cleanup that puts a rotated device back upright keeps its whole body in a ref, so its
dependency list is honestly empty — the `react-hooks/exhaustive-deps` suppression it carried was
enough on its own to keep the React Compiler out of the entire file.
