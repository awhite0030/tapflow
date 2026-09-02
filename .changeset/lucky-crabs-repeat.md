---
'tapflow': minor
---

**Replacing the iOS network filter no longer takes the Mac's network down with it.** The filter is a
content filter, so every new connection on the Mac waits for the provider to decide, not only the
simulator's. `migrate net-filter` replaced the extension while that configuration stayed switched on,
which killed the process that decides and left new connections waiting for an answer nobody would
give. Measured on 2026-09-02: the Mac's own traffic timed out and a restart was the only way back.
Already-open connections kept working, so the visible symptom was a dead browser next to things that
carried on.

The replace now switches the filter off first and `--install` turns it back on. The window that
remains was measured across ~300 probes: about four seconds of raised latency, no failures, because
the kernel passes traffic for a provider that has not applied its settings yet. On a Mac carrying a
hand-built filter older than any release the disable is skipped rather than attempted — a build
predating the flag does not refuse it, it falls through to writing `isEnabled = true` — and the
command says so.

**It also refuses while devices are in use.** Booted simulators, attached emulators and a relay
serving on `:4000` all count, because the filter is host-wide and the person affected is not
necessarily the person at the keyboard. `--ignore-running-devices` replaces it anyway;
`tapflow migrate data-dir` rejects that flag rather than ignoring it. The gate sits in the shared
install routine, so `tapflow setup ios` is covered too.

**And a filter that was switched off is no longer reported as up to date.** `systemextensionsctl`
describes the system extension, not `NEFilterManager.isEnabled`, so a Mac interrupted between the
disable and the install had the right app, the right activated extension, no filter, and `doctor ios`
all green — with the only thing that would restore it being the run that had just declined to do
anything. Being current now means enforcing as well as matching.
