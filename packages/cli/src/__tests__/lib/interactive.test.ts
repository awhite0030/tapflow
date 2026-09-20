import { describe, it, expect, afterEach } from 'vitest'
import { isInteractive } from '../../lib/interactive.js'

function terminal(stdout: boolean | undefined, stdin: boolean | undefined) {
  Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true })
  Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true })
}

describe('isInteractive', () => {
  const realOut = process.stdout.isTTY
  const realIn = process.stdin.isTTY
  afterEach(() => {
    terminal(realOut, realIn)
    delete process.env.TAPFLOW_NONINTERACTIVE
  })

  it('is true when both ends are a terminal', () => {
    terminal(true, true)
    expect(isInteractive()).toBe(true)
  })

  it('is false when stdin is not a terminal', () => {
    terminal(true, undefined)
    expect(isInteractive()).toBe(false)
  })

  it('is false when stdout is not a terminal', () => {
    terminal(undefined, true)
    expect(isInteractive()).toBe(false)
  })

  it('is false when TAPFLOW_NONINTERACTIVE is set', () => {
    terminal(true, true)
    process.env.TAPFLOW_NONINTERACTIVE = '1'
    expect(isInteractive()).toBe(false)
  })
})
