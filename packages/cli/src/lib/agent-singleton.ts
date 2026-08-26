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

/** Kept short on purpose: `sun_path` is **104 bytes** on Darwin and a longer path fails `EINVAL` at
 *  `listen`, which was measured the first time this was tried from a nested temp directory. */
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
  const alive = await ownerIsAlive(path)
  if (alive) return { held: false, reason: 'in-use' }

  try { unlinkSync(path) } catch { /* nothing to clear */ }
  const server = net.createServer((c) => {
    // The probe only needs the connection to succeed. Closing immediately keeps the backlog empty, so
    // a probe can never be refused because this agent was busy rather than gone.
    c.destroy()
  })
  server.unref()
  return await new Promise<ClaimResult>((resolve) => {
    server.once('error', () => { resolve({ held: false, reason: 'in-use' }) })
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
