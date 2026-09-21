import type { App, Build, ReleaseGroup } from '@/lib/types'

export async function getApps(): Promise<App[]> {
  const res = await fetch('/api/v1/apps', { credentials: 'include' })
  // **An empty array is an answer, and a 500 is not one.** Returning `[]` here made every server
  // failure indistinguishable from an account with no apps — and since the App Center now has a
  // failure state, swallowing the status is what would keep it unreachable.
  if (!res.ok) throw new Error(`GET /api/v1/apps failed with ${res.status}`)
  const data = await res.json()
  return data.items
}

export async function getBuilds({
  appId,
  search,
  statusFilter,
}: {
  appId: number
  search?: string
  statusFilter?: string
}): Promise<Build[]> {
  const params = new URLSearchParams({
    app_id: String(appId),
    limit: '100',
    sort: 'uploaded_at',
    dir: 'desc',
  })
  if (search) params.set('q', search)
  if (statusFilter && statusFilter !== 'all') params.set('status', statusFilter)
  const res = await fetch(`/api/v1/builds?${params}`, { credentials: 'include' })
  if (!res.ok) throw new Error(`GET /api/v1/builds failed with ${res.status}`)
  const data = await res.json()
  return data.items
}

export async function createApp(data: {
  name: string
  bundle_id_key: string
  platform: 'ios' | 'android' | 'both'
}): Promise<{ id: number } | { error: string } | null> {
  const res = await fetch('/api/v1/apps', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (res.status === 409) return { error: 'App with this bundle ID and platform already exists' }
  if (!res.ok) return null
  return res.json()
}

export async function updateBuildStatus(
  id: number,
  status: string | null,
): Promise<void> {
  const res = await fetch(`/api/v1/builds/${id}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status_label: status }),
  })
  // Its two siblings below throw; this one did not, so the optimistic label stayed on screen after
  // a refused change and the rollback beside it was unreachable code.
  if (!res.ok) throw new Error(`PATCH /api/v1/builds/${id} failed with ${res.status}`)
}

// Put a build on the deletion clock (server sets delete_after = now + TTL) and
// return the server's authoritative delete_after.
export async function scheduleBuildDeletion(id: number): Promise<string> {
  const res = await fetch(`/api/v1/builds/${id}/schedule-deletion`, { method: 'POST', credentials: 'include' })
  if (!res.ok) throw new Error(`Failed to schedule deletion (${res.status})`)
  const data = await res.json()
  return data.delete_after as string
}

// Take a build back off the deletion clock.
export async function cancelBuildDeletion(id: number): Promise<void> {
  const res = await fetch(`/api/v1/builds/${id}/schedule-deletion`, { method: 'DELETE', credentials: 'include' })
  if (!res.ok) throw new Error(`Failed to cancel scheduled deletion (${res.status})`)
}

export async function getBuild(buildId: string | number): Promise<Build | null> {
  const res = await fetch(`/api/v1/builds/${buildId}`, { credentials: 'include' })
  return res.ok ? res.json() : null
}

export function groupByRelease(builds: Build[]): ReleaseGroup[] {
  const map = new Map<string, Build[]>()
  for (const b of builds) {
    const key = b.version_name ?? 'Unversioned'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(b)
  }
  return Array.from(map.entries()).map(([versionName, builds]) => ({ versionName, builds }))
}
