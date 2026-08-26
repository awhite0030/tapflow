import net from 'node:net'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * One agent per Mac, per platform — claimed at startup and refused rather than fought over.
 *
 * **This exists because the alternative was an ownership model, and the ownership model was the wrong
 * answer to the wrong question.** Two agents on one Mac both enumerate the same host-wide simulator
 * list and both write the same host-wide filter rule, so the second one starting used to put every
 * device the first had taken offline back online. Making that *correct* would mean tracking who owns
 * each device across processes, in a store with no owner and no transactions, read from a synchronous
 * path — three design rounds established that the system has nowhere to keep that fact.
 *
 * The relay had already answered the question: agent identity there is `IOPlatformUUID` + platform,
 * one per Mac, and a second registration **evicts the first agent's socket**. So the configuration is
 * not supported; it just failed late, at the filter, instead of early, with a sentence.
 *
 * **Parallelism is untouched.** One agent manages every simulator on its Mac, and many testers on
 * many devices is exactly what already works. What is refused is a second `tapflow agent start` for
 * the same platform on the same machine.
 */

/**
 * Kept short on purpose: `sun_path` is **104 bytes** on Darwin and a longer path fails `EINVAL` at
 * `listen`, which was measured the first time this was tried from a nested temp directory.
 *
 * **`tmpdir()` is per user account on macOS, so this claim is too** — a second macOS account, or a
 * `sudo` run whose `env_reset` drops `TMPDIR`, resolves a different path and both would take the
 * slot. The resource being protected is machine-wide, so that is a gap and not a design.
 *
 * What it degrades to is today's behaviour rather than something new: the relay identifies agents by
 * `IOPlatformUUID` + platform, so a second one still collapses into the first there — noisily, at
 * registration, instead of quietly at the filter. Fixing it properly needs a machine-wide directory,
 * and the candidates each carry their own permission model (`/var/run` needs root; a world-writable
 * `/tmp` has a sticky bit that stops one account clearing another's corpse). Not decided here.
 */
export function claimPath(platform: string, dir = tmpdir()): string {
  return join(dir, `tapflow-agent-${platform}.sock`)
}

export type ClaimResult =
  | { held: true; release: () => void }
  | { held: false; reason: 'in-use' }

/**
 * Take the claim, or report that a live agent already holds it.
 *
 * Liveness is the kernel's answer, not a heuristic: while the owner runs it accepts the connection,
 * and when it dies — **including `kill -9`, where no cleanup code runs** — the listener goes with the
 * process and a probe gets `ECONNREFUSED` even though the socket file survives. Measured. That is why
 * this is a socket and not a pid file, a lock file, or a timestamp: none of those releases itself.
 *
 * `ENOENT` and `ECONNREFUSED` both mean "nobody is home"; they differ only in whether a corpse was
 * left behind, and the corpse is unlinked before taking over.
 */
export async function claimAgentSlot(platform: string, dir = tmpdir()): Promise<ClaimResult> {
  const path = claimPath(platform, dir)
  // **Bind first, and let the kernel be the one that decides.**
  //
  // Probing and then unlinking before binding is not a claim, it is a race with a suggestion in it:
  // two agents starting together both see nothing alive, and the second one's `unlink` removes the
  // socket the first has already bound — so both bind, both run, and the first becomes invisible to
  // every later probe. Measured before this was written: two concurrent calls both answered `held`.
  //
  // `bind(2)` is atomic against another `bind(2)`, so the only serialising thing here is the one the
  // kernel already provides. `EADDRINUSE` is then the question — a live owner or a corpse — and only
  // then is it worth asking.
  const first = await listenOn(path)
  if (first) return first
  if (await ownerIsAlive(path)) return { held: false, reason: 'in-use' }

  // A corpse: the file outlived the process that bound it. Clearing it is safe *because* nothing
  // answered, and the retry is single because a second `EADDRINUSE` means somebody won the race in
  // between — which is the correct answer, not something to keep trying past.
  try { unlinkSync(path) } catch { /* another starter got there first */ }
  return (await listenOn(path)) ?? { held: false, reason: 'in-use' }
}

function listenOn(path: string): Promise<{ held: true; release: () => void } | null> {
  return new Promise((resolve) => {
    const server = net.createServer((c) => {
      // A probe only needs the connection to succeed. Closing at once keeps the backlog empty, so a
      // probe is never refused for being queued behind other probes — which would read as "gone".
      c.destroy()
    })
    // Nothing should stay alive for this handle alone; the agent's relay socket is what holds the
    // process open.
    server.unref()
    server.once('error', () => { resolve(null) })
    server.listen(path, () => {
      resolve({
        held: true,
        release: () => {
          server.close()
          try { unlinkSync(path) } catch { /* already gone */ }
        },
      })
    })
  })
}

function ownerIsAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(path)
    probe.once('connect', () => { probe.destroy(); resolve(true) })
    probe.once('error', () => { probe.destroy(); resolve(false) })
  })
}
