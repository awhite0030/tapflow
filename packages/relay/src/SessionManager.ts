import { randomUUID } from 'crypto'
import { WebSocket } from 'ws'
import type { DeviceStatus } from '@tapflowio/agent-core'
import { ValidationError } from '@tapflowio/agent-core'
import type { AgentResources, SessionInfo } from './types.js'
import type { ChromePayload, DeviceDetails } from '@tapflowio/protocol'

export interface Session {
  id: string
  agentId?: string
  agentName?: string
  agentPlatform?: string
  agentCapabilities?: string[]
  agentSocket: WebSocket
  browserSocket: WebSocket | null
  streamSocket: WebSocket | null
  deviceId: string
  deviceName: string
  devicePlatform: string
  /** What simctl/adb reported about the device. Drives the device list and the REST guards —
   *  "is this device up", which is a different question from the one below. */
  deviceStatus: DeviceStatus
  /** Whether the relay has told a browser this session is streaming, and has not since taken it
   *  back. This is what the `device:ready` replay keys off. `deviceStatus` cannot answer it: it
   *  starts from the agent's `simctl list` snapshot, so a simulator that was already running has a
   *  session marked `booted` before the agent has done anything for it (#440). */
  readySent: boolean
  /** Whether the relay has forwarded a `device:boot` for this session to the agent socket it is
   *  currently pointed at. Until it has, that agent holds no device state for the session and
   *  drops its input without a word (`IOSAgent.handleRelayMessage`: `if (!state) break`) — so this
   *  is what lets the relay answer instead of letting the caller time out. Distinct from
   *  `readySent`, which also goes false when only the stream socket drops; the agent still has its
   *  state then, and input still works. */
  bootRequested: boolean
  deviceOsVersion?: string
  chromeData?: ChromePayload
  deviceInfo?: DeviceDetails
  idleTimer: ReturnType<typeof setTimeout> | null
}

type RawDevice = { id: string; name: string; platform: string; status: string; osVersion?: string }

/** What an `agent:register` says about the agent itself, as opposed to its devices. */
export type AgentIdentity = {
  agentId?: string
  agentName?: string
  agentPlatform?: string
  agentCapabilities?: string[]
}

const DEFAULT_IDLE_TIMEOUT_MS = parseInt(process.env['IDLE_TIMEOUT_MS'] ?? String(5 * 60 * 1000))

export class SessionManager {
  private sessions = new Map<string, Session>()
  private agentResources = new Map<WebSocket, AgentResources>()
  private agentSocketIndex = new Map<WebSocket, Set<string>>()
  private streamSocketIndex = new Map<WebSocket, Session>()
  private browserSocketIndex = new Map<WebSocket, Session>()
  private readonly idleTimeoutMs: number

  constructor(options: { idleTimeoutMs?: number } = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  }

  /**
   * The single place a session's agent-derived fields are computed. `create()` spreads it and
   * `rebind()` assigns it, so neither one names these fields itself — adding one to `Session` has
   * exactly one place it can be filled in, instead of two that must be kept in step. The rebind
   * path is the one that would be forgotten, and nothing checks for it.
   */
  private static agentFields(
    agent: AgentIdentity,
    device: RawDevice,
  ): Pick<Session, 'agentId' | 'agentName' | 'agentPlatform' | 'agentCapabilities' | 'deviceName' | 'deviceStatus' | 'deviceOsVersion'> {
    return {
      agentId: agent.agentId,
      agentName: agent.agentName,
      agentPlatform: agent.agentPlatform,
      agentCapabilities: agent.agentCapabilities,
      deviceName: device.name,
      deviceStatus: device.status as DeviceStatus,
      deviceOsVersion: device.osVersion,
    }
  }

