// Protect the metric #168 actually cares about: JavaScript fetched before first paint.
//
// Vite's large-chunk warning only watches individual raw chunks. The first vendor split looked
// good by that signal while adding eager modulepreloads. Build the real dashboard output, read
// index.html, and budget the precompressed Brotli bytes that the relay serves.
import { beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { dirname, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DASHBOARD_DIST = resolve(ROOT, 'packages', 'dashboard', 'dist')
const INDEX_HTML = resolve(DASHBOARD_DIST, 'index.html')
// #520 set 155,000 against 147,099 B, about 8 kB of room. By #809, main had grown to 153,019 B, and
// that React 19.3 group adds 10.1 kB more (React 7.5, zod 1.6, lucide-react and react-hook-form 1.0)
// for 163,150 B. 171,000 restored the same 8 kB of room.
//
// 2026-09-22, turning the React Compiler on: 182,000 against 174,353 B, 7.6 kB of room.
//
// **The compiler is not what used the old budget up.** Measured the same day, main without the
// compiler was already at 170,543 B — 457 B under 171,000. Whatever landed between #809 and here
// spent the whole 8 kB, and the compiler's own share is +3,810 B (170,543 → 174,353), which is the
// memoisation it emits as code.
//
// The room must stay well below what the guard exists to catch: the eager vendor-ui / vendor-forms
// split from 252262ba's vite.config.ts. Rebuilt with that split on today's dependencies **and the
// compiler on**, as the previous note asked, it produces 187,809 B — so 182,000 fails it with
// 5.8 kB to spare, slightly more than the 5.1 kB the old pair had. Before raising this again,
// rebuild with that config and check it still fails.
const FIRST_LOAD_BROTLI_BUDGET = 182_000
const MAX_RAW_JS_CHUNK_SIZE = 500_000

function buildDashboardDist() {
  const env = { ...process.env, NODE_ENV: 'production' }
  execFileSync('pnpm', ['--filter', '@tapflowio/protocol', 'build'], { cwd: ROOT, env, stdio: 'inherit' })
  execFileSync('pnpm', ['--filter', '@tapflowio/dashboard', 'build'], { cwd: ROOT, env, stdio: 'inherit' })
}

function attributes(tag) {
  const out = new Map()
  const pattern = /([:\w-]+)\s*=\s*(['"])(.*?)\2/g
  for (const match of tag.matchAll(pattern)) out.set(match[1].toLowerCase(), match[3])
  return out
}

function distAssetPath(assetPath) {
  const withoutOrigin = assetPath.replace(/^[a-z]+:\/\/[^/]+/i, '')
  const withoutQuery = withoutOrigin.split(/[?#]/, 1)[0]
  const relativeAsset = withoutQuery.replace(/^\/+/, '')
  const resolved = resolve(DASHBOARD_DIST, relativeAsset)
  if (relative(DASHBOARD_DIST, resolved).startsWith('..')) {
    throw new Error(`First-load asset escapes dashboard dist: ${assetPath}`)
  }
  return resolved
}

function firstLoadJavascriptAssets(html) {
  const assets = new Set()

  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const attrs = attributes(match[0])
    const src = attrs.get('src')
    if (src?.endsWith('.js')) assets.add(distAssetPath(src))
  }

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(match[0])
    const rel = attrs.get('rel')?.toLowerCase().split(/\s+/) ?? []
    const href = attrs.get('href')
    if (rel.includes('modulepreload') && href?.endsWith('.js')) assets.add(distAssetPath(href))
  }

  return [...assets].sort()
}

function firstLoadBrotliReport() {
  if (!existsSync(INDEX_HTML)) {
    throw new Error('packages/dashboard/dist/index.html is missing after dashboard build')
  }

  const assets = firstLoadJavascriptAssets(readFileSync(INDEX_HTML, 'utf8'))
  if (assets.length === 0) throw new Error('No first-load JavaScript assets found in packages/dashboard/dist/index.html')

  let total = 0
  const lines = []
  for (const asset of assets) {
    const brotliAsset = `${asset}.br`
    if (!existsSync(brotliAsset)) {
      throw new Error(`Missing Brotli asset for first-load JavaScript: ${relative(ROOT, brotliAsset)}`)
    }
    const size = statSync(brotliAsset).size
    total += size
    lines.push(`- ${relative(ROOT, brotliAsset)}: ${size} B`)
  }

  return { total, details: lines.join('\n') }
}

/** The one `<script src>` in index.html — the app's own entry, never a vendor chunk. */
function entryScriptPath(html) {
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attributes(match[0]).get('src')
    if (src?.endsWith('.js')) return distAssetPath(src)
  }
  throw new Error('No module entry script found in packages/dashboard/dist/index.html')
}

function oversizedJavascriptChunks() {
  const assetsDir = resolve(DASHBOARD_DIST, 'assets')
  if (!existsSync(assetsDir)) {
    throw new Error('packages/dashboard/dist/assets is missing after dashboard build')
  }

  return readdirSync(assetsDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => {
      const asset = resolve(assetsDir, name)
      return { name, size: statSync(asset).size }
    })
    .filter(({ size }) => size > MAX_RAW_JS_CHUNK_SIZE)
    .sort((a, b) => a.name.localeCompare(b.name))
}

// One build, three assertions about it. A second test file would mean a second `pnpm build` of the
// dashboard in CI for no new information — measured at roughly 30 s with the protocol build in front
// of it — which is why the compiler check below lives beside the size ones rather than on its own.
beforeAll(() => {
  buildDashboardDist()
}, 180_000)

describe('the shipped dashboard bundle is compiled by the React Compiler', () => {
  it('emits the compiler memo cache into the entry chunk', () => {
    // **`vitest.config.ts` and `vite.config.ts` need separate guards, and only one of them had a
    // test.** `packages/dashboard/src/__tests__/reactCompilerOn.test.tsx` asserts the compiler ran,
    // but it runs *under vitest* — so it proves the test config applies the compiler and says
    // nothing about the build. Deleting `reactWithCompiler()` from `vite.config.ts` alone left that
    // test green and shipped an uncompiled bundle.
    //
    // The marker is `Symbol.for("react.memo_cache_sentinel")`, which the compiler writes into every
    // function it caches values for. It is a string literal, so minification keeps it, and it lands
    // in app code only when app code was compiled — on an uncompiled build it appears in the React
    // vendor chunk alone, where React itself defines it. Reading the entry chunk rather than the
    // whole first-load set is what keeps the two apart.
    const entry = entryScriptPath(readFileSync(INDEX_HTML, 'utf8'))
    expect(
      readFileSync(entry, 'utf8'),
      `${relative(ROOT, entry)} carries no memo-cache sentinel — the build did not run the React Compiler.`,
    ).toContain('react.memo_cache_sentinel')
  })
})

describe('dashboard first-load JavaScript budget', () => {
  it('keeps first-load Brotli JS below budget', () => {
    const { total, details } = firstLoadBrotliReport()
    expect(
      total,
      `First-load Brotli JS is ${total} B, budget is ${FIRST_LOAD_BROTLI_BUDGET} B.\n\nAssets:\n${details}`,
    ).toBeLessThanOrEqual(FIRST_LOAD_BROTLI_BUDGET)
  })

  it('keeps emitted JavaScript chunks below the Vite large-chunk threshold', () => {
    const oversized = oversizedJavascriptChunks()
    const details = oversized.map(({ name, size }) => `- ${name}: ${size} B`).join('\n')
    expect(
      oversized,
      `JavaScript chunks exceed ${MAX_RAW_JS_CHUNK_SIZE} B raw:\n${details}`,
    ).toHaveLength(0)
  })
})
