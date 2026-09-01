import { isInitialized, createAdminAccount } from './adminAccount.js'

/**
 * Create the first Admin from the environment, once, at boot.
 *
 * **Why this exists at all.** `POST /api/v1/auth/init` requires `resolveClient(req).isLocal`, which
 * stops a public instance being claimed by a stranger between first boot and the owner setting a
 * password. A container is always behind its bridge gateway, so that check can never pass there —
 * measured against the published image: the call answers 403 from the host's own browser and from
 * the LAN alike. The error text points at `tapflow admin init`, but the image is relay-only by
 * design (`pnpm deploy --filter @tapflowio/relay`) and carries no CLI. A Docker install therefore
 * had no way to make its first account at all.
 *
 * This path does not go through HTTP, so the `isLocal` gate is not weakened — it is simply not on
 * this road. Whoever can set the container's environment already controls the install.
 *
 * **Idempotent and silent when there is nothing to do.** It runs on every boot, and an install that
 * already has an owner must not accumulate a log line per restart, nor have its account touched.
 */
export interface BootstrapLogger {
  info(message: string): void
  warn(message: string): void
}

export interface BootstrapEnv {
  TAPFLOW_ADMIN_EMAIL?: string
  TAPFLOW_ADMIN_PASSWORD?: string
}

/**
 * **Misconfiguration warns rather than refusing to boot.** These variables are first-run-only: on an
 * install that already has an owner they mean nothing, and letting a typo in them keep a running
 * relay down costs far more than the mistake. The warning has to be loud instead.
 *
 * Neither the password nor its length is ever written to the log.
 */
export function bootstrapAdminFromEnv(env: BootstrapEnv, logger: BootstrapLogger): void {
  const email = env.TAPFLOW_ADMIN_EMAIL?.trim()
  const password = env.TAPFLOW_ADMIN_PASSWORD

  // Neither set is the ordinary case — every install that is not a fresh container.
  if (!email && !password) return

  if (isInitialized()) return

  if (!email || !password) {
    const missing = email ? 'TAPFLOW_ADMIN_PASSWORD' : 'TAPFLOW_ADMIN_EMAIL'
    logger.warn(
      `${missing} is not set, so no admin account was created. ` +
      'Set both TAPFLOW_ADMIN_EMAIL and TAPFLOW_ADMIN_PASSWORD to bootstrap the first account.'
    )
    return
  }

  switch (createAdminAccount(email, password)) {
    case 'password-too-short':
      logger.warn(
        'TAPFLOW_ADMIN_PASSWORD is shorter than 8 characters, so no admin account was created. ' +
        'Set a longer one and restart.'
      )
      return
    case 'missing-fields':
      // Unreachable: both are non-empty by the checks above. Handled so a later change to
      // `createAdminAccount` cannot silently fall through to "created".
      logger.warn('No admin account was created: the configured email or password was empty.')
      return
    case 'ok':
      logger.info(`Created the first admin account for ${email} from the environment.`)
  }
}
