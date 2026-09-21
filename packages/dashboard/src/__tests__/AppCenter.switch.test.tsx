import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { App, Build } from '@/lib/types'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError, warning: vi.fn() } }))

const { getApps, getBuilds } = vi.hoisted(() => ({ getApps: vi.fn(), getBuilds: vi.fn() }))
vi.mock('@/lib/queries', async (importOriginal) => ({
  // `groupByRelease` is a pure derivation of the fetched rows, so the real one runs: a stub would
  // decide what this suite is asserting about.
  ...(await importOriginal<typeof import('@/lib/queries')>()),
  getApps,
  getBuilds,
}))

import { AppCenter } from '@/src/pages/AppCenter'

const APPS: App[] = [
  { id: 1, name: 'Coffee', bundle_id_key: 'com.a.coffee', platform: 'ios' },
  { id: 2, name: 'Tea', bundle_id_key: 'com.a.tea', platform: 'ios' },
] as unknown as App[]

function build(id: number, version: string): Build {
  return {
    id,
    app_id: 1,
    version_name: version,
    build_number: String(id),
    platform: 'ios',
    status_label: null,
    uploaded_at: '2026-09-21T00:00:00Z',
    uploader: `uploader-${id}`,
    delete_after: null,
  } as unknown as Build
}

/** A promise this test resolves by hand, so the window between click and response is assertable. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function renderAppCenter(entry = '/app-center?appId=1') {
  // A client per test, so one test's cache cannot answer another's query. `retry: 0` matches the
  // app's own default (`lib/queryClient.ts`); `gcTime: 0` keeps nothing behind after unmount.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0, gcTime: 0 }, mutations: { retry: 0 } },
  })
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/app-center" element={<AppCenter />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  // Handed back so a test can force a *refetch* of a key already holding data — the case
  // `isLoadingError` exists to separate from a first load that failed.
  return { ...result, client }
}

const emptyState = () => screen.queryByText('No builds yet')

/**
 * Records whether a string was ever in the DOM, across every commit — not only the ones a test
 * happens to sample.
 *
 * **Sampling after `await userEvent.click(...)` is not enough, and the first draft of the test
 * below proved it by passing against the bug.** That await flushes React's effects, so the render
 * where `builds` had been cleared and `loading` was still false is already gone by the time an
 * assertion runs. The flicker is one commit wide; only something watching every mutation sees it.
 */
