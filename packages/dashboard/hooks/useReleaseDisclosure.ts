import { useState } from 'react'

const STORAGE_PREFIX = 'tapflow-app-center-releases:'
// A search narrows the list, so a release missing from it may be hidden rather than deleted, and
// nothing here can tell which. Entries are never pruned by presence; the oldest toggles past this
// many fall off instead.
const MAX_TOGGLES = 200

/** Releases the person opened (`true`) or closed (`false`) themselves, oldest first. */
type Toggles = Record<string, boolean>

function readToggles(appId: number): Toggles {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_PREFIX + appId) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([, open]) => typeof open === 'boolean'))
  } catch {
    return {}
  }
}

function writeToggles(appId: number, toggles: Toggles): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + appId, JSON.stringify(toggles))
  } catch {
    /* no storage: the toggle still holds for this visit */
  }
}

/**
 * Which releases of an app's list are open — remembered per app, in this browser.
 *
 * **Only what the person toggled is stored.** A release nobody touched follows the default, the
 * newest open and the rest closed, so a version uploaded since the last visit arrives open while one
 * deliberately collapsed stays collapsed. Storing the whole open set instead would have shown every
 * new upload closed — the version a person most often comes to look at.
 *
 * **Derived during render, not seeded by an effect** (#834). The seed ran after the commit that
 * showed the list, so when a retry brought the list back and focus moved to the first release
 * header, that header was announced collapsed and then reported its own expansion.
 *
 * `appId` is the app whose rows are on screen, which during an app switch is still the previous one.
 */
export function useReleaseDisclosure(appId: number | null, releaseNames: readonly string[]) {
  // Toggles made during this visit, by app. An app not in here is read from storage.
  const [visit, setVisit] = useState<ReadonlyMap<number, Toggles>>(() => new Map())
  const toggles: Toggles = appId === null ? {} : (visit.get(appId) ?? readToggles(appId))
  const newest = releaseNames[0]

  const isOpen = (name: string): boolean => toggles[name] ?? name === newest

  const toggle = (name: string): void => {
    if (appId === null) return
    const { [name]: _previous, ...rest } = toggles
    // Re-inserted last, so the cap drops the release toggled longest ago.
    const next = Object.fromEntries(Object.entries({ ...rest, [name]: !isOpen(name) }).slice(-MAX_TOGGLES))
    writeToggles(appId, next)
    setVisit((prev) => new Map(prev).set(appId, next))
  }

  return { isOpen, toggle }
}
