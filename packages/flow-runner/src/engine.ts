import type { UIElement } from '@tapflowio/agent-core'
import type { Flow, Selector, Step, ScrollDirection } from './schema.js'
import { EnvironmentStepError, isEnvironmentStepFailure, TransientQueryError } from './errors.js'

// Transport-agnostic device surface the engine drives (DIP): the relay-backed
// implementation lives in RelayDriver, tests use fakes, and mcp-server adapts
// its own client. All coordinates are normalized 0-1.
export interface FlowDriver {
  // Optional AbortSignal so a stalled query can't block the poll loop past the step deadline.
  queryUITree(signal?: AbortSignal): Promise<UIElement[]>
  tap(x: number, y: number): Promise<void>
  swipe(from: [number, number], to: [number, number], durationMs: number): Promise<void>
  inputText(text: string): Promise<void>
  pressKey(code: string): Promise<void>
  openUrl(url: string): Promise<void>
  launchApp(): Promise<void>
  clearState(appId: string): Promise<void>
  screenshot(signal?: AbortSignal): Promise<Buffer>
}

export interface EngineOptions {
  defaultTimeoutMs?: number
  pollIntervalMs?: number
}

export interface StepResult {
  index: number
  name: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  message?: string
}

export interface FlowResult {
  name: string
  file?: string
  status: 'passed' | 'failed'
  steps: StepResult[]
  durationMs: number
  failureMessage?: string
  failureScreenshot?: Buffer
  /**
   * Which side failed: 'environment' for relay/agent/session-level causes (the CLI
   * exits 2), 'product' for selector, assertion and other failures (exit 1). Present
   * exactly when status is 'failed'. The engine is what classifies, so consumers
   * (CLI, MCP) never branch on prose.
   */
  failureKind?: 'environment' | 'product'
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_POLL_INTERVAL_MS = 500
const FAILURE_SCREENSHOT_TIMEOUT_MS = 10_000
const MAX_TIMER_MS = 2_147_483_647

// scroll direction = where the user wants to reveal more content, so the
// finger gesture goes the opposite way (scroll down → swipe up).
const SCROLL_GESTURES: Record<ScrollDirection, { from: [number, number]; to: [number, number] }> = {
  down: { from: [0.5, 0.7], to: [0.5, 0.3] },
  up: { from: [0.5, 0.3], to: [0.5, 0.7] },
  right: { from: [0.8, 0.5], to: [0.2, 0.5] },
  left: { from: [0.2, 0.5], to: [0.8, 0.5] },
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const round4 = (n: number): number => Math.round(n * 10000) / 10000

async function captureFailureScreenshot(driver: FlowDriver): Promise<Buffer | undefined> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      driver.screenshot(controller.signal),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve(undefined)
        }, FAILURE_SCREENSHOT_TIMEOUT_MS)
      }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function describeSelector(sel: Selector): string {
  if (sel.text !== undefined) return `"${sel.text}"`
  const parts: string[] = []
  if (sel.id !== undefined) parts.push(`id="${sel.id}"`)
  if (sel.label !== undefined) parts.push(`label="${sel.label}"`)
  if (sel.role !== undefined) parts.push(`role=${sel.role}`)
  if (sel.index !== undefined) parts.push(`index=${sel.index}`)
  return parts.join(', ')
}

function describeStep(step: Step): string {
  switch (step.type) {
    case 'clearState': return step.appId ? `clearState(${step.appId})` : 'clearState'
    case 'launchApp': return 'launchApp'
    case 'tapOn': return `tapOn(${describeSelector(step.selector)})`
    case 'inputText': return `inputText("${step.text}")`
    case 'pressKey': return `pressKey(${step.code})`
    case 'swipe': return `swipe(${step.from} → ${step.to})`
    case 'scroll': return `scroll(${step.direction})`
    case 'openUrl': return `openUrl(${step.url})`
    case 'assertVisible': return `assertVisible(${describeSelector(step.selector)})`
    case 'assertNotVisible': return `assertNotVisible(${describeSelector(step.selector)})`
  }
}

function normalizeTimeoutMs(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new EnvironmentStepError(`${label} must be a positive finite duration no greater than ${MAX_TIMER_MS}ms`)
  }
  const rounded = Math.round(value)
  if (rounded <= 0) {
    throw new EnvironmentStepError(`${label} must be at least 1ms (got ${value}ms, which rounds to 0ms)`)
  }
  return rounded
}

