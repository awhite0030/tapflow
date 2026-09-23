import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENTS_BLOCK } from '../../packages/cli/src/lib/agentDocs.ts'

/**
 * **The block `tapflow init` writes points at pages that exist.**
 *
 * It ships inside the CLI and is copied into the user's repository, so a link that rots there is a
 * 404 an agent hits while answering a question — and the CLI has no way to notice. The block holds
 * pointers only (see `agentDocs.ts`), which is what makes checking them enough.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SITE = 'https://www.tapflow.dev'

/** The pages llms.txt lists, which is every English page — `agentReadableDocs.test.mjs` holds that. */
const indexedUrls = () =>
  [...readFileSync(join(ROOT, 'docs/public/llms.txt'), 'utf8').matchAll(/^- \[[^\]]+\]\((https?:\/\/[^)]+)\)/gm)]
    .map((m) => m[1])

describe('the AGENTS.md block tapflow init writes', () => {
  it('links only to documentation that exists', () => {
    const urls = [...AGENTS_BLOCK.matchAll(/https:\/\/www\.tapflow\.dev\/\S*[^\s.,)`]/g)].map((m) => m[0])
    expect(urls.length).toBeGreaterThanOrEqual(2)

    const pages = new Set(indexedUrls())
    expect(pages.size).toBeGreaterThan(0)
    for (const url of urls) {
      const known =
        url === `${SITE}/llms.txt` ||
        url === `${SITE}/llms-full.txt` ||
        pages.has(url) ||
        // A page linked as its markdown: `/reference/cli.md` is `/reference/cli` in the index.
        pages.has(url.replace(/\.md$/, ''))
      expect(known, `${url} is not a page llms.txt lists`).toBe(true)
    }
  })

  it('points at a CHANGELOG that is in this repository', () => {
    const raw = AGENTS_BLOCK.match(/https:\/\/raw\.githubusercontent\.com\/\S*CHANGELOG\.md/)
    expect(raw, 'the block tells agents to compare versions — it needs the CHANGELOG URL').not.toBeNull()
    expect(existsSync(join(ROOT, 'CHANGELOG.md'))).toBe(true)
  })

  it('stays short, because it loads into every session in the install dir', () => {
    expect(AGENTS_BLOCK.split('\n').length).toBeLessThanOrEqual(35)
  })
})
