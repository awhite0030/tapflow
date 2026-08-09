// Wire payload types come from `@tapflowio/protocol`, which owns them — this file used to declare
// its own copies and they drifted (`session:chrome` here lacked three fields `DeviceViewer` reads).
// `AgentDevice` and `DeviceInfo` were this package's names for shapes protocol calls `DeviceSummary`
// and `DeviceDetails`; the old `DeviceInfo` also collided with the relay's own `DeviceInfo`, which is
// the *other* shape. Re-exported so this module stays the one import site for view code.
import type {
  AgentResources, AndroidButton, ChromeButton, ChromeData, ChromeRect,
  AndroidChrome, BrowserInbound, ChromePayload, DeviceDetails, DeviceSummary, SessionInfo,
} from '@tapflowio/protocol'

export type {
  AgentResources, AndroidButton, ChromeButton, ChromeData, ChromeRect,
  AndroidChrome, BrowserInbound, ChromePayload, DeviceDetails, DeviceSummary, SessionInfo,
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

