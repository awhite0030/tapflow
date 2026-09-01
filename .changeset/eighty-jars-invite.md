---
'@tapflowio/relay': minor
---

**A Docker install can now create its first account.** Until now it could not, at all. The bootstrap endpoint `POST /api/v1/auth/init` only answers a local client — that check is what stops a stranger claiming a public instance between first boot and the owner setting a password — and a container is always behind its bridge gateway, so the call answered 403 from the host's own browser and from the LAN alike. The error text points at `tapflow admin init`, but the image is relay-only by design and carries no CLI to run it. `docker compose up` therefore ended at a login screen nobody could get past.

Set `TAPFLOW_ADMIN_EMAIL` and `TAPFLOW_ADMIN_PASSWORD` and the relay creates that first Admin while it boots, before it serves anything. They can go in `<dataDir>/.env` instead of the compose file, which keeps the password out of your shell history and inside the volume you already mount — but **`chmod 600` it yourself**. `tapflow init` creates that file 0600 and the relay-only image has no CLI, so a container operator writes it under their own umask; the relay now warns at boot when it is readable by others.

It runs on every boot and does nothing when an owner already exists — your account is never replaced and nothing is logged, so a long-running relay does not collect a line per restart. **A password under 8 characters, or one variable without the other, stops the relay starting.** That only happens when an admin was asked for and there is none: an install that already has an owner returns before those checks, so a typo cannot strand a relay that is already serving. Serving anyway would leave the install ownerless and claimable by anything that can reach loopback, for as long as nobody notices — and an ownerless relay is not a working service to begin with. The password is never written to the log on any path, and is removed from the environment once used.

Nothing changes for an install that does not set them, including the 403 above, which is still the right answer for a browser reaching a relay it has not been given.
