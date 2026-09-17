import { confirm, isCancel } from '@clack/prompts'
import type { ApprovalDeps } from './net-filter.js'
import { step } from './print.js'

/**
 * The terminal's half of `followThroughApproval`, in one place because two commands use it.
 *
 * `net-filter.ts` takes these as parameters rather than importing a prompt library, so the module that
 * runs the installer stays free of anything that reads a keyboard, and its tests can hand the flow a
 * person who answers yes or no.
 *
 * **A cancelled prompt is reported as such, not as a no.** Ctrl-C or Esc answers clack's cancel symbol,
 * and in raw mode no SIGINT reaches the process, so this answer is the only trace of someone backing
 * out. The question asked before the install has to stop on it — a no there still installs — and the
 * one asked after reads it as a no, since the install has already run.
 */
export function isInteractive(): boolean {
  // **Both ends, not only the one that prints.** With stdin at EOF under a terminal — `</dev/null`, a
  // provisioning script — clack draws the prompt, the promise never settles, and node exits 0 with
  // nothing after it. Measured with clack 1.7 under a pty: exit 0, never settled. The command would end
  // without a banner, which is worse than not asking.
  return process.stdout.isTTY === true && process.stdin.isTTY === true
}

export function terminalApprovalDeps(): ApprovalDeps {
  return {
    interactive: isInteractive(),
    confirm: async (message) => {
      const answer = await confirm({ message })
      if (isCancel(answer)) return 'cancelled'
      return answer === true
    },
    say: step,
  }
}
