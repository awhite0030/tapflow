import type { SessionTerminatedReason } from '@tapflowio/protocol'

export interface AgentResources {
  cpuPercent: number
  memUsedMB: number
  memTotalMB: number
  slotsAvailable: number
  slotsTotal: number
  reportedAt: number
}

export interface AgentDevice {
  id: string
  name: string
  platform: string
  status: string
  osVersion?: string
  sessionId: string
  busy: boolean
}

export interface Comment {
  id: number
  author: string
  authorAvatarUrl: string | null
  body: string
  created_at: string
  attachments: CommentAttachment[]
}

export interface CommentAttachment {
  id: number
  file_path: string
  mime: string
}

export interface SessionInfo {
  agentName?: string
  platform?: string
  resources?: AgentResources
  devices: AgentDevice[]
}

export interface ChromeRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ChromeButton {
  name: string
  accessibilityTitle: string
  anchor: string
  onTop: boolean                            // true = button is above device frame (e.g. home button)
  normalOffset: { x: number; y: number }   // button center at retracted/default position in 2× composite px
  rolloverOffset: { x: number; y: number } // button center at extended/hover position in 2× composite px
  buttonW: number                           // button width in 2× composite px
  buttonH: number                           // button height in 2× composite px
  usagePage: number                         // HID usage page for SimulatorKit injection (0 = unknown)
  usage: number                             // HID usage code (0 = unknown)
  buttonPng?: string                        // base64 PNG of button at 2× (for CSS-animated overlay)
  pressedPng?: string                       // base64 PNG of pressed state (imageDown asset)
  pressedRect?: ChromeRect
}

export interface AndroidButton {
  name: string
  accessibilityTitle: string
  keyCode: number
}

export interface ChromeData {
  framePng: string         // full composite PDF at 2× — device frame visible, screen hole transparent
  bezelWidth: number
  bezelHeight: number
  compositeWidth: number   // full PDF width including devicePadding, at 2× px
  compositeHeight: number  // full PDF height including devicePadding, at 2× px
  padding: { left: number; right: number; top: number; bottom: number }
  screenRect: ChromeRect
  screenCornerRadius: number  // screen corner radius in 2× px (0 if device has no rounded corners)
  logicalWidth: number
  logicalHeight: number
  buttons: ChromeButton[]
}

export interface DeviceInfo {
  deviceName: string
  osVersion: string
}

export interface Recording {
  id: number
  url: string
  sessionId: string | null
  fileSize: number
  mime: string
  createdAt: string
  expiresAt: string
}

export interface App {
  id: number
  name: string
  bundle_id_key: string
  platform: 'ios' | 'android' | 'both'
  latest_build_id: number | null
  version_name: string | null
  build_number: string | null
  status_label: string | null
  latest_uploaded_at: string | null
}

export interface Build {
  id: number
  app_id: number
  name: string
  version_name: string | null
  build_number: string | null
  version_label: string | null
  status_label: 'Backlog' | 'In Progress' | 'Done' | 'Rejected' | null
  platform: 'ios' | 'android'
  bundle_id: string | null
  uploaded_at: string
  completed_at: string | null
  delete_after: string | null
  uploader: string | null
}

export interface ReleaseGroup {
  versionName: string
  builds: Build[]
}

/**
 * What the viewer *receives*. Outbound messages are no longer listed here — they live in
 * `@tapflowio/protocol` as `BrowserToRelay`, which `send()` is typed with, so they are checked
 * rather than merely described.
 *
 * They used to be listed "as the readable record of the protocol", and that record went wrong
 * without anyone noticing: `input:key` was documented as `payload: { key: string }` while every
 * sender and both agents used `{ code, modifiers }` — with `modifiers` a bitmap, not a string.
 * A description that nothing checks is a description that drifts.
 */
export type RelayMessage =
  | { type: 'agents:listed'; sessions: SessionInfo[] }
  | { type: 'session:joined'; sessionId: string; capabilities?: string[] }
  | { type: 'session:terminated'; sessionId: string; reason: SessionTerminatedReason }
  | { type: 'session:chrome'; payload: ChromeData | { buttons: AndroidButton[]; streamType: 'h264' } }
  | { type: 'session:deviceInfo'; payload: DeviceInfo }
  | { type: 'device:booting' }
  | { type: 'device:ready'; payload: { deviceId: string } }
  | { type: 'device:boot-error'; sessionId?: string; message: string }
  | { type: 'device:shutdown-done'; payload: { deviceId: string } }
  | { type: 'keyboard:toggled'; sessionId: string; payload: { visible: boolean } }
  | { type: 'app:install-done' }
  | { type: 'app:install-error'; sessionId?: string; message: string }
  | { type: 'app:launch-done' }
  | { type: 'app:launch-error'; sessionId?: string; message: string }
  | { type: 'open-url:done'; sessionId: string }
  | { type: 'open-url:error'; sessionId: string; message: string }
  | { type: 'input:done'; sessionId: string }
  | { type: 'input:error'; sessionId: string; message: string }
  // agent → browser
  | { type: 'clipboard:data'; sessionId: string; requestId: string; payload: { text: string } }
  | { type: 'clipboard:write-done'; sessionId: string; requestId: string }
  | { type: 'clipboard:error'; sessionId: string; requestId: string; message: string; payload?: { unsupported?: boolean; sentinelParked?: boolean } }
  | { type: 'error'; message: string }
