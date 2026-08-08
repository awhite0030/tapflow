import type { InputErrorReason } from '@tapflowio/protocol'

/**
 * What a tester is told when an input fails, keyed by the reason.
 *
 * Keyed exhaustively so a new reason cannot be added without deciding what the user is told — the
 * same rule `SESSION_ENDED_NOTICE` states in `src/pages/QASession.tsx`, and the reason a closed
 * literal union exists. `null` means the reason is shown nowhere, which is a decision per entry
 * rather than a default.
 *
 * The copy lives here and not in the agents on purpose. `message` on the wire is free prose each
 * agent owns; `reason` is the contract. Rendering `message` would make an agent's English the UI's
 * copy — unlocalisable, and written by the layer furthest from the reader. `message` is carried as
 * the description instead, where its diagnostic detail (`unknown key code: KeyFoo`) belongs.
 */
export interface InputErrorNotice {
  /** What happened, in the reader's terms — not the wire's. */
  title: string
  /** What to do about it. The protocol's per-reason advice is written for a program ("rebind"); this
   *  is the same advice for a person. */
  action: string
}

export const INPUT_ERROR_NOTICE: Record<InputErrorReason, InputErrorNotice | null> = {
  // The channel is gone and will not come back on its own. #464 (a helper binary that is missing or
  // built for the wrong architecture) lands here and is not fixed by restarting the device, so the
  // action names the agent rather than the device.
  'channel-unavailable': {
    title: 'Input is not reaching this device',
    action: 'Reconnect, or check the agent on the Mac running it.',
  },
  // Deliberately not folded into the line above: the protocol prescribes a *different* action for
  // this one ("boot the device"), and one sentence cannot give both.
  'not-booted': {
    title: 'The device is not running',
    action: 'Start it again to continue testing.',
  },
  // Reached on a channel that looked healthy — most often a connected-but-unresponsive Android
  // emulator, where the gRPC call is refused while the socket still reports itself writable. One
  // retry is worth it; a repeat means the guest is not answering.
  'dispatch-failed': {
    title: 'The device rejected that input',
    action: 'Try once more. If it keeps failing, restart the device.',
  },
  // About the input, not the channel: this build of the agent cannot express it on the connection in
  // use. Retrying is guaranteed to fail, so the action says so rather than suggesting a retry.
  unsupported: {
    title: 'That input is not supported on this device',
    action: 'Everything else still works — this one has no equivalent here.',
  },
  // The dashboard sent something incomplete. That is our bug, and a tester reporting it is the only
  // way it gets found, so it is never silent.
  malformed: {
    title: 'tapflow sent a malformed input',
    action: 'This is a bug in tapflow — please report it with what you were doing.',
  },
  // Silent: the channel is coming up and the measured window is 186–247ms. Only standalone inputs (a
  // key, a button) are ever refused for this — a continuation frame is judged on gesture ownership
  // first — and pressing again is the instinct anyway. An error here would be noise for something
  // already fixed by the time it was read.
  'channel-starting': null,
  // Silent: the gesture this frame belonged to is gone, which happens on the first gesture after any
  // helper death because the replacement is eager. A fresh gesture normally works. The guarantee is
  // not "the next one lands" — a helper that keeps dying before it is ready refuses every terminal
  // frame — but that case exhausts the respawn budget and surfaces as `channel-unavailable`, so it
  // is bounded and ends up visible.
  'no-gesture': null,
}

/**
 * Resolve a wire `reason` to the copy to show and the key to dedupe on.
 *
 * Takes `string | undefined` rather than `InputErrorReason | undefined` on purpose. The parameter's
 * whole job is to absorb values this build does not know about — a newer agent against an older
 * dashboard — and typing it as the union would describe that case as impossible while it is exactly
 * the case being handled.
 *
 * Absence and unfamiliarity both resolve to `channel-unavailable`: absence means *unknown*, never
 * *fine* (an agent older than #490 omits the field, and the relay's own reasonless `input:error`
 * still does), and the protocol's rule for a reason a consumer does not recognise is the same
 * conservative reading. Resolving the *key* as well as the copy is what keeps two different unknown
 * reasons from stacking two identical toasts.
 *
 * `Object.hasOwn`, not `in` — `'toString' in INPUT_ERROR_NOTICE` is true, and a reason of `toString`
 * would otherwise return a function as the notice.
 */
export function resolveInputError(
  reason: string | undefined,
): { key: InputErrorReason; notice: InputErrorNotice | null } {
  const key: InputErrorReason =
    reason !== undefined && Object.hasOwn(INPUT_ERROR_NOTICE, reason)
      ? (reason as InputErrorReason)
      : 'channel-unavailable'
  return { key, notice: INPUT_ERROR_NOTICE[key] }
}
