// Wire payload types come from `@tapflowio/protocol`, which owns them — this file used to declare
// its own copies and they drifted (`session:chrome` here lacked three fields `DeviceViewer` reads).
// `AgentDevice` and `DeviceInfo` were this package's names for shapes protocol calls `DeviceSummary`
// and `DeviceDetails`; the old `DeviceInfo` also collided with the relay's own `DeviceInfo`, which is
// the *other* shape. Re-exported so this module stays the one import site for view code.
import type {
  AgentResources, AndroidButton, ChromeButton, ChromeData, ChromeRect,
  AndroidChrome, ChromePayload, ClipboardErrorPayload, DeviceDetails, DeviceSummary, InputErrorReason, SessionInfo, SessionTerminatedReason,
} from '@tapflowio/protocol'

export type {
  AgentResources, AndroidButton, ChromeButton, ChromeData, ChromeRect,
  AndroidChrome, ChromePayload, DeviceDetails, DeviceSummary, SessionInfo,
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
  | { type: 'session:agent-away'; sessionId: string }
  | { type: 'session:rebound'; sessionId: string; capabilities: string[] }
  | { type: 'session:chrome'; payload: ChromePayload }
  | { type: 'session:deviceInfo'; payload: DeviceDetails }
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
  | { type: 'input:error'; sessionId: string; message: string; reason?: InputErrorReason }
  // agent → browser
  | { type: 'clipboard:data'; sessionId: string; requestId: string; payload: { text: string } }
  | { type: 'clipboard:write-done'; sessionId: string; requestId: string }
  | { type: 'clipboard:error'; sessionId: string; requestId: string; message: string; payload?: ClipboardErrorPayload }
  | { type: 'error'; message: string }
