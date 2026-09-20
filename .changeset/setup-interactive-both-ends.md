---
"tapflow": patch
---

`tapflow setup` no longer ends at exit 0 with nothing after the question when stdin is empty. Every prompt in setup decided whether it could ask by reading `stdout` alone, so a run whose output is a terminal but whose input is not — `tapflow setup ios </dev/null`, or a wrapper that leaves stdin closed — drew the prompt and waited on a promise that never settles. The process then left the event loop and exited **0**: no results list, no `SETUP INCOMPLETE` banner, and every step after the one that asked never ran. A Mac that is already set up reached it at the audio-permission step, which is offered on every macOS 14.2+ run, so the network filter install behind it was silently skipped.

A session now counts as interactive only when both ends are a terminal, decided in one place that the setup steps, `tapflow init`, `tapflow admin init` and the network filter's approval all read. `tapflow admin init` had the same unguarded prompts and is the command self-hosting points headless servers at, so a provisioning script got exit 0 and no admin account; it now says a terminal is required and exits 1.

Two consequences worth knowing. Answers piped into stdin — `yes | tapflow setup android` — no longer reach the prompts, and the steps print what to run instead. That idiom was never whole: measured over three questions, clack answers the first from the pipe and then never settles again, so the run died the same silent death one step later. And a pty on both ends with nobody holding the other end (`ssh -tt host 'tapflow setup ios' </dev/null`, `docker run -t` without `-i`) reads as a terminal on both descriptors, so it is unchanged: no test of the file descriptors separates it from a person who has not typed yet.
