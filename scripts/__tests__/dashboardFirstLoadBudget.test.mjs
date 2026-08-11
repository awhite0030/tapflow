// Protect the metric #168 actually cares about: JavaScript fetched before first paint.
//
// Vite's large-chunk warning only watches individual raw chunks. The first vendor split looked
// good by that signal while adding eager modulepreloads. Build the real dashboard output, read
// index.html, and budget the precompressed Brotli bytes that the relay serves.
import { beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { dirname, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DASHBOARD_DIST = resolve(ROOT, 'packages', 'dashboard', 'dist')
const INDEX_HTML = resolve(DASHBOARD_DIST, 'index.html')
const FIRST_LOAD_BROTLI_BUDGET = 155_000

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

describe('dashboard first-load JavaScript budget', () => {
  beforeAll(() => {
    buildDashboardDist()
  }, 180_000)

  it('keeps first-load Brotli JS below budget', () => {
    const { total, details } = firstLoadBrotliReport()
    expect(
      total,
      `First-load Brotli JS is ${total} B, budget is ${FIRST_LOAD_BROTLI_BUDGET} B.\n\nAssets:\n${details}`,
    ).toBeLessThanOrEqual(FIRST_LOAD_BROTLI_BUDGET)
  })
})
