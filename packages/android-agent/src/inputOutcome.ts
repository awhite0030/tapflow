/**
 * What happened to a terminal input, in the vocabulary the ack speaks.
 *
 * `dispatched: boolean` cannot express this. Android answers five failures that are neither "no
 * channel" nor "not booted": an input we do not implement on the path in use, a dispatch that
 * errored on a healthy channel, a session this agent does not know, a message that did not carry
 * what the input needs, and a terminal frame with no gesture behind it. Collapsing any of them into
 * the two messages `ackInput` used to own would report `input channel not ready` for a perfectly
 * healthy channel, which is the same class of lie this exists to remove (#482 / #484).
 *
 * Deliberately NOT identical to the iOS vocabulary — but not entirely by choice, and the difference
 * is worth stating honestly:
 *
 * - `unsupported` for an unmapped button IS a decision. iOS answers success there because its
 *   unmapped case means the device genuinely has no such button (#484); ours means we do not know
 *   the name.
 * - `no-session` is NOT a platform difference. iOS's four terminal handlers also `break` silently
 *   on a missing state, and iOS actually clears `deviceStates` on disconnect and reconnect, which
 *   makes it *more* reachable there than here. That is an unfixed asymmetry, not a design choice.
 *
 * `not-booted` and `channel-down` keep their original wording, so the part that does overlap stays
 * symmetric — though note our `channel-down` is narrower than iOS's, because the situations iOS
 * folds into it get their own reasons above.
 */
export type InputOutcome =
  /** Handed to a live channel, or to a command that completed. Not a landing guarantee — HID and
   *  `adb shell input` are both fire-and-forget once accepted. */
  | 'delivered'
  /** We do not implement this input on the path in use: a key code with no mapping, a button name
   *  we do not know, a pinch on the adb fallback. The channel and the device are fine. */
  | 'unsupported'
  /** There is no live channel to write to. */
  | 'channel-down'
  /** The message did not carry what the input needs — no button name, no key code. Nothing was
   *  attempted, and nothing is wrong with the channel or the device. */
  | 'malformed'
  /** A frame that only means something relative to an earlier one arrived without it: a touch end
   *  on the adb path with no touch start. Nothing was attempted, and the channel is fine. */
  | 'no-gesture'
  /** We tried on a live channel and the dispatch errored. */
  | 'failed'
  /** The device is not booted. */
  | 'not-booted'
  /** This agent holds no state for the session the message names. */
  | 'no-session'

const MESSAGES: Record<Exclude<InputOutcome, 'delivered'>, string> = {
  // The two that predate this vocabulary keep their exact wording — iOS emits the same strings for
  // the same meanings, and a consumer matching on them must keep working.
  'not-booted': 'device not booted',
  'channel-down': 'input channel not ready',
  unsupported: 'this input is not supported on the active connection to the device',
  failed: 'the device rejected the input',
  'no-session': 'no active session for this device on this agent',
  malformed: 'the input message was missing what it needs to be dispatched',
  'no-gesture': 'no gesture was in progress to complete',
}

export function outcomeMessage(outcome: Exclude<InputOutcome, 'delivered'>): string {
  return MESSAGES[outcome]
}
