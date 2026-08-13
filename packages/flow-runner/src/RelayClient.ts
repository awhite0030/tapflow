import { randomUUID } from 'node:crypto'
import type { BrowserToRelay, DeviceSummary, SessionStartFailure } from '@tapflowio/protocol'
import { WebSocket } from 'ws'
import type { UIElement } from '@tapflowio/agent-core'
import { PlatformError } from '@tapflowio/agent-core'
import { TransientQueryError } from './errors.js'

// Carries the HTTP status so ui-tree queries can tell a transient failure (retry) from a permanent one.
// status 0 marks a network-level failure (fetch rejected before a response).
class RelayHttpError extends PlatformError {
  constructor(message: string, readonly status: number, options?: ErrorOptions) {
    super(message, options)
  }
}

// Statuses that won't self-heal by polling: bad request, auth, missing session, device-not-booted
// (a flow always boots first, so mid-flow 409 is a dead device, not a race). Everything else
// (agent/foreground-race 502, idle-timeout 504, 5xx, network 0) is retryable.
const PERMANENT_QUERY_STATUSES = new Set([400, 401, 403, 404, 409])

// An input ack is a local round trip — the agent answers from its own dispatch, not from the device, which
// HID is fire-and-forget about. Generous next to `typeText`'s 15s because that one drives a paste handshake
// on the device; this one only has to cross the relay.
const INPUT_ACK_TIMEOUT_MS = 10_000

/**
 * A runtime mirror of `SessionStartFailure`, which `protocol` cannot export as a value — its main entry has
 * to erase under `import type`.
 *
 * `Record<SessionStartFailure, true>` rather than a `string[]`: the array form degrades silently when the
 * union grows, and this makes that a **compile error** in this file while still erasing to nothing at
 * runtime on protocol's side. `typeAssertions.ts` is the same idea one package over.
 */
const SESSION_START_FAILURES: Record<SessionStartFailure, true> = {
  'session-not-found': true,
  'session-busy': true,
  'agent-resources-exhausted': true,
}

// `Object.hasOwn`, not `in`: this reads a value off the wire, and a name that happens to be a prototype
// member would otherwise pass. The agents narrow key codes the same way for the same reason.
function isSessionStartFailure(v: unknown): v is SessionStartFailure {
  return typeof v === 'string' && Object.hasOwn(SESSION_START_FAILURES, v)
}

/**
 * A `session:start` the relay refused, carrying the machine-readable `reason` (#512, finding 2).
 *
 * The three want different responses, which is why the prose was never enough — but this class
 * deliberately does **not** rank them. A draft exposed a `retryable` getter that was true for
 * `session-busy` alone, and reading the relay refutes it in both directions: `session-busy` is another
 * browser socket being open (`handleSessionStart`), which is a person holding the device in the dashboard
 * and can last hours, while `agent-resources-exhausted` is a *sampled* CPU/memory reading over 80% — a
 * build spike that clears in seconds and is re-read on the next attempt. The transient one was the one
 * marked permanent.
 *
 * Ranking them needs to know whether the caller can wait and what else it could pick, which is the run's
 * business, not a transport method's. So the reason is reported and the policy stays with the caller.
 */
export class SessionJoinError extends PlatformError {
  constructor(message: string, readonly reason: SessionStartFailure | 'unknown', options?: ErrorOptions) {
    super(message, options)
  }
}

// Protocol owns the wire shape. The name stays `DeviceInfo` because it is exported from this
// package's public entry and `@tapflowio/cli` imports it — renaming would be a breaking change.
export type { DeviceSummary as DeviceInfo } from '@tapflowio/protocol'

export interface AgentSession {
  agentName?: string
  platform?: string
  devices: DeviceSummary[]
}

/** What arrives **from** the relay. Deliberately still loose, and that is a deferral rather than a decision —
 *  see #512. Narrowing it to `BrowserInbound` would check the reply predicates below (and would reject a live
 *  one: `error` is matched on a `sessionId` that member does not have), but it also makes `message: string`,
 *  which turns this file's `?? 'failed'` fallbacks into unreachable code. Deleting those while nothing
 *  validates inbound JSON removes a real defence, so the validators (#444) come first.
 *
 *  Outbound is `BrowserToRelay` — see `send` below. */
