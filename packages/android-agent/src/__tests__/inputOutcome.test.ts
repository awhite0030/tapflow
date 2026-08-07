import { describe, it, expect } from 'vitest'
import { wireReason, outcomeMessage, type InputOutcome } from '../inputOutcome.js'
import type { InputErrorReason } from '@tapflowio/protocol'

// The wire set is smaller than this agent's internal one on purpose — it is derived from what a
// consumer must do differently, and two of ours ask for the same thing. Pinning the map here rather
// than through the agent because the mapping is the decision; the agent only forwards it.
describe('wireReason — internal reasons onto the wire\'s closed set', () => {
  const expected: Array<[Exclude<InputOutcome, 'delivered'>, InputErrorReason]> = [
    ['not-booted', 'not-booted'],
    ['channel-down', 'channel-unavailable'],
    ['failed', 'dispatch-failed'],
    ['unsupported', 'unsupported'],
    ['malformed', 'malformed'],
    ['no-gesture', 'no-gesture'],
    // The one collapse left: a consumer's move is the same as for the target, so a separate wire
    // reason would add a surface without adding a decision.
    ['no-session', 'channel-unavailable'],
  ]

  for (const [internal, wire] of expected) {
    it(`${internal} → ${wire}`, () => {
      expect(wireReason(internal)).toBe(wire)
    })
  }

  it('covers every internal reason, enforced by the compiler rather than by a second list', () => {
    // `wireReason`'s switch is exhaustive over the union, but nothing makes an *array literal*
    // exhaustive — so an earlier version compared this table against a second hand-written list in
    // this same file, which only failed if someone edited one of two adjacent literals. This Record
    // is the constraint: adding a member to `InputOutcome` makes it a type error until the table
    // gains a row.
    const required: Record<Exclude<InputOutcome, 'delivered'>, true> = {
      'not-booted': true,
      'channel-down': true,
      failed: true,
      unsupported: true,
      malformed: true,
      'no-gesture': true,
      'no-session': true,
    }
    expect(expected.map(([internal]) => internal).sort()).toEqual(Object.keys(required).sort())
  })

  it('every wire reason still has human prose behind it', () => {
    for (const [internal] of expected) {
      expect(outcomeMessage(internal)).toBeTruthy()
    }
  })

  // Recorded, not an oversight: iOS has a measured window where its helper is up but not injecting;
  // the Android paths either have a channel or do not.
  it('produces no channel-starting — this agent has no such state', () => {
    // Asserted over `wireReason`'s real outputs, not over the expectation table, so the claim rests
    // on the code rather than on this file agreeing with itself.
    const produced = (Object.keys({
      'not-booted': 0, 'channel-down': 0, failed: 0, unsupported: 0, malformed: 0, 'no-gesture': 0, 'no-session': 0,
    }) as Array<Exclude<InputOutcome, 'delivered'>>).map(wireReason)
    expect(produced).not.toContain('channel-starting')
  })
})