  create(agentSocket: WebSocket, devices: RawDevice[] = [], agentName?: string, agentPlatform?: string, agentId?: string, agentCapabilities?: string[]): string[] {
    const agentIds = this.agentSocketIndex.get(agentSocket) ?? new Set<string>()
    const agent: AgentIdentity = { agentId, agentName, agentPlatform, agentCapabilities }
    return devices.map((d) => {
      const id = randomUUID()
      this.sessions.set(id, {
        id,
        ...SessionManager.agentFields(agent, d),
        agentSocket,
        browserSocket: null,
        streamSocket: null,
        deviceId: d.id,
        devicePlatform: d.platform,
        readySent: false,
        bootRequested: false,
        idleTimer: null,
      })
      agentIds.add(id)
      this.agentSocketIndex.set(agentSocket, agentIds)
      return id
    })
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)
  }

  getAllByAgentSocket(ws: WebSocket): Session[] {
    const ids = this.agentSocketIndex.get(ws)
    if (!ids) return []
    return Array.from(ids).map((id) => this.sessions.get(id)).filter((s): s is Session => s !== undefined)
  }

  /**
   * Agent sockets currently registered under the same identity (machine id + platform). Identity
   * is `agentId ?? agentName`: agentId (macOS IOPlatformUUID) is unique per Mac, while agentName
   * (os.hostname()) can collide across hosts — so older agents without an agentId fall back to the
   * hostname. Platform disambiguates an iOS and Android agent on the same Mac (same agentId). Used
   * on re-register to evict an agent's stale socket (the old connection whose close hasn't fired
   * yet after an unclean drop) before it shows as a duplicate "Stale" card. Heartbeat backstop for
   * never-reconnecting agents is tracked in #313.
   */
  getAgentSocketsByIdentity(identity: string, platform: string | undefined): WebSocket[] {
    const sockets = new Set<WebSocket>()
    for (const s of this.sessions.values()) {
      if ((s.agentId ?? s.agentName) === identity && s.agentPlatform === platform) sockets.add(s.agentSocket)
    }
    return Array.from(sockets)
  }

  getByStreamSocket(ws: WebSocket): Session | undefined {
    return this.streamSocketIndex.get(ws)
  }

  getByBrowserSocket(ws: WebSocket): Session | undefined {
    return this.browserSocketIndex.get(ws)
  }

  join(sessionId: string, browserSocket: WebSocket): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new ValidationError(`Session not found: ${sessionId}`)
    if (session.browserSocket?.readyState === WebSocket.OPEN) {
      throw new ValidationError(`Session busy: ${sessionId}`)
    }
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null }
    if (session.browserSocket) this.browserSocketIndex.delete(session.browserSocket)
    session.browserSocket = browserSocket
    this.browserSocketIndex.set(browserSocket, session)
  }

  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null }
    if (session.streamSocket) this.streamSocketIndex.delete(session.streamSocket)
    if (session.browserSocket) this.browserSocketIndex.delete(session.browserSocket)
    const agentIds = this.agentSocketIndex.get(session.agentSocket)
    agentIds?.delete(sessionId)
    if (agentIds?.size === 0) this.agentSocketIndex.delete(session.agentSocket)
    this.sessions.delete(sessionId)
  }

  clearBrowser(sessionId: string, onTimeout?: () => void): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.browserSocket) {
      this.browserSocketIndex.delete(session.browserSocket)
      session.browserSocket = null
    }
    if (session.idleTimer) { clearTimeout(session.idleTimer); session.idleTimer = null }
    if (onTimeout) {
      session.idleTimer = setTimeout(() => {
        session.idleTimer = null
        onTimeout()
      }, this.idleTimeoutMs)
    }
  }

  /**
   * Re-point an existing session at the socket of an agent that just restarted, keeping its id.
   *
   * Everything a rebind touches lives here rather than at the call site, and that is deliberate:
   * the index move below has an order requirement that is invisible where it is used, and the
   * field refresh has to stay in step with `create()`. Written inline in `RelayServer`, the next
   * field added to `create()` would be missed on this path alone, and silently.
   */
  rebind(sessionId: string, agentSocket: WebSocket, device: RawDevice, agent: AgentIdentity): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const old = session.agentSocket

    // Drop from the old socket's set BEFORE reassigning. `remove()` dereferences the index through
    // `session.agentSocket`, and following that idiom here would delete the id from the *new* set
    // and leave the old one holding it — so the old socket's close, which fires late after an
    // unclean drop, would evict the session that was just re-pointed.
    const oldIds = this.agentSocketIndex.get(old)
    oldIds?.delete(sessionId)
    if (oldIds?.size === 0) this.agentSocketIndex.delete(old)

    session.agentSocket = agentSocket
    const ids = this.agentSocketIndex.get(agentSocket) ?? new Set<string>()
    ids.add(sessionId)
    this.agentSocketIndex.set(agentSocket, ids)

    // The stream died with the old process. `old.terminate()` only closes the control socket, so
    // nothing else would clear this.
    this.clearStreamSocket(sessionId)
    // `clearStreamSocket` returns early when there is no stream socket, and a session that was
    // never streamed has none — so this cannot be left to it.
    session.readySent = false
    // The new process has no device state for this session until it is asked to boot.
    session.bootRequested = false

    Object.assign(session, SessionManager.agentFields(agent, device))

    // Not a carry-over guard — resources are keyed by socket, so re-pointing the session at a new
    // one already leaves the old reading behind, and every reader goes through
    // `session.agentSocket`. This is the leak: `evictAgentSocket` drops the entry, but it returns
    // early when the socket has no sessions left, which is precisely the case where every one of
    // them was rebound. Without this line the map keeps a dead socket per restart, forever.
    this.agentResources.delete(old)
  }

  setResources(agentSocket: WebSocket, resources: AgentResources): void {
    this.agentResources.set(agentSocket, resources)
  }

  getResources(agentSocket: WebSocket): AgentResources | undefined {
    return this.agentResources.get(agentSocket)
  }

  removeResources(agentSocket: WebSocket): void {
    this.agentResources.delete(agentSocket)
  }

  clearDeviceCache(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.chromeData = undefined
    session.deviceInfo = undefined
    session.deviceStatus = 'shutdown'
    // Called on `device:booting`: whatever we announced before is no longer true, and replaying it
    // to a browser that joins mid-boot would promise a stream that is being torn down.
    session.readySent = false
  }

  setStreamSocket(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.streamSocket) this.streamSocketIndex.delete(session.streamSocket)
    session.streamSocket = ws
    this.streamSocketIndex.set(ws, session)
  }

  /** The stream socket is the stream. Losing it means whatever we announced is no longer true —
   *  and this is the only signal for it on the paths where the agent never reports back, such as a
   *  `simctl shutdown` that throws after the streamer has already been torn down. */
  clearStreamSocket(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session?.streamSocket) return
    this.streamSocketIndex.delete(session.streamSocket)
    session.streamSocket = null
    session.readySent = false
  }

  setChromeData(sessionId: string, data: ChromePayload): void {
    const session = this.sessions.get(sessionId)
    if (session) session.chromeData = data
  }

  setDeviceInfo(sessionId: string, info: { deviceName: string; osVersion: string }): void {
    const session = this.sessions.get(sessionId)
    if (session) session.deviceInfo = info
  }

  markBootRequested(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) session.bootRequested = true
  }

  setReadySent(sessionId: string, value: boolean): void {
    const session = this.sessions.get(sessionId)
    if (session) session.readySent = value
  }

  updateDeviceStatus(sessionId: string, status: DeviceStatus): void {
    const session = this.sessions.get(sessionId)
    if (session) session.deviceStatus = status
  }

  list(): SessionInfo[] {
    // Group sessions by agentSocket
    const agentMap = new Map<WebSocket, Session[]>()
    for (const session of this.sessions.values()) {
      const group = agentMap.get(session.agentSocket) ?? []
      group.push(session)
      agentMap.set(session.agentSocket, group)
    }

    return Array.from(agentMap.values()).map((group) => ({
      agentName: group[0].agentName,
      platform: group[0].agentPlatform,
      resources: this.agentResources.get(group[0].agentSocket),
      devices: group.map((s) => ({
        id: s.deviceId,
        name: s.deviceName,
        platform: s.devicePlatform,
        status: s.deviceStatus,
        osVersion: s.deviceOsVersion,
        sessionId: s.id,
        busy: s.browserSocket !== null,
      })),
    }))
  }
}
