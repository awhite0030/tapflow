import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The two primitives every committed-artifact guard in this repo needs.
 *
 * Extracted rather than copied because the two callers must agree: `netfilter-artifact.mjs` hashes a
 * signed `.app` its contributors cannot rebuild, `nethook-artifact.mjs` hashes a dylib they can, and
 * a second implementation of "walk in a stable order, hash path and bytes" is a way for one of them
 * to start hashing a different thing than it says it does.
 *
 * What is *not* shared is what each artifact is allowed to claim. The netfilter record can say
 * `CFBundleVersion`; the dylib has no such thing. Their failure messages differ for the same reason,
 * and that difference is the useful part of each guard rather than duplication to be factored out.
 */

/** Every file under `dir`, recursively, in a stable order. A missing directory yields nothing — the
 *  callers decide whether that is an error, because for them it is. */
export function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out

  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.isFile()) out.push(p)
  }
  return out
}

/** Path + bytes, in a stable order. Path is hashed too: moving a file changes the build. */
export function hashFiles(root, files) {
  const h = createHash('sha256')
  for (const f of files) {
    h.update(path.relative(root, f).split(path.sep).join('/'))
    h.update('\0')
    h.update(fs.readFileSync(f))
    h.update('\0')
  }
  return h.digest('hex')
}