type RelayMsg = Record<string, unknown>

/**
 * Matches a reply whose correlator is **optional** — the lifecycle pair only. An absent `requestId` means
 * "this frame answers no request". Two ways that reaches this client, and only one is permanent: Android's
 * mid-session `device:boot-error` has no request behind it and never will, while an id-less `device:ready`
 * here can only be an agent predating the echo. Both are accepted and logged rather than dropped. The
 * relay's replayed `device:ready` does not arrive here at all — no `sessionId`, so the comparison ahead of
 * this call excludes it, which the "not satisfied by the replay" test pins. A present
 * one must match. Not that it tells two concurrent boots apart — the agents answer a superseded boot not
 * at all (`bootSeq`), so one waiter times out either way. `dispatch` resolves the first matching waiter and
 * stops, so on `sessionId` + type alone the single reply went to whichever boot registered first, and the
 * boot that actually happened was the one that timed out. The correlator fixes the attribution.
 *
 * Deliberately not used for the app commands, whose correlator is required: lending them this fallback
 * would restore the ambiguity that work removed. See protocol/AGENTS.md.
 */
function correlatesWith(msg: RelayMsg, requestId: string): boolean {
  const id = msg['requestId']
  if (id === undefined) {
    console.error(`[tapflow] ${String(msg['type'])} carried no requestId — matched on sessionId instead`)
    return true
  }
  return id === requestId
}

interface Waiter {
  predicate: (msg: RelayMsg) => boolean
  resolve: (msg: RelayMsg) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Minimal relay client for the deterministic runner: WebSocket for session and
// input control, REST for ui-tree and screenshots. Mirrors the message shapes
// the dashboard and mcp-server already use.
export class RelayClient {
  private ws: WebSocket | null = null
  private waiters: Waiter[] = []

