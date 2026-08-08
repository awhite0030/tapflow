import type { AndroidButton, AgentResources, ClipboardErrorPayload, Point } from '@tapflowio/protocol'

// These three are **wire** payload types, so `@tapflowio/protocol` owns them — it is the leaf both
// consumers that read them can reach, and this package is not one of them (neither `dashboard` nor
// `mcp-server` depends on `agent-core`). Re-exported under the same names so agent code and
// third-party agents built on `AgentRegistry.register()` are unaffected.
//
// `export type`, not a bare `export { … } from`: the latter is a real runtime import of protocol's
// `dist`, which would drag this package into the source-resolution rule in the root AGENTS.md.
export type { AndroidButton, AgentResources, ClipboardErrorPayload, Point }

export type Platform = string

export type DeviceStatus = 'booted' | 'shutdown' | 'unknown'

export interface Device {
  id: string
  name: string
  platform: Platform
  status: DeviceStatus
  typeId?: string     // platform device type identifier (iOS: com.apple.CoreSimulator.SimDeviceType.*)
  osVersion?: string  // e.g. "iOS 18.3"
}



// Android physical button descriptor sent via session:chrome payload

// Closed role vocabulary shared by all platforms. Unmappable native roles
// become 'other'; the platform-native string is preserved in rawRole.
export type UIElementRole =
  | 'button'
  | 'text'
  | 'input'
  | 'image'
  | 'checkbox'
  | 'switch'
  | 'slider'
  | 'list'
  | 'cell'
  | 'tab'
  | 'other'

// Normalized to 0-1 in the same coordinate space the touch input path
// consumes, so a frame center can be fed straight into tap without conversion.
export interface UIElementFrame {
  x: number
  y: number
  width: number
  height: number
}

export interface UIElement {
  role: UIElementRole
  label: string
  identifier?: string
  frame: UIElementFrame
  enabled: boolean
  rawRole?: string
}

// ── Agent capabilities ──────────────────────────────────────────────────────
// Advertised in `agent:register` so a viewer can tell what the agent on the other
// end actually implements. An agent that predates a capability simply does not list
// it, so `undefined`/absent means "not supported" — no version parsing, and nothing
// has to be inferred from a timeout (guessing that way once produced a double paste
// on a merely-slow agent, and a lost keystroke on an old one).
// The dashboard cannot import from here (it has no agent-core dependency), so this stays a
// plain string list on the wire rather than a helper nobody on the reading side can call.
export type AgentCapability = 'clipboard'


// ── Clipboard bridge shared contract ────────────────────────────────────────
// Both agents implement the same protocol, so the limits and the sentinel vocabulary
// live here rather than being duplicated (and drifting) per package.

/** Payload ceiling in UTF-8 bytes, both directions. Clipboard JSON shares the socket
 *  with video, so an unbounded payload would stall the stream on backpressure. */
export const MAX_CLIPBOARD_BYTES = 1024 * 1024

export const clipboardByteLength = (text: string): number => Buffer.byteLength(text, 'utf8')

/** Marker an agent parks on the device clipboard while it waits for a copy to land.
 *  Recognisable on purpose: a sentinel must never be handed back as the user's text. */
export const CLIPBOARD_SENTINEL_PREFIX = '​tapflow-clipboard-'

export const isClipboardSentinel = (value: string): boolean =>
  value.startsWith(CLIPBOARD_SENTINEL_PREFIX)

// ── Clipboard timing ────────────────────────────────────────────────────────
// Shared so the two agents cannot drift, and so the browser can DERIVE its own budget from
// the agent's worst case rather than happening to pick the same number. They were equal by
// coincidence once, and that hid a defect where the browser gave up at the exact moment the
// agent was about to answer.

/** Watch the device clipboard this long for an injected chord to take effect. */
export const CLIPBOARD_COPY_DEADLINE_MS = 2_000
/** Confirm a write became visible on the device within this. */
export const CLIPBOARD_WRITE_DEADLINE_MS = 1_000
/** Bound on confirming the post-failure restore. It is cleanup, not part of answering: the
 *  agent replies from the `catch` and restores in the `finally` that follows, so this window
 *  sits OUTSIDE the caller's round trip and is deliberately absent from the worst case below.
 *  The queue is still held for its duration, which is what keeps the next operation from
 *  reading a sentinel. */
export const CLIPBOARD_RESTORE_DEADLINE_MS = 500
/** Floor between confirm reads — never busy-spin on a fast backend. */
export const CLIPBOARD_POLL_MS = 20
/** Slowest observed `simctl pbpaste`/`pbcopy` under load; the read path makes several calls. */
export const CLIPBOARD_DEVICE_CALL_MS = 300

/** How long an agent should be expected to take to ANSWER a clipboard read — the slow path being
 *  the one that produces the useful message ("did not copy anything — is something selected?").
 *  The browser waits at least this long before giving up with a generic message of its own.
 *
 *  Two deadline windows are inside the answer: confirm the sentinel applied, then watch for the
 *  copy. The restore window is not — the reply goes out before it starts.
 *
 *  Five device calls, not four. Each windowed loop checks its deadline AFTER the call returns,
 *  so a window can overrun by one call; counting the loops' overruns plus the fixed calls
 *  (read the original, ready the guest for the chord, write the sentinel) gives five.
 *  Undercounting these is what previously left the browser giving up first on this very path.
 *
 *  NOT a hard upper bound, and it cannot be one. Every device call carries its own multi-second
 *  timeout (5s for a simctl pasteboard call, an emulator gRPC deadline, an adb keyevent), so a
 *  genuinely wedged device can take far longer than this. `CLIPBOARD_DEVICE_CALL_MS` is an
 *  observed-under-load figure, not a ceiling. What this budget buys is that the *normal* slow
 *  path — a real device that simply had nothing selected — answers before the browser stops
 *  listening. A hung device loses the specific message; that is the correct trade, since at that
 *  point the message is not the user's problem. */
export const CLIPBOARD_AGENT_WORST_MS =
  CLIPBOARD_WRITE_DEADLINE_MS + CLIPBOARD_COPY_DEADLINE_MS + 5 * CLIPBOARD_DEVICE_CALL_MS
