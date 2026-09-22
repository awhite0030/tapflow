---
'tapflow': minor
'@tapflowio/relay': minor
---

**tapflow keeps one install per machine, in `~/.tapflow`.** `tapflow init` writes the configuration there instead of the directory you happened to be standing in, and every command finds the same install: `TAPFLOW_HOME` when it is set, the current directory when it already is an install, and `~/.tapflow` otherwise. `tapflow start` and `tapflow relay start` print the install directory, the configuration file and the data directory they resolved. Existing installs keep running where they are, and nothing moves.

`init` also writes an `AGENTS.md` — a tapflow section between `<!-- tapflow:begin -->` markers, leaving anything you wrote outside them alone — and, when the directory is tapflow's own, a `CLAUDE.md` containing `@AGENTS.md`. A coding agent opened in the install directory then answers tapflow questions from the documentation, with the configuration and `tapflow doctor` in reach. Running `init` again keeps the configuration and refreshes only that section.

Every CLI command used to leave a `jwt-secret` file in whatever directory it ran in, including `tapflow --version`: the relay created it when its configuration module loaded, and the CLI loads every command at startup. The relay creates it when it starts now.
