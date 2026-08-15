---
'@tapflowio/protocol': minor
---

fix(protocol)!: invert `input:error` — `reason` is required, `message` is optional

**This is a breaking wire-contract change**, shipped as `minor` because the package is pre-1.0 and
CONTRIBUTING says breaking changes may land in a minor until `v1.0.0` is tagged.

`input:error` declared `message: string` required and `reason?: InputErrorReason` optional. The
package's own AGENTS.md states that split on purpose — `message` is free prose each agent owns,
`reason` is the closed union consumers branch on — so the field a consumer was **guaranteed** to
receive was the one it must not depend on, and the one it should depend on could be absent. Every
consumer carried an unknown-reason branch for as long as that held, and "absence means unknown" had to
be re-derived by each new one.

That was the right way to *ship* it in #490: an agent predating the field omitted it and nothing broke.
It was never a correct end state, and the prerequisite closed with #492 — the relay used to be the one
producer sending prose alone.

## What it costs

**No producer had to change.** All six production sites already send a reason, two of them with
`satisfies InputErrorReason` on the literal. The clients that read it through
`Record<string, unknown>` are unaffected by the declaration — but the dashboard is a *typed* consumer
and did need editing: `message` becoming optional meant it rendered `(undefined)` into a toast, which
is fixed here with a test on it.

**What it buys** is an agent outside this repo, which can no longer omit the field, and a consumer
written tomorrow, which cannot be handed a failure it has no way to branch on. Both absence branches
stay, and now say why beside themselves: they exist for producers predating the field, which a required
declaration corrects going forward and cannot retroactively fix.

`message` is optional rather than removed — it still carries parameterised detail a closed union
cannot (`unknown key code: KeyFoo`), which is a debug and forward-compatibility field. A structured
`params` is the honest way to keep that once prose is demoted and is deliberately **not** added here:
issue #485 is what will say whether a rendered UI misses the variable.

`InputTypeError` keeps `reason?`, and that asymmetry is deliberate. Its agent-side producers answer
with prose from a rejected `adb` or pasteboard write and have no reason to give; only the relay sets one.

## `SessionError` is now `SessionScoped`, and carries only `sessionId`

TypeScript cannot narrow an inherited required member to optional, so making `message` optional on one
member meant moving it off the base — onto each of the nine that keep it required. What is left is the
one thing all nine share, and the name follows the shape.

The `extends` is now the only thing stating the family relation, where the shared field pair used to
imply it. `protocolMessageNames.test.mjs` gains an assertion that each member still declares `message`
for that reason.
