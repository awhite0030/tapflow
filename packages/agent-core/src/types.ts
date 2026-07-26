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

export interface Point {
  x: number
  y: number
}

export interface AgentResources {
  cpuPercent: number
  memUsedMB: number
  memTotalMB: number
  slotsAvailable: number
  slotsTotal: number
  reportedAt: number  // Date.now()
}

// Android physical button descriptor sent via session:chrome payload
export interface AndroidButton {
  name: string
  accessibilityTitle: string
  keyCode: number
}

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
/** Floor between confirm reads — never busy-spin on a fast backend. */
export const CLIPBOARD_POLL_MS = 20
/** Slowest observed `simctl pbpaste`/`pbcopy` under load; the read path makes several calls. */
export const CLIPBOARD_DEVICE_CALL_MS = 300

/** Longest an agent can legitimately take to answer a clipboard read: confirm the sentinel,
 *  press, watch for the change, restore — plus the device calls each of those costs. */
export const CLIPBOARD_AGENT_WORST_MS =
  CLIPBOARD_WRITE_DEADLINE_MS + CLIPBOARD_COPY_DEADLINE_MS + 4 * CLIPBOARD_DEVICE_CALL_MS
