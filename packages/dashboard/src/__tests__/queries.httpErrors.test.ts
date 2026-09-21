import { describe, it, expect, vi, afterEach } from 'vitest'
import { getApps, getBuilds, updateBuildStatus } from '@/lib/queries'

/**
 * **An empty array is an answer, and a 500 is not one.**
 *
 * `getApps` and `getBuilds` used to `return []` on `!res.ok`, and `updateBuildStatus` did not look
 * at the status at all. So a server error, a 502 from a proxy, or a session that had expired all
 * resolved *successfully* with zero rows — and the App Center, whose whole failure state was added
 * to tell "the request failed" apart from "this app has no builds", rendered the second one.
 *
 * It was invisible to the page's own tests because every one of them drove failure with
 * `mockRejectedValue`, which is the shape a dead relay produces and the only one these helpers
 * already passed through. These exercise the helpers themselves, against a `fetch` that answers.
 */
afterEach(() => vi.unstubAllGlobals())

function respondWith(status: number, body: unknown = { items: [] }) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })))
}

describe('the fetch helpers the App Center reads through', () => {
  it.each([
    ['getApps', () => getApps()],
    ['getBuilds', () => getBuilds({ appId: 1, search: '', statusFilter: 'all' })],
    ['updateBuildStatus', () => updateBuildStatus(1, 'Done')],
  ])('%s rejects on a 500 rather than answering with nothing', async (_name, call) => {
    respondWith(500)
    await expect(call()).rejects.toThrow(/500/)
  })

  it.each([
    ['getApps', () => getApps()],
    ['getBuilds', () => getBuilds({ appId: 1, search: '', statusFilter: 'all' })],
  ])('%s rejects on a 401, which is a session to renew and not an empty account', async (_name, call) => {
    respondWith(401)
    await expect(call()).rejects.toThrow(/401/)
  })

  it('still answers with an empty list when the server really says there is nothing', async () => {
    // The point is to stop conflating the two, not to make emptiness an error.
    respondWith(200, { items: [] })
    await expect(getBuilds({ appId: 1, search: '', statusFilter: 'all' })).resolves.toEqual([])
  })
})
