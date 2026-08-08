import type { BrowserToRelay, InputErrorReason } from '@tapflowio/protocol'
import { WebSocket } from 'ws'

export interface DeviceInfo {
  id: string
  name: string
  platform: string
  status: string
  osVersion?: string
  sessionId: string
  busy: boolean
}

export interface AgentSession {
  agentName?: string
  platform?: string
  devices: DeviceInfo[]
}

export interface BuildInfo {
  id: number
  versionName: string
  buildNumber: string
  platform: string
  statusLabel: string | null
  createdAt: string
}

export interface AppInfo {
  id: number
  name: string
  bundleId: string
  platform: string
  builds: BuildInfo[]
}

// Unified element schema produced agent-side (mirrors @tapflowio/agent-core UIElement).
// Frames are normalized 0-1 in the same coordinate space the tap path consumes.
export interface UIElement {
  role: 'button' | 'text' | 'input' | 'image' | 'checkbox' | 'switch' | 'slider' | 'list' | 'cell' | 'tab' | 'other'
  label: string
  identifier?: string
  frame: { x: number; y: number; width: number; height: number }
  enabled: boolean
  rawRole?: string
}

type RelayMsg = Record<string, unknown>

interface Waiter {
  predicate: (msg: RelayMsg) => boolean
  resolve: (msg: RelayMsg) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * What the caller should do about a refused input, keyed by the wire reason.
 *
 * The caller here is a language model, so this is advice rather than a machine action — and that is
 * the decision, not a limitation. An automatic retry inside this client would hide a duplicate-input
 * hazard from the only party able to judge it: `no-gesture` in particular can mean either "nothing
 * reached the device" or "the opening frames already landed and only the last was refused", and the
 * wire cannot tell them apart (see the note on tapflow#491). A client that retried would sometimes
 * apply a drag twice with nobody able to see that it had. `TapflowClient` also drives `run_flow`, so
 * a retry here would make deterministic replay non-deterministic.
 */
export const REASON_ADVICE: Record<InputErrorReason, string> = {
  'not-booted': 'The device is not running. Call boot_device for this session before sending input.',
  'channel-unavailable': 'The input channel is gone. Reconnect the session before sending more input; repeating this input will not help.',
  'channel-starting': 'The input channel is still coming up. The same input is safe to send again in a moment.',
  // Deliberately stricter than the protocol table, which says "may retry once". The only producer is
  // Android's pointer dispatch, and `android-agent/AGENTS.md` records what the call deadline does and
  // does not buy: it cancels our call, not a request the emulator already applied, so the case it
  // actually fires in is a connected-but-unresponsive emulator where "did it land" is unknowable and
  // "a caller that retries on the error can double it". That analysis postdates and corrects the
  // source comment on `dispatchTo`, which still reads "safe to retry". Which of the two the protocol
  // table should follow is open (tapflow#491); until it is settled the advice a model acts on takes
  // the side that cannot double an input.
  'dispatch-failed': 'The device rejected the input, and whether it landed is not knowable. Do not repeat it.',
  unsupported: 'This input is not supported on the active connection to the device. Do not retry it.',
  malformed: 'The message did not carry what the input needs. This is a bug in tapflow rather than something to retry.',
  'no-gesture': 'The gesture this input was completing is gone. Part of it may already have been applied to the device, so repeating it may duplicate what landed.',
}

export function reasonAdvice(reason: string | undefined): string {
  // Absent or unrecognised resolves to `channel-unavailable`, per the protocol's conservative rule.
  // `Object.hasOwn`, not `in`: a reason of `toString` would otherwise return a function.
  const key: InputErrorReason =
    reason !== undefined && Object.hasOwn(REASON_ADVICE, reason)
      ? (reason as InputErrorReason)
      : 'channel-unavailable'
  return REASON_ADVICE[key]
}

export class TapflowClient {
  private ws: WebSocket | null = null
  private waiters: Waiter[] = []
  /** Sessions that have answered at least one input. See `awaitInputAck`. */
  private ackedSessions = new Set<string>()

  constructor(
    private readonly relayUrl: string,
    readonly token: string,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.relayUrl)
      ws.once('open', () => {
        this.ws = ws
        resolve()
      })
      ws.once('error', reject)
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        try {
          const msg = JSON.parse((data as Buffer).toString()) as RelayMsg
          this.dispatch(msg)
        } catch { /* ignore malformed */ }
      })
      ws.on('close', () => {
        this.ws = null
        const pending = this.waiters.splice(0)
        for (const w of pending) {
          clearTimeout(w.timer)
          w.reject(new Error('WebSocket closed'))
        }
      })
    })
  }

  disconnect(): void {
    this.ws?.close()
    this.ws = null
  }

  private dispatch(msg: RelayMsg): void {
    // `input:done` only, and that is load-bearing: the **relay** originates `input:error` to this very
    // socket for a terminal input it cannot dispatch (`RelayServer.ts`, `'agent offline'` /
    // `'Session not found'`, both `channel-unavailable`). Counting those would let one agent-offline
    // blip — or an input for a session this client never joined — mark a session as acking when its
    // agent may never have answered anything, and every later input would then be reported as
    // unconfirmed on the strength of evidence the agent did not produce. Nothing in the relay
    // originates an `input:done`, so that one is the agent's word and no one else's.
    //
    // Recorded here rather than where the ack is awaited, because the ack that teaches us the most is
    // the one that arrives *late*: it missed its window, was reported optimistically, and still proves
    // this agent acks — so the next input can be judged strictly. A ledger kept at the waiter would
    // never see it.
    if (msg['type'] === 'input:done') {
      const sid = msg['sessionId']
      if (typeof sid === 'string') this.ackedSessions.add(sid)
    }
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i].predicate(msg)) {
        const [w] = this.waiters.splice(i, 1)
        clearTimeout(w.timer)
        w.resolve(msg)
        return
      }
    }
  }

  private send(msg: BrowserToRelay): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to relay')
    }
    this.ws.send(JSON.stringify(msg))
  }

  private waitFor(predicate: (msg: RelayMsg) => boolean, timeoutMs: number): Promise<RelayMsg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve)
        if (idx !== -1) this.waiters.splice(idx, 1)
        reject(new Error('Request timed out'))
      }, timeoutMs)
      this.waiters.push({ predicate, resolve, reject, timer })
    })
  }

  async listDevices(): Promise<AgentSession[]> {
    this.send({ type: 'agents:list' })
    const msg = await this.waitFor((m) => m['type'] === 'agents:listed', 5_000)
    return (msg['sessions'] as AgentSession[]) ?? []
  }

  async connectDevice(sessionId: string): Promise<void> {
    this.send({ type: 'session:start', sessionId })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'session:joined' && m['sessionId'] === sessionId) ||
        (m['type'] === 'error' && (m['sessionId'] === undefined || m['sessionId'] === sessionId)),
      5_000,
    )
    if (msg['type'] === 'error') throw new Error((msg['message'] as string) ?? 'Connect failed')
  }

  disconnectDevice(sessionId: string): void {
    this.send({ type: 'session:leave', sessionId })
  }

  async bootDevice(sessionId: string, deviceId: string): Promise<void> {
    this.send({ type: 'device:boot', sessionId, payload: { deviceId } })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'device:ready' || m['type'] === 'device:boot-error') &&
        m['sessionId'] === sessionId,
      30_000,
    )
    if (msg['type'] === 'device:boot-error') {
      throw new Error((msg['message'] as string) ?? 'Boot failed')
    }
  }

  // Powers the session's booted device down (agent runs simctl/adb shutdown, replies device:shutdown-done).
  // payload carries deviceId, matching the agent handler and the relay's own shutdown path. There is no
  // shutdown-error message: Android replies done regardless, iOS surfaces a failed shutdown as a wait timeout.
  async shutdownDevice(sessionId: string, deviceId: string): Promise<void> {
    this.send({ type: 'device:shutdown', sessionId, payload: { deviceId } })
    await this.waitFor(
      (m) => m['type'] === 'device:shutdown-done' && m['sessionId'] === sessionId,
      30_000,
    )
  }

  /**
   * Awaits the agent's terminal-input ack, sent on the gesture's last message.
   *
   * Silence used to be reported as **success**: the fallback existed for agents predating the ack
   * protocol, and it outlived them, so a tap that never reached the device was reported as landed to a
   * model that then moved on (#457).
   *
   * Two things make the fix honest.
   *
   * **Silence is answered with "could not confirm", never with "dropped".** `ackInput` awaits a
   * `simctl list` / `adb` device verify on the first input after a boot or reconnect, on the same Mac
   * the relay gates at 80% CPU — so an ack past the window can belong to an input that *did* land.
   * Calling that a drop invites a retry, and a retry of a landed input duplicates it.
   *
   * **Whether silence is fatal is decided by what this session has already done**, not by a
   * negotiated flag. If it has answered an input before, the agent demonstrably acks and later silence
   * is a real anomaly. If it never has, this is an agent that does not ack at all and the optimistic
   * path is correct for it. That degrades in the safe direction and needs nothing on the wire — where
   * a capability flag would have to be advertised, kept in step across both agents, and then live
   * forever as an inert field once every install has it.
   *
   * The residual gap is any session that has never had an answer — usually just its first input, but
   * **not bounded to one**: an agent whose acks never arrive at all keeps the optimistic path
   * indefinitely, and #457 is unchanged for it. What the gate buys is that the moment a session answers
   * once, silence after that is reported. Closing the rest needs something that distinguishes "does not
   * ack" from "did not ack this time", which per-input acks cannot express on their own.
   *
   * One thing this does **not** fix: an ack carries no correlation id, so the predicate below matches
   * any ack for the session. An ack that arrives after its own input timed out is consumed by the next
   * input's waiter, which then reports the previous input's outcome. Recorded as a known gap rather than
   * papered over — see the issue linked from `AGENTS.md`.
   */
  private async awaitInputAck(sessionId: string): Promise<void> {
    const strict = this.ackedSessions.has(sessionId)
    let msg: RelayMsg
    try {
      msg = await this.waitFor(
        (m) =>
          (m['type'] === 'input:done' || m['type'] === 'input:error') &&
          m['sessionId'] === sessionId,
        2_000,
      )
    } catch (e) {
      // A WebSocket close (or any error that is not the timeout) means the input was not dispatched.
      if (!(e instanceof Error) || e.message !== 'Request timed out') throw e
      if (!strict) return
      throw new Error(
        'Could not confirm the input reached the device: this session has acknowledged input before, ' +
        'and this one went unanswered. Do not repeat the input — it may have landed. Check the device ' +
        'state (screenshot or ui_tree) before deciding what to do next.',
      )
    }
    if (msg['type'] === 'input:error') {
      const reason = msg['reason'] as string | undefined
      const prose = (msg['message'] as string) ?? 'Input failed'
      throw new Error(`${prose}${reason ? ` (${reason})` : ''} — ${reasonAdvice(reason)}`)
    }
  }

  async tap(sessionId: string, x: number, y: number): Promise<void> {
    const payload = { x, y }
    this.send({ type: 'input:touch:start', sessionId, payload })
    this.send({ type: 'input:touch:end', sessionId, payload })
    await this.awaitInputAck(sessionId)
  }

  async swipe(
    sessionId: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    durationMs = 300,
  ): Promise<void> {
    const STEPS = 8
    const interval = durationMs / STEPS

    this.send({ type: 'input:touch:start', sessionId, payload: { x: startX, y: startY } })
    for (let i = 1; i < STEPS; i++) {
      await delay(interval)
      const t = i / STEPS
      // coordinates here are normalized 0-1 — rounding would snap every
      // intermediate move to a screen edge
      this.send({
        type: 'input:touch:move',
        sessionId,
        payload: {
          x: startX + (endX - startX) * t,
          y: startY + (endY - startY) * t,
        },
      })
    }
    await delay(interval)
    this.send({ type: 'input:touch:end', sessionId, payload: { x: endX, y: endY } })
    await this.awaitInputAck(sessionId)
  }

  // Awaits the agent's ack so a following input (e.g. pressKey Enter) is sent
  // only after the text has landed — the paste/adb write runs async agent-side.
  async typeText(sessionId: string, text: string): Promise<void> {
    this.send({ type: 'input:type', sessionId, payload: { text } })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'input:type-done' || m['type'] === 'input:type-error') &&
        m['sessionId'] === sessionId,
      15_000,
    )
    if (msg['type'] === 'input:type-error') {
      throw new Error((msg['message'] as string) ?? 'Type text failed')
    }
  }

  // Agents consume KeyboardEvent.code names ({ code, modifiers }) on input:key.
  // 'Return' is accepted as an alias — neither platform maps it, 'Enter' is the code.
  async pressKey(sessionId: string, key: string): Promise<void> {
    const code = key === 'Return' ? 'Enter' : key
    this.send({ type: 'input:key', sessionId, payload: { code, modifiers: 0 } })
    await this.awaitInputAck(sessionId)
  }

  // Agents consume { name, phase? } on input:button; a phase-less message is a
  // single press on both platforms (iOS 'home' is legacy-pressed once, chrome
  // buttons and Android BUTTON_KEY_MAP names resolve by name).
  async pressButton(sessionId: string, button: string): Promise<void> {
    this.send({ type: 'input:button', sessionId, payload: { name: button } })
    await this.awaitInputAck(sessionId)
  }

  async openUrl(sessionId: string, url: string): Promise<void> {
    this.send({ type: 'open-url', sessionId, payload: { url } })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'open-url:done' || m['type'] === 'open-url:error') &&
        m['sessionId'] === sessionId,
      15_000,
    )
    if (msg['type'] === 'open-url:error') {
      throw new Error((msg['message'] as string) ?? 'Open URL failed')
    }
  }

  async clearState(sessionId: string, bundleId: string): Promise<void> {
    this.send({ type: 'app:clear-state', sessionId, payload: { bundleId } })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'app:clear-state-done' || m['type'] === 'app:clear-state-error') &&
        m['sessionId'] === sessionId,
      30_000,
    )
    if (msg['type'] === 'app:clear-state-error') {
      throw new Error((msg['message'] as string) ?? 'Clear state failed')
    }
  }

  async installApp(sessionId: string, buildId: number): Promise<void> {
    this.send({ type: 'app:install', sessionId, buildId })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'app:install-done' || m['type'] === 'app:install-error') &&
        m['sessionId'] === sessionId,
      60_000,
    )
    if (msg['type'] === 'app:install-error') {
      throw new Error((msg['message'] as string) ?? 'Install failed')
    }
  }

  async launchApp(sessionId: string, buildId: number): Promise<void> {
    this.send({ type: 'app:launch', sessionId, buildId })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'app:launch-done' || m['type'] === 'app:launch-error') &&
        m['sessionId'] === sessionId,
      15_000,
    )
    if (msg['type'] === 'app:launch-error') {
      throw new Error((msg['message'] as string) ?? 'Launch failed')
    }
  }

  async screenshot(sessionId: string, format: 'png' | 'jpeg' = 'png'): Promise<Buffer> {
    const httpBase = this.relayUrl.replace(/^wss?/, (p) => (p === 'wss' ? 'https' : 'http'))
    const url = new URL(`/api/v1/sessions/${sessionId}/screenshot`, httpBase)
    if (format === 'jpeg') url.searchParams.set('format', 'jpeg')
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) {
      // Read text first — res.json() consumes the body, so a later res.text()
      // fallback can never run after a failed JSON parse.
      const text = await res.text().catch(() => '')
      let message = text || `Screenshot failed: ${res.status}`
      try {
        const body = JSON.parse(text) as { error?: string }
        if (body.error) message = body.error
      } catch { /* keep the raw text */ }
      throw new Error(message)
    }
    return Buffer.from(await res.arrayBuffer())
  }

  async queryUITree(sessionId: string): Promise<UIElement[]> {
    const httpBase = this.relayUrl.replace(/^wss?/, (p) => (p === 'wss' ? 'https' : 'http'))
    const url = new URL(`/api/v1/sessions/${sessionId}/ui-tree`, httpBase)
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) {
      // Read text first — res.json() consumes the body, so a later res.text()
      // fallback can never run after a failed JSON parse.
      const text = await res.text().catch(() => '')
      let message = text || `UI tree query failed: ${res.status}`
      try {
        const body = JSON.parse(text) as { error?: string }
        if (body.error) message = body.error
      } catch { /* keep the raw text */ }
      throw new Error(message)
    }
    const body = (await res.json()) as { elements?: UIElement[] }
    return body.elements ?? []
  }

  async listBuilds(): Promise<AppInfo[]> {
    const httpBase = this.relayUrl.replace(/^wss?/, (p) => (p === 'wss' ? 'https' : 'http'))
    const headers = { Authorization: `Bearer ${this.token}` }

    const appsRes = await fetch(new URL('/api/v1/apps', httpBase).toString(), { headers })
    if (!appsRes.ok) throw new Error(`Failed to fetch apps: ${appsRes.status}`)
    // GET /apps → { items } (unpaginated); the bundle id column is bundle_id_key.
    const apps = ((await appsRes.json()) as { items?: Array<{ id: number; name: string; bundle_id_key: string; platform: string }> }).items ?? []

    // GET /builds is paginated (limit ≤ 100, default 20) — page through `total`
    // so list_builds returns every build, not just the newest page.
    type RawBuild = {
      id: number
      app_id: number
      version_name: string
      build_number: string
      platform: string
      status_label: string | null
      uploaded_at: string
    }
    const builds: RawBuild[] = []
    for (let page = 0; ; page++) {
      const url = new URL('/api/v1/builds', httpBase)
      url.searchParams.set('limit', '100')
      url.searchParams.set('page', String(page))
      const res = await fetch(url.toString(), { headers })
      if (!res.ok) throw new Error(`Failed to fetch builds: ${res.status}`)
      const body = (await res.json()) as { items?: RawBuild[]; total?: number }
      const items = body.items ?? []
      builds.push(...items)
      if (items.length === 0 || builds.length >= (body.total ?? builds.length)) break
    }

    return apps.map((app) => ({
      id: app.id,
      name: app.name,
      bundleId: app.bundle_id_key,
      platform: app.platform,
      builds: builds
        .filter((b) => b.app_id === app.id)
        .map((b) => ({
          id: b.id,
          versionName: b.version_name,
          buildNumber: b.build_number,
          platform: b.platform,
          statusLabel: b.status_label,
          createdAt: b.uploaded_at,
        })),
    }))
  }
}
