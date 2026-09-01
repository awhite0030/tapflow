---
'@tapflowio/relay': minor
---

**A Docker install can now create its first account.** Until now it could not, at all. The bootstrap endpoint `POST /api/v1/auth/init` only answers a local client — that check is what stops a stranger claiming a public instance between first boot and the owner setting a password — and a container is always behind its bridge gateway, so the call answered 403 from the host's own browser and from the LAN alike. The error text points at `tapflow admin init`, but the image is relay-only by design and carries no CLI to run it. `docker compose up` therefore ended at a login screen nobody could get past.

Set `TAPFLOW_ADMIN_EMAIL` and `TAPFLOW_ADMIN_PASSWORD` and the relay creates that first Admin while it boots, before it serves anything. Like every other secret it reads, these can go in `<dataDir>/.env` instead of the compose file, which keeps the password out of your shell history and inside the volume you already mount.

It runs on every boot and does nothing when an owner already exists — your account is never replaced and nothing is logged, so a long-running relay does not collect a line per restart. A password under 8 characters, or one variable without the other, warns and lets the relay start anyway: these values mean nothing to an install that already has an owner, and a typo in them should not keep a running relay down. The password is never written to the log on any path.

Nothing changes for an install that does not set them, including the 403 above, which is still the right answer for a browser reaching a relay it has not been given.
