import { describe, it, expect, vi, afterEach } from 'vitest'

/** Stands in for clack's cancel symbol. A symbol is truthy, which is the whole point of the test below. */
const CANCEL = Symbol('clack:cancel')
vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === CANCEL),
}))

import { confirm } from '@clack/prompts'
import { terminalApprovalDeps, isInteractive } from '../../lib/approval-prompt.js'

const mockConfirm = vi.mocked(confirm)

function terminal(stdout: boolean | undefined, stdin: boolean | undefined) {
  Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true })
  Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true })
}

/**
 * The terminal's side of the approval flow. Every other test of that flow hands it a person directly, so
 * nothing else sees what this file decides — which is when to ask at all, and what counts as a yes.
 */
describe('terminalApprovalDeps', () => {
  const realOut = process.stdout.isTTY
  const realIn = process.stdin.isTTY
  afterEach(() => { terminal(realOut, realIn); vi.clearAllMocks() })

  it('is interactive only when both ends are a terminal', () => {
    // **stdin too.** Under a terminal with stdin at EOF — `</dev/null`, a provisioning script — clack draws
    // the prompt and node exits 0 with the promise never settled: measured under a pty. The command then
    // ends with no banner. The mutations are dropping either half, or answering `true` outright.
    terminal(true, true)
    expect(isInteractive()).toBe(true)
    expect(terminalApprovalDeps().interactive).toBe(true)
    terminal(true, undefined)
    expect(isInteractive(), 'asked with stdin at EOF').toBe(false)
    expect(terminalApprovalDeps().interactive, 'asked with stdin at EOF').toBe(false)
    terminal(undefined, true)
    expect(isInteractive(), 'asked with nobody reading the output').toBe(false)
    expect(terminalApprovalDeps().interactive, 'asked with nobody reading the output').toBe(false)
  })

  it('reports a cancelled prompt as cancelled, never as a yes', async () => {
    // Ctrl-C and Esc resolve to clack's cancel symbol, and a symbol is truthy. `Boolean(answer)` or
    // `answer !== false` would open the screen and switch the filter on for someone who pressed Escape.
    // And not as a plain no either: the question before the install has to stop on it, and a no there
    // still installs.
    mockConfirm.mockResolvedValue(CANCEL as never)
    expect(await terminalApprovalDeps().confirm('?')).toBe('cancelled')
  })

  it('answers yes only to a yes, and asks the question it was given', async () => {
    mockConfirm.mockResolvedValue(true as never)
    expect(await terminalApprovalDeps().confirm('the question')).toBe(true)
    expect(mockConfirm).toHaveBeenCalledWith({ message: 'the question' })
    mockConfirm.mockResolvedValue(false as never)
    expect(await terminalApprovalDeps().confirm('the question')).toBe(false)
  })
})
