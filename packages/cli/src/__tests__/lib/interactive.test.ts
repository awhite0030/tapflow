import { describe, it, expect, afterEach } from 'vitest'
import { isInteractive } from '../../lib/interactive.js'

function terminal(stdout: boolean | undefined, stdin: boolean | undefined) {
  Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true })
  Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true })
}

/**
 * The one rule every prompt in the CLI reads. It is tested here as well as through the commands
 * because the commands can only show that they did not ask — and a step that never reaches its
 * guard does not ask either, which looks the same from outside.
 */
describe('isInteractive', () => {
  const realOut = process.stdout.isTTY
  const realIn = process.stdin.isTTY
  afterEach(() => terminal(realOut, realIn))

  it.each([
    [true, true, true],
    // The shape that shipped the bug: output on a terminal, nothing to read. `tapflow setup ios
    // </dev/null`, or a provisioning script under a pty.
    [true, undefined, false],
    [true, false, false],
    [undefined, true, false],
    [false, false, false],
  ])('stdout=%s stdin=%s → %s', (stdout, stdin, expected) => {
    terminal(stdout, stdin)
    expect(isInteractive()).toBe(expected)
  })

  it('reads the streams on each call, not once at import', () => {
    // The guards are evaluated mid-run, and a module-level constant would freeze whatever vitest,
    // or a wrapper that reopened stdin, happened to have at import time.
    terminal(true, true)
    expect(isInteractive()).toBe(true)
    terminal(true, undefined)
    expect(isInteractive()).toBe(false)
  })
})
