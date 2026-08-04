// The supported Node floor is stated in more than one place, and the copies drift.
//
// Before this guard existed the manifests said `>=20.12.0`, the docs said "≥ 20" (meaning 20.0.0),
// and `tapflow doctor` hardcoded `>= 20` — three answers to one question. The doctor copy is the
// dangerous one: it is what a user actually sees, so a stale value there prints a green check on a
// version the package manifest calls unsupported.
//
// Moving the numbers was not enough. The duplication is what produced the drift, so this pins the
// copies to each other: every published package agrees on the floor, and `doctor` enforces that
// same floor rather than a number someone typed next to it.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PKGS = join(ROOT, 'packages')

const manifests = () =>
  readdirSync(PKGS)
    .filter((d) => existsSync(join(PKGS, d, 'package.json')))
    .map((d) => ({ dir: d, pkg: JSON.parse(readFileSync(join(PKGS, d, 'package.json'), 'utf8')) }))

// Derived, not listed. A hardcoded list describes the day it was written — a package added later
// is exactly the one that would slip through.
const published = () => manifests().filter(({ pkg }) => !pkg.private)

describe('the Node floor is stated once and agreed on everywhere', () => {
  it('every published package declares engines.node', () => {
    const missing = published().filter(({ pkg }) => !pkg.engines?.node).map(({ dir }) => dir)
    // `tapflow` (the CLI) had none for its whole life — the package installed with `npm i -g`
    // announced no Node requirement to the people most likely to need one.
    expect(missing).toEqual([])
  })

  it('every published package declares the SAME floor', () => {
    const floors = [...new Set(published().map(({ pkg }) => pkg.engines.node))]
    expect(floors).toHaveLength(1)
  })

  it('the root declares the same floor as the packages', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(root.engines.node).toBe(published()[0].pkg.engines.node)
  })

  it('tapflow doctor enforces the floor the CLI manifest declares', () => {
    const cli = JSON.parse(readFileSync(join(PKGS, 'cli', 'package.json'), 'utf8'))
    const declared = Number(cli.engines.node.match(/(\d+)/)[1])

    const doctor = readFileSync(join(PKGS, 'cli', 'src', 'lib', 'doctor.ts'), 'utf8')
    const enforced = Number(doctor.match(/Number\(major\)\s*>=\s*(\d+)/)[1])

    expect(enforced).toBe(declared)
  })

  it('the message doctor prints names the floor it enforces', () => {
    const doctor = readFileSync(join(PKGS, 'cli', 'src', 'lib', 'doctor.ts'), 'utf8')
    const enforced = doctor.match(/Number\(major\)\s*>=\s*(\d+)/)[1]
    // Two separate literals on adjacent lines; the message went stale independently once already.
    expect(doctor).toContain(`Node ≥ ${enforced} required`)
  })
})
