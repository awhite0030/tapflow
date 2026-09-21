---
"@tapflowio/relay": patch
---

<!-- changelog: internal — no behaviour changes; the one timing difference the refactor could have introduced was kept identical on purpose (see below) -->

Neither device viewer compiled under the React Compiler. Both do now, and the two halves of the
reason were in different places.

`AndroidViewer` mirrored the current rotation into refs so `composeFrame` could read it without
being rebuilt — a Rules of React violation rather than a style choice, because the closure was
handed to `useClientRecording` and *then* the turn it reads was written into a ref the hook already
held. The recorder now takes a `setComposeFrame` setter and calls whichever composer was registered
last, so the turn is an ordinary dependency again. Registration is a layout effect because
`requestAnimationFrame` fires before paint, which is the timing the mirrors had. `IOSViewer` takes
the same setter, but its composer reads what it needs live on every draw, so it registers once.

The unmount cleanup that puts a rotated device back upright keeps its whole body in a ref, so its
dependency list is honestly empty — the `react-hooks/exhaustive-deps` suppression it carried was
enough on its own to keep the React Compiler out of the entire file.
