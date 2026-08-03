---
type: rules
topics: [meta, contributing, conventions]
status: living
---

# tapflow — AGENTS.md (Common Rules)

> Package-specific rules are referenced via [INDEX.md](./INDEX.md).

---

## WHAT

tapflow is an **open-source self-hosted library** that lets the entire team — PO, PM, designers, backend engineers, and QA — test iOS/Android apps directly from a browser.
It uses the Mac you already own — no external cloud dependency.

### Core value

Remove friction. Anyone on the team can open a browser and test the app on a real simulator, without Xcode, without device setup, without accounts on external services.

### Two testing modes

- **Manual testing** (primary): CI uploads a build → team reviews in the browser. This is tapflow's main use case.
- **AI Agent via MCP** (experimental): An LLM agent controls the simulator automatically using `@tapflowio/mcp-server`. This is a separate, opt-in feature — it does not affect the manual testing path.

When designing features or writing docs, default to the manual testing perspective. The AI Agent path is additive, not a replacement.

## WHY

- Appetize / BrowserStack are expensive and send app data outside your network.
- Reuses infrastructure (Mac) the team already owns.
- Fully open-source and customizable.

For the product direction and philosophy behind these — Manual First, Flow Capture as the moat, AI as an additive harness — see [VISION.md](./VISION.md).

---

## Core Principles

- **Evidence-based**: verify a root cause with code, logs, or tests before fixing — no guess-driven changes.
- **Minimal changes**: stay within the requested scope; follow the file's existing conventions.
- **Verifiable goal**: know how success will be measured before starting (a reproducing test, same tests passing after a refactor, etc.).
- **Stop before risky actions** — get user confirmation before any hard-to-reverse operation (`git push --force`, `git reset --hard`, sending messages to external systems, DB drops, etc.). Specifically:
  - Only create commits or PRs when the user explicitly requests it.
  - **Do not merge PRs.** Always leave merging to the user — even with `--admin`. Create the PR and stop.
  - **Avoid breaking changes.** If unavoidable, report to the user and get approval before proceeding. Breaking change scope: public API / interface signature changes, DB schema changes, WebSocket message protocol changes, CLI command / flag changes.

---

## HOW

### Language & Stack
- TypeScript throughout. No `any`. Node.js ≥ 20. Everything else is in each package's `package.json`.

### Branches, Commits & Releases
→ [CONTRIBUTING.md](./CONTRIBUTING.md)

Write GitHub PR and issue titles/bodies in **English**, and write new code comments in **English** too. (Conversation and docs follow the existing KO/EN rules.) Code comments default to English so contributors of any language can read and extend them — existing Korean comments stay until the line they sit on is changed.

When starting a **new** task that requires code changes (not when continuing work on an existing branch):
1. `git checkout main && git pull origin main` — start from the latest main.
2. `git checkout -b <branch-name>` — work on a new branch, never directly on main.

### Workflow (Plan → Work → Review → Compound)

Work logs go in `.work/`. Conventions: [.work/CLAUDE.md](./.work/CLAUDE.md).

1. **Plan** — define requirements + test cases first (`type: plan`).
2. **Work** — write tests first, implement until they pass.
3. **Review** — edge cases + real data validation → **adversarial review** (below) → PR (`type: review`).
4. **Compound** — extract repeating patterns into test + code + prompt bundles (`type: compound`).

Custom commands: `/work-plan {topic}` · `/deep-research {problem}` · `/qa {target}` · `/doc-sync` · `/compound` · `/promote-decision {topic}` · `/release {major|minor|patch}`.

### Adversarial Review (required before every code-change PR)

The authoring session inherits its own assumptions, so before creating a PR the diff must be refuted by an **independent context** that has NOT seen the working conversation. Docs-only PRs may skip the review itself, but still write the record (with the skip reason) — the gate always requires it.

- **Record**: findings + dispositions (fixed, or skipped with a reason) go in `.work/reviews/<branch>.md` (slashes → `__`), including the **full 40-character HEAD hash** (`git rev-parse HEAD` — an abbreviated hash will not pass the gate). Mention the review in the PR body.
- **Enforcement**: the PreToolUse hook `.claude/hooks/adversarial-review-gate.sh` blocks PR creation unless that record exists and references the current HEAD — any commit after the review invalidates the record until it is refreshed against the new diff.
- **A change spanning two or more packages, or both platforms, needs a second, earlier review — of the design, before the code.** One adversarial pass over the plan, in addition to the pre-PR one.

**Read [contributing/adversarial-review.md](./contributing/adversarial-review.md) before launching a reviewer.** It covers how to design the channels, how to run the cross-cutting design pass, and how to keep the cost in minutes rather than hours — the same review can take 4 minutes or 106 depending only on what its prompt makes it execute.

### Design Principles (SOLID — priority subset)

- **OCP**: New platforms and features are added without modifying existing code — platforms register via `AgentRegistry.register()` only; relay and dashboard code stay unchanged.
- **ISP**: `DeviceAgent` only contains methods every platform can implement. Platform-specific behavior goes in separate interfaces.
- **DIP**: Dependencies via constructor injection. Depend on interfaces, not implementations.

### Code Rules
- Comments only when the WHY is non-obvious. Write new comments in English; leave existing Korean comments unless you're already editing that line.
- When changing an interface, update `agent-core` first, then align implementations.

### Test Hygiene
After running tests (especially repeated or looped runs), always check for zombie vitest processes and kill them:
```bash
ps aux | grep vitest | grep -v grep
pkill -f "vitest"
```
Zombie worker processes accumulate silently from `pnpm test` loops and consume memory. Kill them before starting new test runs.

### Dev Server Hygiene
Same rule, different processes. **Anything you start with `pnpm dev` you stop before the session ends:**
```bash
pnpm dev:down          # stops relay / agents / vite for THIS checkout
```
`pnpm dev` refuses to start when :4000 or :3001 is already held, and names the pid — because the failure it produces otherwise mentions neither. A relay left running once survived a day and cost a debugging session: it failed with `EADDRINUSE`, `concurrently` SIGTERMed the dashboard and both agents, and the visible symptom was four processes dying for no stated reason.

`concurrently -k` cleans up on a normal exit, not when the terminal goes away or the machine sleeps.

### Changesets
A PR that changes published source needs a changeset. The CI `changeset` job fails without one — it only *blocks* a merge once it is a required status check on the `protect-main` ruleset, which it is not yet. Opt out only by writing the reason in the PR body, on its own line:
```
<!-- no-changeset: comment-only follow-up to #123 -->
```
A dashboard change names **`@tapflowio/relay`**, never `@tapflowio/dashboard`. The dashboard is `ignore`d in `.changeset/config.json` because it is private — but it is built into the relay's `public/` and ships inside that package, so that is where its release note belongs. Naming both in one changeset is rejected outright by `changeset version`, and nothing catches it until release day: the CI gate only checks that a changeset exists.

`pnpm changeset:check` runs the same check locally, against committed work. A changeset written for an EARLIER PR must say so — `Backfills: #413` on its own line — or the audit keeps reporting that merge for the rest of the cycle. That gate cannot see anything already on main, so `/release` audits the merges too (`pnpm changeset:audit`) — four merged PRs once got as far as release preparation with no changelog entry between them, and only the audit would have caught it.

---

## HOW NOT

- Do not write code that sends app data or streams to external services.
- Do not proactively add features not on the roadmap.