// Selector resolution: explicit id → identifier only; explicit label → exact then partial; bare text →
// exact identifier, then exact label, then partial label. role then narrows by element kind, and index
// (0-based) picks one of the remaining matches — so a label shared by e.g. a button and its inner text
// can be disambiguated with { label, role: button }, and a label-less row with { role: cell, index }.
export function matchSelector(tree: UIElement[], sel: Selector): UIElement[] {
  let pool: UIElement[]
  if (sel.text !== undefined) {
    const byId = tree.filter((e) => e.identifier === sel.text)
    const exact = tree.filter((e) => e.label === sel.text)
    pool = byId.length > 0
      ? byId
      : exact.length > 0
        ? exact
        : tree.filter((e) => sel.text !== undefined && sel.text.length > 0 && e.label.includes(sel.text))
  } else {
    pool = tree
    if (sel.id !== undefined) pool = pool.filter((e) => e.identifier === sel.id)
    if (sel.label !== undefined) {
      const label = sel.label
      const exact = pool.filter((e) => e.label === label)
      pool = exact.length > 0 ? exact : pool.filter((e) => e.label.includes(label))
    }
  }
  if (sel.role !== undefined) pool = pool.filter((e) => e.role === sel.role)
  if (sel.index !== undefined) {
    const el = pool[sel.index]
    return el ? [el] : []
  }
  return pool
}

class StepFailure extends Error {}

// Query the tree, surfacing a transient failure (foreground race, idle timeout, agent/network blip)
// so the polling caller keeps waiting until its deadline. Permanent failures propagate and fail now.
// The query is bounded by an AbortSignal set to the remaining deadline so a stalled response can't
// block the loop past the step's timeout.
async function queryOrRetry(
  driver: FlowDriver,
  deadline: number,
): Promise<{ tree: UIElement[] } | { transient: TransientQueryError }> {
  try {
    return { tree: await driver.queryUITree(AbortSignal.timeout(Math.max(1, deadline - Date.now()))) }
  } catch (e) {
    if (e instanceof TransientQueryError) return { transient: e }
    throw e
  }
}

function withLastError(base: string, lastError: TransientQueryError | undefined): string {
  return lastError ? `${base} (last query error: ${lastError.message})` : base
}

function queryDeadlineFailure(base: string, lastError: TransientQueryError | undefined): Error {
  const message = withLastError(base, lastError)
  return lastError
    ? new EnvironmentStepError(message, { cause: lastError })
    : new StepFailure(message)
}

async function waitForNextPoll(deadline: number, pollIntervalMs: number, base: string, lastError: TransientQueryError | undefined): Promise<void> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw queryDeadlineFailure(base, lastError)
  await delay(Math.min(pollIntervalMs, remaining))
  if (Date.now() >= deadline) throw queryDeadlineFailure(base, lastError)
}

