import { describe, it, expect, vi } from 'vitest'
import { PlatformError, type UIElement } from '@tapflowio/agent-core'
import { runFlow, type FlowDriver } from '../engine.js'
import { parseFlow } from '../schema.js'
import { EnvironmentStepError, TransientQueryError } from '../errors.js'

const el = (over: Partial<UIElement>): UIElement => ({
  role: 'button',
  label: '',
  frame: { x: 0.25, y: 0.5, width: 0.5, height: 0.1 },
  enabled: true,
  ...over,
})

// trees: sequence of queryUITree results; the last one repeats.
function fakeDriver(trees: UIElement[][]): FlowDriver & { calls: Array<[string, ...unknown[]]> } {
  let i = 0
  const calls: Array<[string, ...unknown[]]> = []
  return {
    calls,
    queryUITree: vi.fn(async () => trees[Math.min(i++, trees.length - 1)]),
    tap: vi.fn(async (x: number, y: number) => { calls.push(['tap', x, y]) }),
    swipe: vi.fn(async (from: [number, number], to: [number, number], durationMs: number) => {
      calls.push(['swipe', from, to, durationMs])
    }),
    inputText: vi.fn(async (text: string) => { calls.push(['inputText', text]) }),
    pressKey: vi.fn(async (code: string) => { calls.push(['pressKey', code]) }),
    openUrl: vi.fn(async (url: string) => { calls.push(['openUrl', url]) }),
    launchApp: vi.fn(async () => { calls.push(['launchApp']) }),
    clearState: vi.fn(async (appId: string) => { calls.push(['clearState', appId]) }),
    screenshot: vi.fn(async () => Buffer.from('PNG')),
  }
}

const OPTS = { pollIntervalMs: 1, defaultTimeoutMs: 20 }

const flowOf = (yaml: string) => parseFlow(yaml, 'test.yaml')