function watchForText(text: string) {
  let seen = document.body.textContent?.includes(text) ?? false
  const observer = new MutationObserver((records) => {
    // **The records, not `document.body`.** Observer callbacks are batched into one microtask, so
    // by the time this runs the DOM is already at its latest state and re-reading it sees only
    // that. The second draft of this helper did exactly that and passed against the bug too. What
    // survives is the list of nodes that were inserted, whether or not they are still there.
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.textContent?.includes(text)) { seen = true; return }
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return { get seen() { return seen }, stop: () => observer.disconnect() }
}
const appButton = (name: string) => screen.getByRole('button', { name: new RegExp(name, 'i') })

describe('App Center — switching apps', () => {
  beforeEach(() => {
    // **`reset`, not `clear`.** `clearAllMocks` wipes call history and leaves queued
    // `mockResolvedValueOnce` values in place, so a test that queues more answers than it consumes
    // feeds the next one. These tests were order-dependent on that until debouncing the search
    // changed how many calls each makes.
    vi.resetAllMocks()
    getApps.mockResolvedValue(APPS)
  })
  afterEach(() => vi.restoreAllMocks())

  it('never shows the empty state while the next app is loading', async () => {
    // **The reported bug.** `handleAppSelect` cleared `builds` synchronously while `loading` was
    // still false, so one render fell through to `releaseGroups.length === 0` and drew "No builds
    // yet" — for an app whose builds nobody had asked about yet. What the user saw on one click
    // was list → empty → Loading… → list.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('1.0.0')

    const second = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(second.promise)

    const empty = watchForText('No builds yet')
    // **And the list is not replaced by a spinner either.** Without this the empty state is avoided
    // by falling into the loading branch instead, which is still two changes of screen for one
    // click — the thing that reads as flicker. Watching both is what makes this test fail when
    // `placeholderData` is removed.
    const loading = watchForText('Loading…')
    await userEvent.click(appButton('Tea'))
    second.resolve([build(2, '2.0.0')])
    await screen.findByText('2.0.0')
    empty.stop()
    loading.stop()

    expect(empty.seen).toBe(false)
    expect(loading.seen).toBe(false)
  })

  it('keeps the previous release open until the next app answers', async () => {
    // The other half of the same synchronous reset: `setOpenReleases(new Set())` ran on the click
    // too, so holding the old list without this would show it with every accordion collapsed —
    // a different flicker in place of the one being fixed.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('1.0.0')

    // The header renders whether the release is open or not, so it says nothing about this. The
    // uploader's name comes from a `BuildRow`, and rows exist only inside an *expanded* release.
    const openRow = await screen.findByText('uploader-1')

    const second = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(second.promise)
    await userEvent.click(appButton('Tea'))

    expect(openRow).toBeInTheDocument()

    second.resolve([build(2, '2.0.0')])
    await screen.findByText('2.0.0')
  })

  it('asks once for a search, not once per letter', async () => {
    // Four letters were four query keys, four requests and four announcements. The box is still
    // instant; what reaches the key settles.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')
    getBuilds.mockClear()

    getBuilds.mockResolvedValue([])
    await userEvent.type(screen.getByLabelText('Search versions'), 'zzzz')
    await waitFor(() => expect(screen.getByText('No matching builds')).toBeInTheDocument())

    expect(getBuilds).toHaveBeenCalledTimes(1)
    expect(getBuilds).toHaveBeenCalledWith(expect.objectContaining({ search: 'zzzz' }))
  })

  it('says a failed refresh on screen, and does not stack one toast per attempt', async () => {
    // The status region tells assistive technology; a sighted user reading a list that may be
    // stale was told nothing. Repeats reuse the id because `refetchOnWindowFocus` is on — a relay
    // that is down would otherwise raise one toast every time the tab is focused.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    const { client } = renderAppCenter()
    await screen.findByText('uploader-1')

    getBuilds.mockRejectedValue(new Error('relay blinked'))
    await client.invalidateQueries({ queryKey: ['builds'] })
    await waitFor(() => expect(toastError).toHaveBeenCalled())

    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't refresh builds"),
      expect.objectContaining({ id: 'builds:refresh' }),
    )
    expect(screen.getByText('uploader-1')).toBeInTheDocument()
  })

  it('separates an app with no builds from a filter that matches none', async () => {
    // Two different facts that used to share one sentence. "Upload the first build" is wrong advice
    // for someone who has builds and a search box with `zzz` in it.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    const status = await screen.findByRole('status')
    await waitFor(() => expect(status).toHaveTextContent('Showing 1 build'))

    // Every keystroke is its own query key, so this answers all three.
    getBuilds.mockResolvedValue([])
    await userEvent.type(screen.getByLabelText('Search versions'), 'zzz')

    await waitFor(() => expect(screen.getByText('No matching builds')).toBeInTheDocument())
    expect(screen.queryByText('No builds yet')).toBeNull()
    expect(status).toHaveTextContent('No builds match the current filters')
  })

  it('keeps the list when a background refresh fails', async () => {
    // **`refetchOnWindowFocus` and `retry: 0` are both on, which makes this reachable on an
    // ordinary day**: come back to the tab, the relay misses one answer, and treating every error
    // alike would swap a list that is still good for a full-page failure — taking the focus inside
    // it along with the rows. A failed refresh keeps what is on screen and says so.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    const { client } = renderAppCenter()
    const status = await screen.findByRole('status')
    await waitFor(() => expect(status).toHaveTextContent('Showing 1 build'))

    getBuilds.mockRejectedValueOnce(new Error('relay blinked'))
    await client.invalidateQueries({ queryKey: ['builds'] })

    await waitFor(() => expect(status).toHaveTextContent('Couldn\'t refresh builds'))
    expect(screen.getByText('uploader-1')).toBeInTheDocument()
    expect(screen.queryByText("Couldn't load builds")).toBeNull()
  })

  it('does not announce a search keystroke as loading', async () => {
    // `isPlaceholderData` is true for every character typed into the search box, so announcing on
    // it talks over the screen reader echoing the character. Only a change of app is a wait worth
    // narrating.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    const status = await screen.findByRole('status')
    await waitFor(() => expect(status).toHaveTextContent('Showing 1 build for Coffee'))

    const typed = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(typed.promise)
    await userEvent.type(screen.getByLabelText('Search versions'), '1')

    expect(status).not.toHaveTextContent('Loading builds')

    typed.resolve([build(1, '1.0.0')])
    await waitFor(() => expect(status).toHaveTextContent('Showing 1 build for Coffee'))
  })

  it('does not show the empty state when the app being left was the empty one', async () => {
    // **The same bug the other way round, and the first pass left it in.** Holding the previous
    // app's rows holds its *emptiness* too, so leaving an app with no builds kept a placeholder of
    // `[]` under the new app's name — "No builds yet" for an app whose answer had not arrived.
    // Every other test here switches away from an app that had rows, which is why none of them saw
    // it.
    getBuilds.mockResolvedValueOnce([])
    renderAppCenter()
    await waitFor(() => expect(emptyState()).toBeInTheDocument())

    const second = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(second.promise)
    await userEvent.click(appButton('Tea'))

    expect(emptyState()).toBeNull()

    second.resolve([build(2, '2.0.0')])
    await screen.findByText('2.0.0')
  })

  it('opens the new app\'s first release once its answer arrives', async () => {
    // **The other side of holding the previous list.** Seeding has to wait for the new app's own
    // data; run it during the placeholder window and it seeds from the *previous* app's rows and
    // marks this app as already seeded, so the release that should open never does. That failure
    // is invisible to a test that only checks the previous list stayed put — which is why this one
    // exists beside it.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('uploader-1')

    const second = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(second.promise)
    await userEvent.click(appButton('Tea'))
    second.resolve([build(2, '2.0.0')])

    expect(await screen.findByText('uploader-2')).toBeInTheDocument()
  })

  it('shows the empty state once an app answers with no builds', async () => {
    // The empty state is not being removed — it is being made to wait for an answer.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('1.0.0')

    getBuilds.mockResolvedValueOnce([])
    await userEvent.click(appButton('Tea'))

    await waitFor(() => expect(emptyState()).toBeInTheDocument())
  })

  it('ignores a response that arrives after the selection moved on', async () => {
    // Two clicks, and the first app's response lands last. Nothing cancelled it before, so the
    // stale rows won by arriving late.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('1.0.0')

    const slowFirst = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(slowFirst.promise)
    await userEvent.click(appButton('Tea'))

    getBuilds.mockResolvedValueOnce([build(3, '3.0.0')])
    await userEvent.click(appButton('Coffee'))
    await screen.findByText('3.0.0')

    slowFirst.resolve([build(9, '9.9.9')])
    await waitFor(() => expect(screen.getByText('3.0.0')).toBeInTheDocument())
    expect(screen.queryByText('9.9.9')).toBeNull()
  })

  it('has the status region before it has anything to say', async () => {
    // Entering without `?appId` there is no app and so no status yet. The region still has to be
    // in the tree: assistive technology announces a *change* to a region it is already observing,
    // and one that appears together with its first sentence is the case support is weakest on.
    // Rendering it only when non-empty passes every other test in this file, which is why this one
    // asserts the empty case specifically.
    getApps.mockResolvedValue([])
    renderAppCenter('/app-center')

    const status = screen.getByRole('status')
    expect(status).toBeInTheDocument()
    expect(status).toHaveTextContent('')
  })

  it('says what the list is doing, for someone who cannot see it', async () => {
    // **The failure this change exists to distinguish is silent without this.** "The relay did not
    // answer" and "this app has no builds" are the same screen to anyone not looking at it, and the
    // message that now tells them apart only appears visually. The region is mounted from the start
    // rather than with its text: a live region that arrives together with its content is the case
    // assistive technology supports worst.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    const status = screen.getByRole('status')
    await waitFor(() => expect(status).toHaveTextContent('Showing 1 build for Coffee'))

    const second = deferred<Build[]>()
    getBuilds.mockReturnValueOnce(second.promise)
    await userEvent.click(appButton('Tea'))
    // Held rows belong to the app you were looking at, and the heading already names the other one.
    expect(status).toHaveTextContent('Loading builds for Tea')

    second.resolve([])
    await waitFor(() => expect(status).toHaveTextContent('No builds for Tea'))

    getBuilds.mockRejectedValueOnce(new Error('network'))
    await userEvent.click(appButton('Coffee'))
    await waitFor(() => expect(status).toHaveTextContent("Couldn't load builds"))
  })

  it('distinguishes a failed fetch from an app with no builds', async () => {
    // There was no error path at all: the `finally` lowered `loading` and the empty state took
    // over, so "the request failed" and "this app has no builds" looked identical.
    getBuilds.mockResolvedValueOnce([build(1, '1.0.0')])
    renderAppCenter()
    await screen.findByText('1.0.0')

    getBuilds.mockRejectedValueOnce(new Error('network'))
    await userEvent.click(appButton('Tea'))

    await waitFor(() => expect(screen.getByText("Couldn't load builds")).toBeInTheDocument())
    expect(emptyState()).toBeNull()
  })
})
