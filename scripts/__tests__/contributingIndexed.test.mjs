// `contributing/README.md`'s table is the directory's entry point, and nothing made it complete.
//
// The table is how a record is found when no rule beside the code happens to name it — 28 files, and
// a new one could be added with no row and nothing would say so. That is worth a check on its own,
// but the reason it is worth one *now* is that the table was just regrouped by subsystem: a grouped
// index is easier to read and easier to fall out of, because "which group does this go in" is a
// question an author can answer by not answering it.
//
// It also holds the one duplication in the scheme. Every row repeats the file's own frontmatter
// `type`, which is exactly the second copy that `contributing/README.md` warns about elsewhere — the
// duplication is safe only while something compares them.
//
// **Walked from disk, never `git ls-files`.** A record that was just written is untracked, and that
// is precisely the state a missing row is in. `checksWalkDisk.test.mjs` holds this for the whole
// family; see `sourceFiles.mjs` for the measurement behind it.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../..')
const dir = join(root, 'contributing')
const readme = readFileSync(join(dir, 'README.md'), 'utf8')
const index = readFileSync(join(root, 'INDEX.md'), 'utf8')

/** Every record in the directory. `README.md` is the index itself, not a record. */
const records = readdirSync(dir)
  .filter((f) => f.endsWith('.md') && f !== 'README.md')
  .sort()

/** `| [name.md](./name.md) | type | topics |` — the row shape, with the type captured. */
const rows = new Map(
  [...readme.matchAll(/^\| \[([^\]]+\.md)\]\(\.\/([^)]+\.md)\) \| (\S+) \| .+ \|$/gm)]
    .map((m) => [m[1], { href: m[2], type: m[3] }]),
)

/** The `type:` line from a record's own frontmatter. */
function declaredType(file) {
  const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(dir, file), 'utf8'))
  return m ? (/^type:\s*(\S+)/m.exec(m[1])?.[1] ?? null) : null
}

describe('every record is reachable from the index', () => {
  it('has a row in the README table', () => {
    // Named rather than counted: a failure should say which file to add, not that a number moved.
    expect(records.filter((f) => !rows.has(f))).toEqual([])
  })

  it('has a line in the root INDEX.md', () => {
    expect(records.filter((f) => !index.includes(`contributing/${f}`))).toEqual([])
  })

  it('is linked by its own name, so a renamed file breaks the row rather than pointing elsewhere', () => {
    expect([...rows].filter(([name, { href }]) => href !== name).map(([n]) => n)).toEqual([])
  })
})

describe('the table does not describe files that are not there', () => {
  it('lists no record that has been deleted or renamed', () => {
    expect([...rows.keys()].filter((f) => !records.includes(f))).toEqual([])
  })

  it('repeats each record’s own frontmatter type', () => {
    // The row's `type` is a copy. It is allowed to exist because this compares it; without that the
    // two drift and the table starts describing a document that changed underneath it.
    const drifted = records
      .map((f) => ({ file: f, row: rows.get(f)?.type, declared: declaredType(f) }))
      .filter(({ row, declared }) => row !== declared)
    expect(drifted).toEqual([])
  })
})

describe('the check is looking at something', () => {
  it('found the records that exist today', () => {
    // **An anti-vacuity floor set from the measured count, not a round number.** An empty `records`
    // or an empty `rows` satisfies every assertion above by having nothing to disagree about — which
    // is what a wrong glob or a changed row shape produces, silently.
    expect(records.length).toBe(28)
    expect(rows.size).toBe(28)
  })
})
