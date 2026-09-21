import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Ban, Layers, Package } from 'lucide-react'
import { SearchInput } from '@/components/ui/search-input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { UploadBuildDialog } from '@/components/UploadBuildDialog'
import { AppSidebar } from '@/components/app-center/AppSidebar'
import { ReleaseAccordion } from '@/components/app-center/ReleaseAccordion'
import { getApps, getBuilds, updateBuildStatus, scheduleBuildDeletion, cancelBuildDeletion, groupByRelease } from '@/lib/queries'
import type { Build } from '@/lib/types'

export function AppCenter() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  // **What the box holds and what the query asks for are not the same value.** Every keystroke was
  // its own query key, so a four-letter search made four requests and four announcements — the last
  // of which talked over the screen reader echoing the letter just typed. The box stays instant;
  // the key settles.
  const [settledSearch, setSettledSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  useEffect(() => {
    const timer = setTimeout(() => setSettledSearch(search), 250)
    return () => clearTimeout(timer)
  }, [search])
  const [openReleases, setOpenReleases] = useState<Set<string>>(new Set())

  const selectedAppId = searchParams.get('appId') ? Number(searchParams.get('appId')) : null

  const appsQuery = useQuery({ queryKey: ['apps'], queryFn: getApps })
  const apps = appsQuery.data ?? []
  const selectedApp = apps.find(a => a.id === selectedAppId) ?? null

  // **The key carries every input, which is what makes a late answer harmless.** A response for a
  // key nobody is reading any more lands in the cache for that key and is not rendered — the
  // generation counter this page would otherwise hand-roll.
  const buildsKey = ['builds', selectedAppId, settledSearch, statusFilter] as const

  const buildsQuery = useQuery({
    queryKey: buildsKey,
    queryFn: () => getBuilds({ appId: selectedAppId as number, search: settledSearch, statusFilter }),
    enabled: selectedAppId !== null,
    // **The fix for the reported flicker.** While a new key loads, `data` stays the previous key's,
    // so the list on screen is the one the user was just looking at. Without it the page renders
    // with no rows before the answer arrives, and a page with no rows is the empty state.
    placeholderData: keepPreviousData,
  })
  const builds = buildsQuery.data ?? []

  useEffect(() => {
    if (!appsQuery.data || searchParams.get('appId') || appsQuery.data.length === 0) return
    setSearchParams({ appId: String(appsQuery.data[0].id) }, { replace: true })
  }, [appsQuery.data, searchParams, setSearchParams])

  // **Seeded when the new app's own answer arrives, not when it is asked for.** Resetting on the
  // click would collapse the list that is deliberately still on screen — trading the flicker this
  // change removes for a different one.
  // **Which app the rows on screen came from. State, not a ref** — writing and reading a ref during
  // render is a Rules of React violation, and the first version of this did exactly that. The
  // effect below already runs at the moment the answer lands, which is the moment this changes.
  const [shownAppId, setShownAppId] = useState<number | null>(null)

  // **Said on screen too, not only to assistive technology.** The status region below reports a
  // failed refresh, and a sighted user keeps reading a list that may be stale with nothing to say
  // so. Repeats reuse the id, so sonner refreshes one toast rather than stacking — which matters
  // because `refetchOnWindowFocus` is on: a relay that is down would otherwise raise one every
  // time the tab is focused. The list itself stays, because it is still the last good answer.
  useEffect(() => {
    if (!buildsQuery.isRefetchError) return
    toast.error("Couldn't refresh builds — showing the last list", { id: 'builds:refresh' })
  }, [buildsQuery.isRefetchError])

  const seededAppId = useRef<number | null>(null)
  useEffect(() => {
    if (selectedAppId === null || buildsQuery.isPlaceholderData || !buildsQuery.data) return
    if (seededAppId.current === selectedAppId) return
    seededAppId.current = selectedAppId
    setShownAppId(selectedAppId)
    const first = buildsQuery.data[0]
    setOpenReleases(first ? new Set([first.version_name ?? 'Unversioned']) : new Set())
  }, [selectedAppId, buildsQuery.isPlaceholderData, buildsQuery.data])

  function handleAppSelect(id: number) {
    setSearchParams({ appId: String(id) })
  }

  /**
   * Rewrite the rows on screen now, and put them back if the server refuses.
   *
   * The three build actions all follow this shape, and two of them had no rollback at all before —
   * a failed status change left the new label on screen until the next fetch disagreed with it.
   */
  function optimisticRows<V>(apply: (builds: Build[], vars: V) => Build[], failureMessage: string) {
    return {
      onMutate: async (vars: V) => {
        await queryClient.cancelQueries({ queryKey: buildsKey })
        const previous = queryClient.getQueryData<Build[]>(buildsKey)
        queryClient.setQueryData<Build[]>(buildsKey, (old) => (old ? apply(old, vars) : old))
        return { previous }
      },
      onError: (_error: unknown, _vars: V, context: { previous?: Build[] } | undefined) => {
        if (context?.previous) queryClient.setQueryData(buildsKey, context.previous)
        toast.error(failureMessage)
      },
    }
  }

  function handleToggleRelease(versionName: string) {
    setOpenReleases(prev => {
      const next = new Set(prev)
      if (next.has(versionName)) next.delete(versionName)
      else next.add(versionName)
      return next
    })
  }

  type StatusVars = { buildId: number; status: string | null }
  const statusMutation = useMutation({
    mutationFn: ({ buildId, status }: StatusVars) => updateBuildStatus(buildId, status),
    ...optimisticRows<StatusVars>(
      (rows, v) => rows.map(b =>
        b.id === v.buildId ? { ...b, status_label: v.status as Build['status_label'] } : b),
      'Failed to update status',
    ),
  })

  const scheduleMutation = useMutation({
    mutationFn: (buildId: number) => scheduleBuildDeletion(buildId),
    // **The row is marked now and dated on the answer.** The TTL is the server's to decide, so the
    // optimistic pass only says *that* deletion is scheduled; `onSuccess` writes the real
    // `delete_after` it returned.
    ...optimisticRows<number>(
      (rows, buildId) => rows.map(b =>
        b.id === buildId ? { ...b, delete_after: new Date().toISOString() } : b),
      'Failed to schedule deletion',
    ),
    onSuccess: (deleteAfter: string, buildId: number) => {
      queryClient.setQueryData<Build[]>(buildsKey, (old) =>
        old?.map(b => b.id === buildId ? { ...b, delete_after: deleteAfter } : b))
    },
  })

  const cancelMutation = useMutation({
    mutationFn: (buildId: number) => cancelBuildDeletion(buildId),
    ...optimisticRows<number>(
      (rows, buildId) => rows.map(b => b.id === buildId ? { ...b, delete_after: null } : b),
      'Failed to cancel scheduled deletion',
    ),
  })

  const handleStatusChange = (buildId: number, status: string | null) =>
    statusMutation.mutate({ buildId, status })
  const handleScheduleDeletion = (buildId: number) => scheduleMutation.mutate(buildId)
  const handleCancelDeletion = (buildId: number) => cancelMutation.mutate(buildId)

  const releaseGroups = groupByRelease(builds)

  /**
   * What the list is doing, for anyone who cannot see it doing it.
   *
   * **Two things this change introduced are otherwise silent.** The failure state it added is the
   * whole point of the change — "the relay did not answer" against "this app has no builds" — and a
   * message that only appears on screen tells a screen-reader user neither. And holding the previous
   * app's rows while the next ones load means the heading names one app over another app's builds;
   * sighted users read that as a beat of lag, and nothing else said it at all.
   *
   * Mounted unconditionally so the region exists before it has anything to say — a live region that
   * arrives together with its text is the case assistive technology supports worst.
   */
  const appName = selectedApp?.name ?? 'this app'
  const filtered = settledSearch !== '' || statusFilter !== 'all'
  // **Only an app switch is worth announcing as loading.** `isPlaceholderData` is also true for
  // every keystroke in the search box, and saying "Loading…" then "Showing N" per character talks
  // over the screen reader echoing what was typed. Keyed on the app because that is the switch a
  // person is waiting through.
  const switching = buildsQuery.isPlaceholderData && shownAppId !== selectedAppId
  const buildsStatus =
    selectedAppId === null ? ''
      : buildsQuery.isLoadingError ? `Couldn't load builds for ${appName}`
        : buildsQuery.isRefetchError ? `Couldn't refresh builds for ${appName} — showing the last list`
          : buildsQuery.isLoading || switching ? `Loading builds for ${appName}`
            : releaseGroups.length > 0
              ? `Showing ${builds.length} build${builds.length === 1 ? '' : 's'} for ${appName}`
              // "no builds" and "nothing matches" are different facts, and the visible copy below
              // draws the same distinction.
              : filtered ? `No builds match the current filters for ${appName}`
                : `No builds for ${appName}`

  return (
    <div className="flex h-full gap-0">
      <AppSidebar
        apps={apps}
        selectedAppId={selectedAppId}
        onSelect={handleAppSelect}
        onAdd={() => queryClient.invalidateQueries({ queryKey: ['apps'] })}
      />

      <div className="flex-1 flex flex-col gap-4 p-4 overflow-y-auto min-w-0">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-xl font-semibold tracking-display-sm">
            {selectedApp ? selectedApp.name : 'App Center'}
          </h1>
          <UploadBuildDialog
            onSuccess={() => {
              queryClient.invalidateQueries({ queryKey: ['apps'] })
              queryClient.invalidateQueries({ queryKey: ['builds'] })
            }}
            appId={selectedAppId}
          />
        </div>

        <p role="status" className="sr-only">{buildsStatus}</p>

        {!selectedAppId ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center">
            <Layers className="w-8 h-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">No app selected</p>
            <p className="text-sm text-muted-foreground">Choose an app from the sidebar to view its builds.</p>
          </div>
        ) : (
        <>
        <div className="flex flex-wrap gap-2">
          <SearchInput
            aria-label="Search versions"
            placeholder="Search version…"
            value={search}
            onChange={setSearch}
          />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 w-36" aria-label="Filter by status"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="Backlog">Backlog</SelectItem>
              <SelectItem value="In Progress">In Progress</SelectItem>
              <SelectItem value="Done">Done</SelectItem>
              <SelectItem value="Rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {buildsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : buildsQuery.isLoadingError ? (
          /* `isLoadingError`, not `isError`: with `refetchOnWindowFocus` on and no retries, a
             single missed answer while the tab was in the background would otherwise throw away a
             list that is still perfectly good — and take the focus inside it with the rows. A
             failed *refresh* keeps the list and says so through the status region above. */
          /* The same three slots as the empty state below — icon, title, line — because a failure
             and an app with no builds are different facts, not different layouts. Before this the
             failure fell through to that empty state and read as "this app has no builds". */
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center">
            <Ban className="w-8 h-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">Couldn't load builds</p>
            <p className="text-sm text-muted-foreground">Check that the relay is reachable, then try again.</p>
          </div>
        ) : releaseGroups.length === 0 && !buildsQuery.isPlaceholderData ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center">
            <Package className="w-8 h-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">{filtered ? 'No matching builds' : 'No builds yet'}</p>
            <p className="text-sm text-muted-foreground">
              {filtered ? 'No build matches the search and status filters.' : 'Upload the first build to get started.'}
            </p>
          </div>
        ) : releaseGroups.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          /* `aria-busy` while the rows belong to the app you were looking at rather than the one
             the heading now names — the visible half of the same lag. */
          <div className="flex flex-col gap-2" aria-busy={buildsQuery.isPlaceholderData}>
            {releaseGroups.map(({ versionName, builds: groupBuilds }) => (
              <ReleaseAccordion
                key={versionName}
                versionName={versionName}
                builds={groupBuilds}
                isOpen={openReleases.has(versionName)}
                onToggle={() => handleToggleRelease(versionName)}
                onNavigate={(id) => navigate(`/app-center/build?id=${id}`)}
                onStatusChange={handleStatusChange}
                onScheduleDeletion={handleScheduleDeletion}
                onCancelDeletion={handleCancelDeletion}
              />
            ))}
          </div>
        )}
        </>
        )}
      </div>
    </div>
  )
}
