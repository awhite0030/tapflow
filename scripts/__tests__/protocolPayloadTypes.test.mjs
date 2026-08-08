import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

// L2 of the wire-contract work (`.work/WIRE-CONTRACT-PLAN.md`). Wire payload types were declared in
// three to five packages each and had drifted in both directions: protocol lacked
// `clipboard:error`'s payload while the dashboard's `session:chrome` lacked three fields its own
// viewer reads. `@tapflowio/protocol` owns them now.
//
// **Matched by field set, never by name.** The inventory that planned this work grepped for names and
// missed two of five copies of one shape, because `mcp-server` and `flow-runner` called it
// `DeviceInfo` while protocol calls it `DeviceSummary` and the dashboard called it `AgentDevice`. A
// name-scoped check would have passed with all five standing, and would be bypassed by a rename.
//
// Source text, not an import: protocol's main entry must stay runtime-free so it erases under
// `import type` (see its AGENTS.md HOW NOT), so this cannot load the types as values. Same technique
// as `inputErrorReason.test.mjs`.

const ROOT = new URL('../..', import.meta.url).pathname
const PROTOCOL = join(ROOT, 'packages/protocol/src/index.ts')

/**
 * `interface X { … }` **and** `type X = { … }` → field names, with `?` kept so optionality is part of
 * the identity.
 *
 * Both forms, and a body that fits on one line, because a pre-PR review planted five duplicates and an
 * earlier version of this reported **one**: it required the `interface` keyword and a closing brace at
 * the start of a line, so a `type` alias and a single-line interface both walked past. A check whose
 * whole purpose is to be un-bypassable has to accept every form the duplicate can take.
 */
function interfaces(src) {
  const out = new Map()
  const re = /(?:export\s+)?(?:interface\s+(\w+)(?:\s+extends\s+([\w,\s]+?))?\s*|type\s+(\w+)\s*=\s*)\{([\s\S]*?)\}/g
  for (const m of src.matchAll(re)) {
    const [, iName, ext, tName, body] = m
    const name = iName ?? tName
    const fields = []
    let depth = 0
    for (const raw of body.split(/[\n;]/)) {
      const line = raw.replace(/\/\/.*/, '').trim()
      if (!line) continue
      // Only top-level members count; an inline object literal's own keys are not fields of this type.
      if (depth === 0) {
        const f = line.match(/^(\w+\??)\s*:/)
        if (f) fields.push(f[1])
      }
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    }
    out.set(name, { fields, extends: ext ? ext.split(',').map((s) => s.trim()) : [] })
  }
  return out
}

/** Field set including inherited members, resolved within the same file. */
function resolved(decls, name, seen = new Set()) {
  if (seen.has(name)) return []
  seen.add(name)
  const d = decls.get(name)
  if (!d) return []
  return [...d.fields, ...d.extends.flatMap((e) => resolved(decls, e, seen))]
}

const key = (fields) => [...new Set(fields)].sort().join(',')

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

const protoDecls = interfaces(readFileSync(PROTOCOL, 'utf8'))
/** Payload types worth guarding. Two fields is enough to be a real shape; one is a coincidence. */
const guarded = new Map()
for (const name of protoDecls.keys()) {
  const fields = resolved(protoDecls, name)
  if (fields.length >= 2) guarded.set(key(fields), name)
}

// A local declaration that legitimately shares a shape. Each entry needs a reason, because the
// default answer is "import it from protocol instead".
const ALLOWED = new Set([
  // Same four fields as `ChromeRect`, different concept: the frame of an accessibility-tree element,
  // which has nothing to do with device chrome. Shape matching cannot tell those apart, and merging
  // them would couple the UI-tree schema to the bezel artwork. This is the known cost of matching by
  // shape instead of by name — and the cost is worth paying, since name matching missed two of five
  // copies of one shape when this work was planned.
  'agent-core:UIElementFrame',
  // `AgentSession` in mcp-server and flow-runner is `SessionInfo` minus `resources` — a narrower view
  // for a client that does not read them, not a copy. Its field set differs so it never matches;
  // listed so the next reader knows it was considered rather than missed.
])

describe('wire payload types are declared once, in @tapflowio/protocol', () => {
  // A count floor is the wrong assertion: 13 shapes are guarded, so losing three still passed, and
  // converting one protocol `interface` to a `type` alias used to drop it from the guard silently —
  // taking every duplicate of that shape with it. Name the ones that must be there.
  it('guards the payload shapes by name, so a shape cannot silently leave', () => {
    const byName = new Set(guarded.values())
    for (const name of [
      'ChromeData', 'ChromeButton', 'ChromeRect', 'AndroidButton', 'AndroidChrome',
      'AgentResources', 'SessionInfo', 'DeviceSummary', 'DeviceDetails', 'ClipboardErrorPayload',
    ]) {
      expect(byName, name).toContain(name)
    }
  })

  it('no other package re-declares a protocol payload shape', () => {
    const offenders = []
    // Every workspace member, not just `packages/*`: `playground` is one and `playground/mock-agent.ts`
    // builds an `AgentResources` of its own. A duplicate there drifts exactly like one in a package.
    const roots = [
      ...readdirSync(join(ROOT, 'packages')).map((p) => ['packages', p]),
      ['.', 'playground'],
    ]
    for (const [parent, pkg] of roots) {
      if (pkg === 'protocol') continue
      const base = join(ROOT, parent, pkg)
      let files
      try { files = walk(base) } catch { continue }
      for (const file of files) {
        const src = readFileSync(file, 'utf8')
        const decls = interfaces(src)
        for (const name of decls.keys()) {
          const k = key(resolved(decls, name))
          const match = guarded.get(k)
          if (match && !ALLOWED.has(`${pkg}:${name}`)) {
            offenders.push(`${file.slice(ROOT.length)} declares ${name}, same shape as protocol's ${match}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
