// `README.md` and `packages/cli/README.md` are the same document. The cli copy is what npm renders
// on the package page, and nothing tied the two together — #601 edited a hero and had to change both
// by hand, with no gate to say so if only one had been touched.
//
// The comparison normalises the two URL prefixes npm needs and skips regions both files mark as
// deliberately divergent. That makes the markers the hole rather than the fix: the check's core
// operation is "stop looking here", so what follows is aimed at the ways that instruction can be
// wrong. Per contributing/test-and-guard-coverage.md:
//
//   - An unbalanced marker is an error, never an exemption. Treating an unclosed marker as "exempt
//     to end of file" turns one typo into a green run over a file nothing compared. Asserted below
//     against synthetic input, because that failure cannot be produced by the real files.
//   - The equality assertion is paired with a positive one. A normalisation later widened toward
//     "normalise links" would hide the cli copy pointing at a different page while staying green,
//     so the rewrites are literal prefixes and the test asserts they actually fire.
//   - The floors come from measurement, not from a round number. See the constants.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const PAIR = [
  { label: 'root', path: 'README.md' },
  { label: 'cli', path: 'packages/cli/README.md' },
]

// Literal prefixes, deliberately not a link-shaped pattern. npm resolves neither repo-relative
// paths nor `blob/main` links, so the cli copy absolutises both; everything else about a link must
// still have to match.
const REWRITES = [
  'https://raw.githubusercontent.com/jo-duchan/tapflow/main/',
  'https://github.com/jo-duchan/tapflow/blob/main/',
]

const OPEN = /^<!-- readme-sync:exempt(?: ([a-z0-9-]+))? -->$/
const CLOSE = /^<!-- \/readme-sync:exempt -->$/

// Measured at 9016902 with one exempt region (`npm-has-no-video`): both files compare 247 lines,
// the region costs 1 line on the root side and 6 on the cli side, and the cli compared span carries
// 11 rewritten URLs (1 raw.githubusercontent, 10 blob/main). The floors sit at those numbers rather
// than below them, so a second exempt region — or an extraction that quietly emptied the comparison
// — has to be raised by hand in a diff somebody reads.
const MIN_COMPARED_LINES = 247
const MAX_EXEMPT_LINES = 6
const MIN_REWRITES_IN_CLI = 11

/**
 * Split a README into the span that is compared and the regions marked exempt.
 *
 * Every malformed marker throws. The failure this is guarding against is the opposite — a reading
 * where a broken marker quietly widens what is skipped — so there is no lenient branch to fall into.
 */
export function split(text) {
  const compared = []
  const exempt = []
  let open = null

  text.split('\n').forEach((line, i) => {
    const at = `line ${i + 1}`
    const opened = OPEN.exec(line)
    const closed = CLOSE.test(line)

    if (opened) {
      if (open) throw new Error(`readme-sync: exempt region opened inside another at ${at}`)
      open = { reason: opened[1] ?? null, lines: [], at }
      return
    }
    if (closed) {
      if (!open) throw new Error(`readme-sync: exempt region closed without opening at ${at}`)
      exempt.push(open)
      open = null
      return
    }
    ;(open ? open.lines : compared).push(line)
  })

  if (open) throw new Error(`readme-sync: exempt region opened at ${open.at} is never closed`)
  return { compared, exempt }
}

const normalise = (lines) =>
  lines.map((l) => REWRITES.reduce((acc, prefix) => acc.split(prefix).join(''), l))

const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')
const parsed = Object.fromEntries(PAIR.map(({ label, path }) => [label, split(read(path))]))

describe('a malformed marker is an error rather than a wider exemption', () => {
  // The real files cannot produce these, and the reading that makes them harmless — "an unclosed
  // marker exempts the rest" — is exactly the one that would pass while comparing nothing.
  it('rejects an opening marker that is never closed', () => {
    expect(() => split('a\n<!-- readme-sync:exempt why -->\nb\n')).toThrow(/never closed/)
  })
  it('rejects a closing marker with nothing open', () => {
    expect(() => split('a\n<!-- /readme-sync:exempt -->\n')).toThrow(/without opening/)
  })
  it('rejects a region opened inside another', () => {
    const text = '<!-- readme-sync:exempt a -->\n<!-- readme-sync:exempt b -->\n'
    expect(() => split(text)).toThrow(/inside another/)
  })
  it('keeps an ordinary line out of the exempt span', () => {
    const { compared, exempt } = split('a\n<!-- readme-sync:exempt why -->\nb\n<!-- /readme-sync:exempt -->\nc\n')
    expect(compared).toEqual(['a', 'c', ''])
    expect(exempt).toEqual([expect.objectContaining({ reason: 'why', lines: ['b'] })])
  })
})

describe('the two READMEs', () => {
  it('declare the same exempt regions in the same order', () => {
    const reasons = (label) => parsed[label].exempt.map((r) => r.reason)
    expect(reasons('cli')).toEqual(reasons('root'))
    expect(reasons('root')).toEqual(['npm-has-no-video'])
  })

  it('match outside the exempt regions once the npm URL prefixes are normalised', () => {
    expect(normalise(parsed.cli.compared)).toEqual(normalise(parsed.root.compared))
  })

  // Pairs the equality above with a claim that fails on a wrong value rather than on silence. If
  // the rewrites stop matching what the cli copy actually writes, the two spans could only be equal
  // by both having lost the links.
  it('are compared with rewrites that actually fire', () => {
    const cli = parsed.cli.compared.join('\n')
    const root = parsed.root.compared.join('\n')
    const hits = REWRITES.map((prefix) => cli.split(prefix).length - 1)
    expect(hits.every((n) => n > 0)).toBe(true)
    expect(hits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(MIN_REWRITES_IN_CLI)
    // The root copy writes none of them, so a rewrite can only ever pull the cli side toward it.
    for (const prefix of REWRITES) expect(root).not.toContain(prefix)
  })

  it('are compared over a span the exempt regions have not eaten', () => {
    for (const { label } of PAIR) {
      const { compared, exempt } = parsed[label]
      const exemptLines = exempt.reduce((n, r) => n + r.lines.length, 0)
      expect(exemptLines, `${label} exempt span`).toBeLessThanOrEqual(MAX_EXEMPT_LINES)
      expect(compared.length, `${label} compared span`).toBeGreaterThanOrEqual(MIN_COMPARED_LINES)
    }
  })
})
