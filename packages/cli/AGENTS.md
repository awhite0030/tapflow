---
type: rules
topics: [cli, ux]
status: living
---

# cli — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

`tapflow` CLI: handles local dev environment checks and simulator / relay / agent startup.
Commands are registered in `src/index.ts`; user-facing reference: [`docs/reference/cli.md`](../../docs/reference/cli.md). Non-obvious contracts:

- `init` never touches the relay; it scaffolds config and auto-adds the `.tapflow/` runtime dirs to `.gitignore`. `admin init` is the CLI fallback for headless servers (web `/setup` is the default path).
- `agent start --token` (or `TAPFLOW_AGENT_TOKEN`) carries an `agent`-scope PAT, required when the relay is on a different machine; flag wins over env.
- `flow run` exit codes: `0` passed · `1` flow failed · `2` env/config error. Always sends `device:boot` (idempotent — it initializes the agent's touch/stream state). `--token` needs a `view`-scope PAT; REST (`/ui-tree`, `/screenshot`) requires auth even on localhost.
- `migrate data-dir` moves a legacy `.tapflow-data/` into the unified `.tapflow/data/` (atomic rename), repoints `local.dataDir` in `tapflow.config.json` when it pinned the old default, and updates `.gitignore`. Idempotent; the relay itself never moves data (read-only fallback only).

### Command Design Principles

Each command has exactly one responsibility. `tapflow start` is for local development only and does not accept a `--relay` option.
"Connect to a relay" and "start a relay" are separate commands (`agent start` / `relay start`).
"Scaffold config" and "create the admin account" are separate commands (`init` / `admin init`) — `init` never touches the relay or creates accounts.
`doctor` diagnoses prerequisites; `setup` installs/fixes them. Both take an optional `[platform]` (`ios` | `android`) and mirror each other; device booting is left to the relay (on-demand on QA Session join), so `setup` only ensures a bootable device/AVD exists.

## HOW

- UX standard: one-line input → progress feedback → result message. Use spinners and banners for visual feedback (`print.ts`: `banner`, `step`, `warn`, `createSpinner`). Interactive prompts use `@clack/prompts`.
- `tapflow.config.json` lives in the working directory (created by `tapflow init`); runtime data goes in `.tapflow/data/`. Downloaded tunnel binaries are cached in `~/.tapflow/bin`.
- Package dependencies: `@tapflowio/agent-core`, `@tapflowio/ios-agent`, `@tapflowio/android-agent`, `@tapflowio/relay`. Import as libraries — do not reimplement.

## HOW NOT

- Do not add commands that access external systems (cloud, remote infrastructure) — this is a local tool.
- Only `reset` tears down running state (shutting down simulators/emulators). `setup` may install/configure the local environment (Homebrew packages, JDK, Android SDK, shell rc) but only after explicit consent and only in interactive (TTY) sessions — non-interactive runs print guidance instead. No command deletes user data.