  constructor(
    private readonly relayUrl: string,
    private readonly token: string,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers = this.token ? { Authorization: `Bearer ${this.token}` } : undefined
      const ws = new WebSocket(this.relayUrl, { headers })
      ws.once('open', () => {
        this.ws = ws
        resolve()
      })
      ws.once('error', (e) => reject(new PlatformError(`relay connection failed: ${(e as Error).message}`)))
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        try {
          this.dispatch(JSON.parse((data as Buffer).toString()) as RelayMsg)
        } catch { /* ignore malformed */ }
      })
      ws.on('close', () => {
        this.ws = null
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer)
          w.reject(new PlatformError('relay connection closed'))
        }
      })
    })
  }

  disconnect(): void {
    this.ws?.close()
    this.ws = null
  }

  private addressSkewLogged = false
  private readonly inputSilenceLogged = new Set<string>()

  /**
   * Says out loud that an input went unanswered, once per session.
   *
   * Two causes and the client cannot tell them apart, which is exactly why it has to name both: an agent
   * predating input correlation answers with no `requestId`, so its ack matches nothing here and every input
   * in the run burns the deadline; or a current agent is simply slow, in which case the input landed. The
   * step's own failure says neither, and this file already logs the equivalent skew for the join
   * (`addressSkewLogged`) and for id-less lifecycle replies — the input path was the only one failing hard
   * and silently.
   *
   * Per **session**, unlike the join's per-client flag: one flow can address several, and a slow first input
   * after a boot is a per-session event.
   */
  private warnInputAckSilence(sessionId: string): void {
    if (this.inputSilenceLogged.has(sessionId)) return
    this.inputSilenceLogged.add(sessionId)
    console.error(
      `[tapflow] an input on session ${sessionId} went unanswered for ${INPUT_ACK_TIMEOUT_MS}ms. Either the ` +
      'agent predates input correlation (its acks carry no requestId and will never match), or it is slow — ' +
      'in which case the input did land. Upgrade the agent to tell the two apart.',
    )
  }

  private dispatch(msg: RelayMsg): void {
    if (msg['type'] === 'error' && typeof msg['sessionId'] !== 'string' && !this.addressSkewLogged) {
      // A relay older than L5d. The refusal matches no waiter, so the join times out with no reason — this is
      // the only trace. One flow run holds one client, so once is once.
      this.addressSkewLogged = true
      console.error(
        '[tapflow] a session:start refusal carried no sessionId — this relay predates addressed errors, so a ' +
        'refused join times out rather than reporting why. Upgrade the relay.',
      )
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

  /** Typed against the wire contract, so every literal below is checked. It used to take `RelayMsg`, which is
   *  `Record<string, unknown>` — the shape that let #489 and #490 happen on the agent side, and the reason
   *  `mcp-server`'s equivalent was typed in `7637be3`. */
  private send(msg: BrowserToRelay): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new PlatformError('not connected to relay')
    }
    this.ws.send(JSON.stringify(msg))
  }

  private waitFor(predicate: (msg: RelayMsg) => boolean, timeoutMs: number, what: string): Promise<RelayMsg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve)
        if (idx !== -1) this.waiters.splice(idx, 1)
        reject(new PlatformError(`${what} timed out`))
      }, timeoutMs)
      this.waiters.push({ predicate, resolve, reject, timer })
    })
  }

  async listDevices(): Promise<AgentSession[]> {
    this.send({ type: 'agents:list' })
    const msg = await this.waitFor((m) => m['type'] === 'agents:listed', 5_000, 'agents:list')
    return (msg['sessions'] as AgentSession[]) ?? []
  }

  async joinSession(sessionId: string): Promise<void> {
    this.send({ type: 'session:start', sessionId })
    const msg = await this.waitFor(
      (m) =>
        (m['type'] === 'session:joined' && m['sessionId'] === sessionId) ||
        // No `=== undefined` escape — see the twin in `mcp-server`. `error` carries an address as of L5d, and
        // the escape *was* #512's first finding: with no such key the left half was always true, so any
        // refusal resolved any pending join. The cost is version skew — a client newer than its relay sees
        // unaddressed refusals, which match nothing, so the join burns its deadline instead of reporting why
        // it was refused. Taken deliberately: there is no version handshake in this protocol, and the
        // alternative is a fallback, which is the ambiguity this work removes. Logged once per **client**,
        // not per session — a relay is per client, and the frame carries no session to key on anyway.
        (m['type'] === 'error' && m['sessionId'] === sessionId),
      5_000,
      'session join',
    )
    if (msg['type'] !== 'error') return
    // `reason` is what #506 added this field for: the dashboard was branching on the free prose, handled two
    // of the three wordings, and dropped `Session busy` silently. This client was still reading the prose.
    // It is **required** on `GenericError` — single producer, three sites in the relay's `handleSessionStart`
    // — so `unknown` here means a relay predating it, not a legitimate absence.
    const reason = msg['reason']
    throw new SessionJoinError(
      `session join refused (${typeof reason === 'string' ? reason : 'unknown'}): ${(msg['message'] as string) ?? 'no detail'}`,
      isSessionStartFailure(reason) ? reason : 'unknown',
    )
  }

  leaveSession(sessionId: string): void {
    this.send({ type: 'session:leave', sessionId })
  }

  async bootDevice(sessionId: string, deviceId: string): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'device:boot', sessionId, requestId, payload: { deviceId } })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'device:ready' || m['type'] === 'device:boot-error') && m['sessionId'] === sessionId && correlatesWith(m, requestId),
      120_000,
      'device boot',
    )
    if (msg['type'] === 'device:boot-error') throw new PlatformError((msg['message'] as string) ?? 'boot failed')
  }

  async installApp(sessionId: string, buildId: number): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'app:install', sessionId, requestId, buildId })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'app:install-done' || m['type'] === 'app:install-error') && m['requestId'] === requestId,
      120_000,
      'app install',
    )
    if (msg['type'] === 'app:install-error') throw new PlatformError((msg['message'] as string) ?? 'install failed')
  }

  async launchApp(sessionId: string, buildId: number): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'app:launch', sessionId, requestId, buildId })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'app:launch-done' || m['type'] === 'app:launch-error') && m['requestId'] === requestId,
      30_000,
      'app launch',
    )
    if (msg['type'] === 'app:launch-error') throw new PlatformError((msg['message'] as string) ?? 'launch failed')
  }

  async clearState(sessionId: string, bundleId: string): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'app:clear-state', sessionId, requestId, payload: { bundleId } })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'app:clear-state-done' || m['type'] === 'app:clear-state-error') && m['requestId'] === requestId,
      30_000,
      'clear state',
    )
    if (msg['type'] === 'app:clear-state-error') throw new PlatformError((msg['message'] as string) ?? 'clear state failed')
  }

  // The correlator these mint is now read. It always was on the wire — the terminal frame declares it
  // required because the relay gates on it and every ack echoes it — and this waiter is what it was minted
  // for (#512, finding 3).
  //
  // The **opening and move frames carry none**, and that is the contract rather than an omission: nothing
  // acks them, so an id there would name a waiter that does not exist.
  async tap(sessionId: string, x: number, y: number): Promise<void> {
    const payload = { x, y }
    const requestId = randomUUID()
    this.send({ type: 'input:touch:start', sessionId, payload })
    this.send({ type: 'input:touch:end', sessionId, requestId, payload })
    await this.awaitInputAck(sessionId, requestId, 'tap')
  }

  async swipe(sessionId: string, from: [number, number], to: [number, number], durationMs: number): Promise<void> {
    const STEPS = 8
    const interval = durationMs / STEPS
    const requestId = randomUUID()
    this.send({ type: 'input:touch:start', sessionId, payload: { x: from[0], y: from[1] } })
    for (let i = 1; i < STEPS; i++) {
      await delay(interval)
      const t = i / STEPS
      this.send({
        type: 'input:touch:move',
        sessionId,
        payload: { x: from[0] + (to[0] - from[0]) * t, y: from[1] + (to[1] - from[1]) * t },
      })
    }
    await delay(interval)
    this.send({ type: 'input:touch:end', sessionId, requestId, payload: { x: to[0], y: to[1] } })
    await this.awaitInputAck(sessionId, requestId, 'swipe')
  }

  async typeText(sessionId: string, text: string): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'input:type', sessionId, requestId, payload: { text } })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'input:type-done' || m['type'] === 'input:type-error')
        && m['sessionId'] === sessionId && m['requestId'] === requestId,
      15_000,
      'type text',
    )
    if (msg['type'] === 'input:type-error') throw new PlatformError((msg['message'] as string) ?? 'type text failed')
  }

  async pressKey(sessionId: string, code: string): Promise<void> {
    const requestId = randomUUID()
    this.send({ type: 'input:key', sessionId, requestId, payload: { code, modifiers: 0 } })
    await this.awaitInputAck(sessionId, requestId, `pressKey ${code}`)
  }

  /**
   * Waits for the terminal input's ack and turns a refusal into the step's failure, with the reason on it.
   *
   * Without this a refused input was reported as a **UI** problem: the tap landed nowhere, the next
   * `assertVisible` polled until its own deadline, and the flow failed with "selector not found". For a test
   * runner that is the worst place to lose a cause.
   *
   * What this fixes is the **message**, not the classification. `runFlow` catches every throw from a step as
   * `status: 'failed'` and the CLI maps any failed flow to exit 1, so a refusal whose reason is entirely
   * environmental — `not-booted`, `channel-unavailable`, `not-session-owner`, which the relay raises before an
   * agent ever sees the frame — still leaves CI a flow failure rather than the exit 2 this package's
   * AGENTS.md reserves for it. Routing it there means a failure kind the engine can distinguish, which is a
   * separate slice; naming the reason is the prerequisite either way.
   *
   * **No automatic retry, deliberately.** `channel-starting` is the reason that would succeed 200ms later, and
   * retrying it here would be one line — but the retry belongs to whoever owns the step's timeout, not to a
   * transport method that cannot see it. `RelayDriver` is where a policy would go. Naming the reason is what
   * makes that decision possible at all; today it is not even visible.
   *
   * **Silence fails the step, but it is never reported as a drop.** A draft said silence "means an agent older
   * than the ack contract"; that is false and the repo already records why. `IOSAgent.ackInput` awaits an
   * `isBooted` verify — an untimed `simctl list` — on the first input after a boot or reconnect, on the same
   * Mac the relay gates at 80% CPU, so **an ack past this window can belong to an input that did land.**
   * `mcp-server` answers that with "could not confirm" and never with "dropped" (#457), and the reasoning
   * transfers: a flow cannot continue on an unconfirmed input the way an LLM can re-observe the screen, so
   * the step fails — but "tap timed out" reads as *the tap did not happen*, which is the same false certainty
   * this change exists to remove with the sign flipped.
   */
  private async awaitInputAck(sessionId: string, requestId: string, what: string): Promise<void> {
    let msg: RelayMsg
    try {
      msg = await this.waitFor(
        (m) => (m['type'] === 'input:done' || m['type'] === 'input:error')
          && m['sessionId'] === sessionId && m['requestId'] === requestId,
        INPUT_ACK_TIMEOUT_MS,
        what,
      )
    } catch (e) {
      this.warnInputAckSilence(sessionId)
      throw new PlatformError(
        `${what} was not confirmed (${(e as Error).message}) — it may have reached the device, so do not ` +
        'repeat it blindly',
        { cause: e },
      )
    }
    if (msg['type'] !== 'input:error') return
    // `reason` is optional on the wire and absent means *unknown*, never *fine* — an agent predating the
    // field. Absent, or a member this build does not know, both read as `channel-unavailable`, which is the
    // conservative one (protocol/AGENTS.md).
    const reason = typeof msg['reason'] === 'string' ? msg['reason'] : 'channel-unavailable'
    throw new PlatformError(`${what} was refused by the device (${reason}): ${(msg['message'] as string) ?? 'no detail'}`)
  }

  async openUrl(sessionId: string, url: string): Promise<void> {
    // Correlated by `requestId`, not by `sessionId` + type. Two `open-url` calls on one session are
    // sequential today (the engine awaits each step), so this changes nothing observable here — it is
    // the pattern the remaining pairs follow, and the input acks are where it stops being cosmetic.
    const requestId = randomUUID()
    this.send({ type: 'open-url', sessionId, requestId, payload: { url } })
    const msg = await this.waitFor(
      (m) => (m['type'] === 'open-url:done' || m['type'] === 'open-url:error') && m['requestId'] === requestId,
      15_000,
      'open url',
    )
    if (msg['type'] === 'open-url:error') throw new PlatformError((msg['message'] as string) ?? 'open url failed')
  }

  private httpBase(): string {
    return this.relayUrl.replace(/^wss?/, (p) => (p === 'wss' ? 'https' : 'http'))
  }

  private async getJson<T>(path: string, what: string, signal?: AbortSignal): Promise<T> {
    let res: Response
    try {
      res = await fetch(new URL(path, this.httpBase()).toString(), {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
        signal,
      })
    } catch (e) {
      throw new RelayHttpError(`${what} failed: ${(e as Error).message}`, 0, { cause: e })
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let message = text || `${what} failed: ${res.status}`
      try {
        const body = JSON.parse(text) as { error?: string }
        if (body.error) message = body.error
      } catch { /* keep raw text */ }
      throw new RelayHttpError(message, res.status)
    }
    return (await res.json()) as T
  }

  async queryUITree(sessionId: string, signal?: AbortSignal): Promise<UIElement[]> {
    try {
      const body = await this.getJson<{ elements?: UIElement[] }>(`/api/v1/sessions/${sessionId}/ui-tree`, 'ui-tree query', signal)
      return body.elements ?? []
    } catch (e) {
      // A retryable condition (foreground race, idle timeout, agent blip, network) → let the runner
      // poll again until the step deadline. Permanent failures keep their type and fail the step now.
      if (e instanceof RelayHttpError && !PERMANENT_QUERY_STATUSES.has(e.status)) {
        throw new TransientQueryError(e.message, { cause: e })
      }
      throw e
    }
  }

  async screenshot(sessionId: string): Promise<Buffer> {
    const res = await fetch(new URL(`/api/v1/sessions/${sessionId}/screenshot`, this.httpBase()).toString(), {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
    })
    if (!res.ok) throw new PlatformError(`screenshot failed: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
}