describe('runFlow', () => {
  it('taps the center of the matched element frame', async () => {
    const driver = fakeDriver([[el({ label: '로그인', frame: { x: 0.2, y: 0.8, width: 0.6, height: 0.1 } })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "로그인"\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['tap', 0.5, 0.85]])
  })

  it('resolves a bare-string selector as identifier before label', async () => {
    const driver = fakeDriver([[
      el({ label: 'login', identifier: 'other' }),
      el({ label: 'x', identifier: 'login', frame: { x: 0, y: 0, width: 0.2, height: 0.2 } }),
    ]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "login"\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['tap', 0.1, 0.1]])
  })

  it('prefers exact label matches over partial ones', async () => {
    const driver = fakeDriver([[
      el({ label: '로그인하기', frame: { x: 0, y: 0, width: 0.2, height: 0.2 } }),
      el({ label: '로그인', frame: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 } }),
    ]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "로그인"\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['tap', 0.6, 0.6]])
  })

  it('falls back to partial label matches when no exact match exists', async () => {
    const driver = fakeDriver([[el({ label: '로그인하기', frame: { x: 0, y: 0, width: 0.2, height: 0.2 } })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "로그인"\n'), driver, OPTS)
    expect(result.status).toBe('passed')
  })

  it('fails immediately on multiple matches instead of picking one implicitly', async () => {
    const driver = fakeDriver([[el({ label: '삭제' }), el({ label: '삭제' })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "삭제"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureMessage).toMatch(/2 elements match/)
    expect(result.failureMessage).toMatch(/add an index or a more specific role\/label/)
    expect(driver.tap).not.toHaveBeenCalled()
  })

  // B2: a tapOn that misses carries lines to try, from the screen it missed on.
  it('attaches suggestions to a tapOn that matched nothing, from the last screen it saw', async () => {
    const driver = fakeDriver([[el({ label: 'Sign in' }), el({ label: 'Help', role: 'text' })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "Sign inn"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.steps[0]!.suggestions).toEqual([{ yaml: 'tapOn: "Sign in"', element: { role: 'button', label: 'Sign in' } }])
  })

  it('attaches the matches, told apart, to a tapOn that matched several', async () => {
    const driver = fakeDriver([[el({ label: '삭제' }), el({ label: '삭제', role: 'cell' })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "삭제"\n'), driver, OPTS)
    expect(result.steps[0]!.suggestions?.map((x) => x.yaml)).toEqual([
      'tapOn: { label: "삭제", role: "button" }', 'tapOn: { label: "삭제", role: "cell" }',
    ])
  })

  it('suggests nothing for an assertVisible that misses: the app may be what is wrong', async () => {
    const driver = fakeDriver([[el({ label: 'Pay now' })]])
    const result = await runFlow(flowOf('steps:\n  - assertVisible: "Pay nw"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.steps[0]).not.toHaveProperty('suggestions')
  })

  it('suggests nothing when the screen was read and then the query itself failed', async () => {
    // The selector is not what failed: the last tree seen is no evidence about it.
    let calls = 0
    const driver = fakeDriver([])
    driver.queryUITree = vi.fn(async () => {
      if (calls++ === 0) return [el({ label: 'Sign in' })]
      throw new Error('session ended')
    })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "Sign inn"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.steps[0]).not.toHaveProperty('suggestions')
  })

  it('suggests nothing when no screen was ever read', async () => {
    const driver = fakeDriver([])
    driver.queryUITree = vi.fn(async () => { throw new TransientQueryError('agent busy') })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "Sign in"\n'), driver, OPTS)
    expect(result.failureKind).toBe('environment')
    expect(result.steps[0]).not.toHaveProperty('suggestions')
  })

  describe('launchApp waits for the app to show a screen', () => {
    // Seen on iOS: a scroll sent right after launch was acknowledged and dropped by the app, 5 of 5.
    it('sends the next coordinate step only once the tree has something in it', async () => {
      const driver = fakeDriver([[], [], [el({ label: 'Home' })]])
      const order: string[] = []
      driver.queryUITree = vi.fn(async () => {
        const t = [[], [], [el({ label: 'Home' })]][Math.min(order.filter((o) => o === 'tree').length, 2)]!
        order.push('tree')
        return t
      })
      driver.swipe = vi.fn(async () => { order.push('swipe') })
      const result = await runFlow(flowOf('steps:\n  - launchApp\n  - scroll: down\n'), driver, OPTS)
      expect(result.status).toBe('passed')
      expect(order).toEqual(['tree', 'tree', 'tree', 'swipe'])
    })

    // A game, canvas or WebView-only screen has nothing in the tree and is up all the same.
    it('goes on after the timeout when the tree stays empty, without failing', async () => {
      const driver = fakeDriver([[]])
      const result = await runFlow(flowOf('steps:\n  - launchApp\n  - scroll: down\n'), driver, OPTS)
      expect(result.status).toBe('passed')
      expect(driver.calls).toEqual([['launchApp'], ['swipe', [0.5, 0.7], [0.5, 0.3], 300]])
    })

    it('leaves a failing tree query to the next step to report', async () => {
      const driver = fakeDriver([])
      driver.queryUITree = vi.fn(async () => { throw new Error('Session not found') })
      const result = await runFlow(flowOf('steps:\n  - launchApp\n'), driver, OPTS)
      expect(result.status).toBe('passed')
    })
  })

  describe('a query cut off at the deadline', () => {
    // The runner aborts its own in-flight query when the step's time is up. That names nothing that failed.
    const hangingAfter = (tree: UIElement[]) => {
      let calls = 0
      return vi.fn(async (signal?: AbortSignal) => {
        if (calls++ === 0) return tree
        return new Promise<UIElement[]>((_, reject) => signal?.addEventListener('abort', () =>
          reject(new TransientQueryError('ui-tree query failed: The operation was aborted due to timeout'))))
      })
    }

    it('is left out of a selector miss on a screen that was read', async () => {
      const driver = fakeDriver([])
      driver.queryUITree = hangingAfter([el({ label: 'Other' })])
      const result = await runFlow(flowOf('steps:\n  - tapOn: "Sign in"\n'), driver, { pollIntervalMs: 1, defaultTimeoutMs: 50 })
      expect(result.failureKind).toBe('product')
      expect(result.failureMessage).not.toMatch(/last query error/)
    })

    it('stays when no screen was ever read — then it is the finding', async () => {
      const driver = fakeDriver([])
      driver.queryUITree = vi.fn((signal?: AbortSignal) => new Promise<UIElement[]>((_, reject) => signal?.addEventListener('abort', () =>
        reject(new TransientQueryError('ui-tree query failed: The operation was aborted due to timeout')))))
      const result = await runFlow(flowOf('steps:\n  - tapOn: "Sign in"\n'), driver, { pollIntervalMs: 1, defaultTimeoutMs: 50 })
      expect(result.failureKind).toBe('environment')
      expect(result.failureMessage).toMatch(/aborted due to timeout/)
    })

    it('does not hide a real error seen before it', async () => {
      let calls = 0
      const driver = fakeDriver([])
      driver.queryUITree = vi.fn(async (signal?: AbortSignal) => {
        const n = calls++
        if (n === 0) return [el({ label: 'Other' })]
        if (n === 1) throw new TransientQueryError('agent busy')
        return new Promise<UIElement[]>((_, reject) => signal?.addEventListener('abort', () =>
          reject(new TransientQueryError('ui-tree query failed: The operation was aborted due to timeout'))))
      })
      const result = await runFlow(flowOf('steps:\n  - tapOn: "Sign in"\n'), driver, { pollIntervalMs: 1, defaultTimeoutMs: 50 })
      expect(result.failureMessage).not.toMatch(/aborted/)
      expect(result.failureMessage).toMatch(/last query error: agent busy/)
    })
  })

  // A2: the name watchers see drops what a step types, the URL it opens and a key that types a character.
  it('names each step for watchers without what it types', async () => {
    const marks: Record<string, unknown>[] = []
    const driver = fakeDriver([[el({ label: 'ok' })]])
    await runFlow(flowOf('steps:\n  - inputText: "hunter2"\n  - openUrl: "myapp://reset?token=s3cret"\n  - pressKey: KeyA\n  - pressKey: NumpadComma\n  - pressKey: NumpadStar\n  - pressKey: Enter\n  - tapOn: "ok"\n'), driver, { ...OPTS, onStep: (m) => marks.push(m) })
    expect(marks.filter((m) => m['phase'] === 'start').map((m) => m['label'])).toEqual([
      'inputText (7 chars)', 'openUrl', 'pressKey(character)', 'pressKey(character)', 'pressKey(character)', 'pressKey(Enter)', 'tapOn("ok")',
    ])
    expect(JSON.stringify(marks.map((m) => m['label']))).not.toMatch(/hunter2|s3cret/)
  })

  it('disambiguates a shared label by role', async () => {
    const driver = fakeDriver([[
      el({ role: 'button', label: 'New Orders', frame: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 } }),
      el({ role: 'text', label: 'New Orders', frame: { x: 0.5, y: 0.5, width: 0.2, height: 0.1 } }),
    ]])
    const result = await runFlow(flowOf('steps:\n  - tapOn:\n      label: "New Orders"\n      role: button\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['tap', 0.2, 0.25]]) // the button, not its inner text
  })

  it('picks the Nth match by index (label-less rows)', async () => {
    const driver = fakeDriver([[
      el({ role: 'cell', label: '', frame: { x: 0, y: 0, width: 0.2, height: 0.1 } }),
      el({ role: 'cell', label: '', frame: { x: 0, y: 0.3, width: 0.2, height: 0.1 } }),
      el({ role: 'cell', label: '', frame: { x: 0, y: 0.6, width: 0.2, height: 0.1 } }),
    ]])
    const result = await runFlow(flowOf('steps:\n  - tapOn:\n      role: cell\n      index: 2\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['tap', 0.1, 0.65]]) // cell at index 2
  })

  it('index: 0 picks the first match', async () => {
    const driver = fakeDriver([[
      el({ role: 'cell', label: '', frame: { x: 0, y: 0.1, width: 0.2, height: 0.1 } }),
      el({ role: 'cell', label: '', frame: { x: 0, y: 0.5, width: 0.2, height: 0.1 } }),
    ]])
    const result = await runFlow(flowOf('steps:\n  - tapOn:\n      role: cell\n      index: 0\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['tap', 0.1, 0.15]]) // first cell
  })

  it('index out of range → no match, fails at the deadline', async () => {
    const driver = fakeDriver([[el({ role: 'cell', label: '' })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn:\n      role: cell\n      index: 5\n'), driver, OPTS)
    expect(result.status).toBe('failed')
  })

  it('polls the tree until the element appears', async () => {
    const driver = fakeDriver([[], [], [el({ label: 'OK' })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, { ...OPTS, defaultTimeoutMs: 500 })
    expect(result.status).toBe('passed')
    expect(driver.queryUITree).toHaveBeenCalledTimes(3)
  })

  it('retries a transient query error (foreground race), then resolves', async () => {
    const driver = fakeDriver([[]])
    let n = 0
    driver.queryUITree = vi.fn(async () => {
      if (n++ === 0) throw new TransientQueryError('is the app running in the foreground?')
      return [el({ label: 'OK' })]
    })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, { ...OPTS, defaultTimeoutMs: 500 })
    expect(result.status).toBe('passed')
    expect(driver.queryUITree).toHaveBeenCalledTimes(2)
  })

  it('fails at the deadline surfacing the last transient query error', async () => {
    const driver = fakeDriver([[]])
    driver.queryUITree = vi.fn(async () => { throw new TransientQueryError('is the app running in the foreground?') })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toContain('last query error: is the app running in the foreground?')
  })

  it('fails immediately on a non-transient query error (no retry)', async () => {
    const driver = fakeDriver([[]])
    driver.queryUITree = vi.fn(async () => { throw new Error('Session not found') })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureMessage).toContain('Session not found')
    expect(driver.queryUITree).toHaveBeenCalledTimes(1)
  })

  it('does not hang when a query stalls — the deadline aborts it and the step fails', async () => {
    const driver = fakeDriver([[]])
    // The query never resolves on its own; only the engine's deadline AbortSignal ends it.
    driver.queryUITree = vi.fn((signal?: AbortSignal) => new Promise<UIElement[]>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new TransientQueryError('query aborted at deadline')))
    }))
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(vi.mocked(driver.queryUITree).mock.calls[0]![0]).toBeInstanceOf(AbortSignal) // engine passed a bounding signal
  })

  it('caps the final polling delay at the selector deadline', async () => {
    vi.useFakeTimers()
    try {
      const driver = fakeDriver([[]])
      const pending = runFlow(flowOf('steps:\n  - assertVisible:\n      label: OK\n'), driver, { pollIntervalMs: 500, defaultTimeoutMs: 100 })
      await vi.advanceTimersByTimeAsync(100)
      const result = await pending
      expect(result.status).toBe('failed')
      expect(driver.queryUITree).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not hang when failure screenshot capture stalls', async () => {
    vi.useFakeTimers()
    try {
      const driver = fakeDriver([[]])
      driver.openUrl = vi.fn(async () => { throw new Error('product failure') })
      driver.screenshot = vi.fn(() => new Promise<Buffer>(() => {}))
      const pending = runFlow(flowOf('steps:\n  - openUrl: "app://x"\n'), driver, OPTS)
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await pending
      expect(result.status).toBe('failed')
      expect(result.failureScreenshot).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('captures the screen a passed flow ends on only when asked, and keeps it out of the duration', async () => {
    const asked = fakeDriver([[]])
    const passed = await runFlow(flowOf('steps:\n  - pressKey: Enter\n'), asked, { ...OPTS, captureLastScreen: true })
    expect(passed.status).toBe('passed')
    expect(passed.lastScreenshot).toEqual(Buffer.from('PNG'))
    expect(passed.failureScreenshot).toBeUndefined()

    const notAsked = fakeDriver([[]])
    const plain = await runFlow(flowOf('steps:\n  - pressKey: Enter\n'), notAsked, OPTS)
    expect(plain.lastScreenshot).toBeUndefined()
    expect(notAsked.screenshot).not.toHaveBeenCalled()

    // A failed flow already has its last screen as the failure screenshot; it is not taken twice.
    const failing = fakeDriver([[]])
    failing.openUrl = vi.fn(async () => { throw new Error('product failure') })
    const failed = await runFlow(flowOf('steps:\n  - openUrl: "app://x"\n'), failing, { ...OPTS, captureLastScreen: true })
    expect(failed.lastScreenshot).toBeUndefined()
    expect(failing.screenshot).toHaveBeenCalledTimes(1)
  })

  it('gives up on a last screen that stalls, and still passes the flow', async () => {
    vi.useFakeTimers()
    try {
      const driver = fakeDriver([[]])
      driver.screenshot = vi.fn(() => new Promise<Buffer>(() => {}))
      const pending = runFlow(flowOf('steps:\n  - pressKey: Enter\n'), driver, { ...OPTS, captureLastScreen: true })
      await vi.advanceTimersByTimeAsync(5_000)
      const result = await pending
      expect(result.status).toBe('passed')
      expect(result.lastScreenshot).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails with a timeout, captures a screenshot, and skips remaining steps', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "없는버튼"\n  - pressKey: Enter\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureMessage).toMatch(/없는버튼/)
    expect(result.steps.map((s) => s.status)).toEqual(['failed', 'skipped'])
    expect(result.failureScreenshot).toEqual(Buffer.from('PNG'))
    expect(driver.pressKey).not.toHaveBeenCalled()
  })

  it('assertNotVisible passes once the element disappears', async () => {
    const driver = fakeDriver([[el({ label: '스피너' })], []])
    const result = await runFlow(flowOf('steps:\n  - assertNotVisible: "스피너"\n'), driver, { ...OPTS, defaultTimeoutMs: 500 })
    expect(result.status).toBe('passed')
  })

  it('assertNotVisible fails when the element is still present at timeout', async () => {
    const driver = fakeDriver([[el({ label: '오류' })]])
    const result = await runFlow(flowOf('steps:\n  - assertNotVisible: "오류"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
  })

  it('assertVisible accepts multiple matches (presence only)', async () => {
    const driver = fakeDriver([[el({ label: '항목' }), el({ label: '항목' })]])
    const result = await runFlow(flowOf('steps:\n  - assertVisible: "항목"\n'), driver, OPTS)
    expect(result.status).toBe('passed')
  })

  it('assertVisible retries a transient query error, then passes', async () => {
    const driver = fakeDriver([[]])
    let n = 0
    driver.queryUITree = vi.fn(async () => {
      if (n++ === 0) throw new TransientQueryError('foreground?')
      return [el({ label: '항목' })]
    })
    const result = await runFlow(flowOf('steps:\n  - assertVisible: "항목"\n'), driver, { ...OPTS, defaultTimeoutMs: 500 })
    expect(result.status).toBe('passed')
    expect(driver.queryUITree).toHaveBeenCalledTimes(2)
  })

  it('assertNotVisible does not treat a transient error as "gone" (element still present)', async () => {
    const driver = fakeDriver([[]])
    let n = 0
    driver.queryUITree = vi.fn(async () => {
      if (n++ === 0) throw new TransientQueryError('foreground?')
      return [el({ label: '오류' })] // still present after the transient blip
    })
    const result = await runFlow(flowOf('steps:\n  - assertNotVisible: "오류"\n'), driver, OPTS)
    expect(result.status).toBe('failed') // must not pass on the transient poll
  })

  it('maps scroll directions to swipes (direction = where to reveal content)', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf('steps:\n  - scroll\n  - scroll: up\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([
      ['swipe', [0.5, 0.7], [0.5, 0.3], 300],
      ['swipe', [0.5, 0.3], [0.5, 0.7], 300],
    ])
  })

  it('clearState uses the flow appId, inline bundle id wins', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf(`
appId: com.example.app
steps:
  - clearState
  - clearState: com.other.app
`), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['clearState', 'com.example.app'], ['clearState', 'com.other.app']])
  })

  it('clearState with no app id anywhere fails the step instead of sending an empty payload', async () => {
    // Not reachable through `parseFlow`, which rejects the bare form without a flow-level appId — but `runFlow`
    // is exported and does not parse, so an embedder can hand it this. `flow.appId!` used to launder it into
    // `app:clear-state` with `payload: {}` and let the device answer 'bundleId missing' a network hop later.
    const driver = fakeDriver([[]])
    const result = await runFlow({ name: 'hand-built', steps: [{ type: 'clearState' }] }, driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureMessage).toContain('clearState has no app id')
    expect(driver.calls).toEqual([])
  })

  it('per-selector timeout overrides the default', async () => {
    const driver = fakeDriver([[]])
    const start = Date.now()
    const result = await runFlow(
      flowOf('steps:\n  - assertVisible:\n      label: x\n      timeout: 0.01\n'),
      driver,
      { pollIntervalMs: 1, defaultTimeoutMs: 5_000 },
    )
    expect(result.status).toBe('failed')
    expect(Date.now() - start).toBeLessThan(1_000)
  })

  it('normalizes fractional default timeouts before using timer APIs', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf('steps:\n  - openUrl: "app://x"\n'), driver, { defaultTimeoutMs: 1_234.5 })
    expect(result.status).toBe('passed')
  })

  it('reports step names and durations in results', async () => {
    const driver = fakeDriver([[el({ label: 'OK' })]])
    const result = await runFlow(flowOf('steps:\n  - launchApp\n  - tapOn: "OK"\n'), driver, OPTS)
    expect(result.steps[0]).toMatchObject({ name: 'launchApp', status: 'passed' })
    expect(result.steps[1].name).toBe('tapOn("OK")')
    expect(result.steps.every((s) => typeof s.durationMs === 'number')).toBe(true)
  })

  it('a PlatformError on a step throws to let the caller handle it (environmental error)', async () => {
    const driver = fakeDriver([[]])
    driver.openUrl = vi.fn(async () => { throw new PlatformError('agent offline') })
    await expect(runFlow(flowOf('steps:\n  - openUrl: "app://x"\n'), driver, OPTS)).rejects.toThrow(PlatformError)
  })

  it('a driver error on a step fails the flow with that error', async () => {
    const driver = fakeDriver([[]])
    driver.openUrl = vi.fn(async () => { throw new Error('agent offline') })
    const result = await runFlow(flowOf('steps:\n  - openUrl: "app://x"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureMessage).toContain('agent offline')
  })

  // Failure-kind routing (#543): the engine is what classifies, so consumers never branch on prose.
  it('marks an environment step failure as environment', async () => {
    const driver = fakeDriver([[el({ label: 'x' })]])
    driver.tap = vi.fn(async () => { throw new EnvironmentStepError('relay connection closed') })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "x"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toContain('relay connection closed')
  })

  it('marks selector and assertion failures as product', async () => {
    const missing = fakeDriver([[]])
    const missingResult = await runFlow(flowOf('steps:\n  - tapOn: "없는버튼"\n'), missing, OPTS)
    expect(missingResult.status).toBe('failed')
    expect(missingResult.failureKind).toBe('product')

    const ambiguous = fakeDriver([[el({ label: 'x' }), el({ label: 'x' })]])
    const ambiguousResult = await runFlow(flowOf('steps:\n  - tapOn: "x"\n'), ambiguous, OPTS)
    expect(ambiguousResult.status).toBe('failed')
    expect(ambiguousResult.failureKind).toBe('product')
  })

  it('omits the failure kind on success', async () => {
    const driver = fakeDriver([[el({ label: 'x' })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "x"\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(result.failureKind).toBeUndefined()
  })

  it('aborts a stalled failure screenshot instead of hanging the flow', async () => {
    vi.useFakeTimers()
    try {
      const driver = fakeDriver([[]])
      driver.openUrl = vi.fn(async () => { throw new Error('product failure') })
      let seenSignal: AbortSignal | undefined
      driver.screenshot = vi.fn((signal?: AbortSignal) => new Promise<Buffer>((_resolve, _reject) => {
        seenSignal = signal
      }))
      const pending = runFlow(flowOf('steps:\n  - openUrl: "app://x"\n'), driver, OPTS)
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await pending
      expect(result.status).toBe('failed')
      expect(result.failureScreenshot).toBeUndefined()
      expect(seenSignal).toBeInstanceOf(AbortSignal)
      expect(seenSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a product miss when a trailing transient blip hits the deadline', async () => {
    const driver = fakeDriver([[]])
    let n = 0
    driver.queryUITree = vi.fn(async () => {
      // Successful empty trees first (the element genuinely never matches),
      // then a transient blip exactly at the deadline.
      if (n++ < 3) return []
      throw new TransientQueryError('agent blip at deadline')
    })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "없는버튼"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('product')
  })

  it('rejects timeouts that round to 0ms', async () => {
    const driver = fakeDriver([[]])
    await expect(runFlow(flowOf('steps:\n  - openUrl: "app://x"\n'), driver, { defaultTimeoutMs: 0.4 })).rejects.toThrow(/at least 1ms/)
  })
})

// Deadline classification (#825): queryDeadlineFailure returns environment
// when no tree was ever seen, product once one was — across every poll loop
// that keeps its own sawTree state (resolveOne, waitVisible, waitNotVisible).
// Small real timeouts keep these deterministic: the loop can only end at the
// deadline with lastError set, so no timing decides the kind.
describe('query deadline classification', () => {
  const ABORT = 'query aborted at deadline'
  const QUERY_TIMEOUT = 'ui-tree query timed out'

  it('tapOn whose query aborts on every poll, with no earlier tree, is environmental', async () => {
    const driver = fakeDriver([[]])
    driver.queryUITree = vi.fn(async (): Promise<never> => { throw new TransientQueryError(ABORT) })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toContain(`last query error: ${ABORT}`)
  })

  it('assertVisible whose query aborts on every poll, with no earlier tree, is environmental', async () => {
    const driver = fakeDriver([[]])
    driver.queryUITree = vi.fn(async (): Promise<never> => { throw new TransientQueryError(ABORT) })
    const result = await runFlow(flowOf('steps:\n  - assertVisible: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toContain(`last query error: ${ABORT}`)
  })

  it('assertNotVisible whose query aborts on every poll, with no earlier tree, is environmental', async () => {
    const driver = fakeDriver([[]])
    driver.queryUITree = vi.fn(async (): Promise<never> => { throw new TransientQueryError(ABORT) })
    const result = await runFlow(flowOf('steps:\n  - assertNotVisible: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toContain(`last query error: ${ABORT}`)
  })

  it('tapOn whose query times out on every poll, with no earlier tree, is environmental', async () => {
    const driver = fakeDriver([[]])
    driver.queryUITree = vi.fn(async (): Promise<never> => { throw new TransientQueryError(QUERY_TIMEOUT) })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toContain(`last query error: ${QUERY_TIMEOUT}`)
  })

  it('tapOn that aborts after an earlier non-matching tree stays product', async () => {
    const driver = fakeDriver([[]])
    let n = 0
    driver.queryUITree = vi.fn(async () => {
      if (n++ === 0) return [] // a tree was seen; the element genuinely never matched
      throw new TransientQueryError(ABORT)
    })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('product')
    expect(result.failureMessage).toContain('no element matched')
  })

  it('assertVisible that times out after an earlier non-matching tree stays product', async () => {
    const driver = fakeDriver([[]])
    let n = 0
    driver.queryUITree = vi.fn(async () => {
      if (n++ === 0) return []
      throw new TransientQueryError(QUERY_TIMEOUT)
    })
    const result = await runFlow(flowOf('steps:\n  - assertVisible: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('product')
    expect(result.failureMessage).toContain('no element matched')
  })

  it('assertNotVisible that aborts after an earlier tree showing the element stays product', async () => {
    const driver = fakeDriver([[]])
    let n = 0
    const tree = [el({ label: 'OK' })]
    driver.queryUITree = vi.fn(async () => {
      if (n++ === 0) return tree // the element is still visible; the abort cannot confirm it gone
      throw new TransientQueryError(ABORT)
    })
    const result = await runFlow(flowOf('steps:\n  - assertNotVisible: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('product')
    expect(result.failureMessage).toContain('still visible')
  })
})

// Evidence collection (#825): captureFailureScreenshot swallows its own
// failure, and failureKind is set before capture runs — so a rejecting
// screenshot cannot reclassify the step. Pins both kinds.
describe('rejected failure screenshot preserves classification', () => {
  it('leaves an environmental failureKind, message and failed step unchanged', async () => {
    const driver = fakeDriver([[el({ label: 'x' })]])
    driver.tap = vi.fn(async (): Promise<void> => { throw new EnvironmentStepError('relay connection closed') })
    driver.screenshot = vi.fn(async (): Promise<Buffer> => { throw new Error('screenshot backend down') })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "x"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('environment')
    expect(result.failureMessage).toContain('relay connection closed')
    expect(result.failureMessage).not.toContain('screenshot backend down')
    expect(result.steps[0]).toMatchObject({ status: 'failed' })
    expect(result.steps[0]?.message).toContain('relay connection closed')
    expect(result.failureScreenshot).toBeUndefined()
  })

  it('leaves a product failureKind, message and failed step unchanged', async () => {
    const driver = fakeDriver([[]])
    driver.screenshot = vi.fn(async (): Promise<Buffer> => { throw new Error('screenshot backend down') })
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureKind).toBe('product')
    expect(result.failureMessage).toContain('no element matched')
    expect(result.failureMessage).not.toContain('screenshot backend down')
    expect(result.steps[0]).toMatchObject({ status: 'failed' })
    expect(result.steps[0]?.message).toContain('no element matched')
    expect(result.failureScreenshot).toBeUndefined()
  })
})

describe('runFlow onStep (the run video\'s timeline)', () => {
  it('marks each step\'s start and end, the failure, and nothing for skipped steps', async () => {
    const marks: unknown[] = []
    const driver = fakeDriver([[]])
    driver.openUrl = vi.fn(async () => { throw new Error('no such app') })
    await runFlow(parseFlow('steps:\n  - pressKey: Enter\n  - openUrl: "app://x"\n  - pressKey: Enter\n', 't.yaml'), driver, {
      pollIntervalMs: 1, defaultTimeoutMs: 20, onStep: (m) => marks.push(m),
    })
    expect(marks).toEqual([
      { index: 0, name: expect.any(String), phase: 'start', label: 'pressKey(Enter)' },
      { index: 0, name: expect.any(String), phase: 'end', status: 'passed' },
      { index: 1, name: expect.any(String), phase: 'start', label: 'openUrl' },
      { index: 1, name: expect.any(String), phase: 'end', status: 'failed' },
    ])
  })
})
