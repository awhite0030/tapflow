import { QueryClient } from '@tanstack/react-query'

/**
 * The dashboard's query defaults.
 *
 * **`retry: 0`.** The library retries three times with backoff, which would put a failure's message
 * on screen about seven seconds after the failure — and this page's error surface is new, so a
 * delay that long makes it hard to tell a working surface from a broken one. Turning retries on is
 * a one-line change to make later, on its own evidence.
 *
 * **`refetchOnWindowFocus: true`.** Builds change without anyone on this page doing anything: CI
 * uploads them. The dashboard is the kind of screen a team leaves open on a second monitor, so
 * coming back to it is the moment to ask whether something new landed. `UploadBuildDialog` already
 * hand-rolls one case of this by calling the fetch again on success.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 0,
        refetchOnWindowFocus: true,
        // **`navigator.onLine` says nothing about whether the relay is reachable.** tapflow's
        // relay is on this machine or this LAN, so a laptop with Wi-Fi off can still serve the
        // whole product. The default (`'online'`) would pause the query instead of running it, and
        // a paused query is neither loading nor failed nor holding a placeholder — so the App
        // Center would render "No builds yet" for an app full of builds.
        networkMode: 'always',
      },
    },
  })
}