async function resolveOne(
  driver: FlowDriver,
  sel: Selector,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<UIElement> {
  const waitMs = normalizeTimeoutMs(sel.timeoutMs ?? timeoutMs, 'selector timeout')
  const deadline = Date.now() + waitMs
  let lastError: TransientQueryError | undefined
  let sawTree = false
  for (;;) {
    const q = await queryOrRetry(driver, deadline)
    if ('tree' in q) {
      sawTree = true
      lastError = undefined // a successful query clears any earlier transient error
      const matches = matchSelector(q.tree, sel)
      if (matches.length === 1) return matches[0]
      if (matches.length > 1) {
        const described = matches.slice(0, 5).map((m) => `${m.role} "${m.label}"${m.identifier ? ` id=${m.identifier}` : ''}`).join(' | ')
        throw new StepFailure(`${matches.length} elements match ${describeSelector(sel)} — add an index or a more specific role/label (candidates: ${described})`)
      }
    } else {
      lastError = q.transient
    }
    const base = `no element matched ${describeSelector(sel)} within ${waitMs / 1000}s`
    // A trailing transient blip must not turn a product miss into an
    // environment failure: when a tree was seen, the element genuinely never
    // matched, so the deadline stays a StepFailure (product).
    if (Date.now() >= deadline) throw sawTree ? new StepFailure(withLastError(base, lastError)) : queryDeadlineFailure(base, lastError)
    await waitForNextPoll(deadline, pollIntervalMs, base, lastError)
  }
}

async function waitVisible(driver: FlowDriver, sel: Selector, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  const waitMs = normalizeTimeoutMs(sel.timeoutMs ?? timeoutMs, 'selector timeout')
  const deadline = Date.now() + waitMs
  let lastError: TransientQueryError | undefined
  let sawTree = false
  for (;;) {
    const q = await queryOrRetry(driver, deadline)
    if ('tree' in q) {
      sawTree = true
      lastError = undefined // a successful query clears any earlier transient error
      if (matchSelector(q.tree, sel).length > 0) return
    } else {
      lastError = q.transient
    }
    const base = `no element matched ${describeSelector(sel)} within ${waitMs / 1000}s`
    if (Date.now() >= deadline) throw sawTree ? new StepFailure(withLastError(base, lastError)) : queryDeadlineFailure(base, lastError)
    await waitForNextPoll(deadline, pollIntervalMs, base, lastError)
  }
}

async function waitNotVisible(driver: FlowDriver, sel: Selector, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  const waitMs = normalizeTimeoutMs(sel.timeoutMs ?? timeoutMs, 'selector timeout')
  const deadline = Date.now() + waitMs
  let lastError: TransientQueryError | undefined
  let sawTree = false
  for (;;) {
    const q = await queryOrRetry(driver, deadline)
    if ('tree' in q) {
      sawTree = true
      lastError = undefined // a successful query clears any earlier transient error
      if (matchSelector(q.tree, sel).length === 0) return
    } else {
      // A transient failure means we can't confirm the element is gone — keep polling, don't return.
      lastError = q.transient
    }
    const base = `element ${describeSelector(sel)} is still visible after ${waitMs / 1000}s`
    if (Date.now() >= deadline) throw sawTree ? new StepFailure(withLastError(base, lastError)) : queryDeadlineFailure(base, lastError)
    await waitForNextPoll(deadline, pollIntervalMs, base, lastError)
  }
}

async function executeStep(step: Step, flow: Flow, driver: FlowDriver, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  switch (step.type) {
    case 'clearState': {
      // `parseFlow` rejects the bare form without a flow-level appId, but `runFlow` is exported and does not
      // parse — an embedder can hand it a `Flow` built by hand, and `flow.appId!` used to launder that into
      // `app:clear-state` with `payload: {}` on the wire for the device to answer 'bundleId missing'. Refuse
      // here instead, where the cause is still nameable. Empty string too: `''` type-checks all the way down.
      const appId = step.appId ?? flow.appId
      if (!appId) throw new StepFailure('clearState has no app id — set it on the step or as the flow-level "appId"')
      await driver.clearState(appId)
      return
    }
    case 'launchApp': return driver.launchApp()
    case 'tapOn': {
      const el = await resolveOne(driver, step.selector, timeoutMs, pollIntervalMs)
      return driver.tap(round4(el.frame.x + el.frame.width / 2), round4(el.frame.y + el.frame.height / 2))
    }
    case 'inputText': return driver.inputText(step.text)
    case 'pressKey': return driver.pressKey(step.code)
    case 'swipe': return driver.swipe(step.from, step.to, step.durationMs)
    case 'scroll': {
      const g = SCROLL_GESTURES[step.direction]
      return driver.swipe(g.from, g.to, 300)
    }
    case 'openUrl': return driver.openUrl(step.url)
    case 'assertVisible': return waitVisible(driver, step.selector, timeoutMs, pollIntervalMs)
    case 'assertNotVisible': return waitNotVisible(driver, step.selector, timeoutMs, pollIntervalMs)
  }
}

export async function runFlow(flow: Flow, driver: FlowDriver, options: EngineOptions = {}): Promise<FlowResult> {
  const timeoutMs = normalizeTimeoutMs(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, 'default timeout')
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const started = Date.now()
  const steps: StepResult[] = []
  let failureMessage: string | undefined
  let failureKind: 'environment' | 'product' | undefined
  let failureScreenshot: Buffer | undefined

  for (const [index, step] of flow.steps.entries()) {
    const name = describeStep(step)
    if (failureMessage !== undefined) {
      steps.push({ index, name, status: 'skipped', durationMs: 0 })
      continue
    }
    const stepStart = Date.now()
    try {
      await executeStep(step, flow, driver, timeoutMs, pollIntervalMs)
      steps.push({ index, name, status: 'passed', durationMs: Date.now() - stepStart })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      failureMessage = `${name}: ${message}`
      if (failureKind === undefined) failureKind = isEnvironmentStepFailure(e) ? 'environment' : 'product'
      steps.push({ index, name, status: 'failed', durationMs: Date.now() - stepStart, message })
      failureScreenshot = await captureFailureScreenshot(driver)
    }
  }

  const result: FlowResult = {
    name: flow.name,
    status: failureMessage === undefined ? 'passed' : 'failed',
    steps,
    durationMs: Date.now() - started,
  }
  if (flow.file !== undefined) result.file = flow.file
  if (failureMessage !== undefined) result.failureMessage = failureMessage
  if (failureKind !== undefined) result.failureKind = failureKind
  if (failureScreenshot !== undefined) result.failureScreenshot = failureScreenshot
  return result
}
