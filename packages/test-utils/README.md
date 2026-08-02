# @tapflowio/test-utils

Test-only helpers shared across tapflow packages. `private: true` — never published, and nothing
in `src/` of any package may import it.

There is no build step. `main` points at TypeScript source because the only consumers are vitest
suites, which transform it themselves; adding a `dist/` would put this package into the production
build order for no reason.

## Why this exists

Socket test helpers were copy-pasted into nine files. The copies drifted, and a defect in the
shape they share — `ws.once('message')` cannot see a message that already arrived — had to be
found three separate times before it was fixed once. See #452.
