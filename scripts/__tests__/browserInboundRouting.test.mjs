import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The relay forwards an agent's reply to the browser with `JSON.stringify(msg)` — it never
// constructs one. So `sendTo(socket, msg: RelayOutbound)` does not see these messages and the
// compiler cannot check them: `AgentToBrowser` could name a message the relay drops, or the relay
// could forward one no consumer's type has ever heard of, and both compile.
//
// That is not a hypothetical gap. All twelve forward-only messages were missing from
// `@tapflowio/protocol` until L3, and the dashboard's hand-copy of the browser-inbound surface had
// diverged in four places with nothing reporting it.
//
// `RelayToBrowser` needs no such check. The relay builds those literals itself and passes them
// through `sendTo`, so the compiler already holds them to the union.

const root = join(import.meta.dirname, '../..')
const relaySrc = readFileSync(join(root, 'packages/relay/src/RelayServer.ts'), 'utf8')
const protocolSrc = readFileSync(join(root, 'packages/protocol/src/index.ts'), 'utf8')

/** Case labels whose block forwards to a browser socket. Labels fall through — two of these blocks
 *  carry thirteen and three labels — so they are accumulated until a block actually opens, and the
 *  block is then read by counting braces rather than by a lazy regex. A regex that stopped at the
 *  first `}` would end at the inner `if`, miss the `send`, and silently report the block as not
 *  forwarding: the direction that makes this check pass while covering nothing. */
function forwardedToBrowser(src) {
  const lines = src.split('\n')
  const found = new Set()
  let pending = []
  let blockLabels = null
  let depth = 0
  let body = ''

  for (const line of lines) {
    if (blockLabels) {
      body += line + '\n'
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
      if (depth <= 0) {
        if (/browserSocket\.send\(JSON\.stringify\(msg\)\)/.test(body)) {
          for (const l of blockLabels) found.add(l)
        }
        blockLabels = null
        body = ''
      }
      continue
    }
    const label = line.match(/^\s*case '([^']+)':/)
    if (label) {
      pending.push(label[1])
      // `case 'x': {` opens on the same line; a bare `case 'x':` falls through to the next label.
      if (/\{\s*$/.test(line)) {
        blockLabels = pending
        pending = []
        depth = 1
        body = ''
      }
      continue
    }
    if (line.trim() && !line.trim().startsWith('//')) pending = []
  }
  return found
}

/** `export interface Name { … }` bodies, by name. L1 moved every message out of its union and into one
 *  of these, so a parser that reads only union bodies now finds nothing — it did, and this file's
 *  `stream:registered` assertion is what said so. */
function interfaceBodies(src) {
  const out = new Map()
  for (const m of src.matchAll(/export interface (\w+)(?: extends (\w+))? \{\n((?:  [^\n]*\n)+)\}/g)) {
    out.set(m[1], { body: m[3].replace(/^\s*\/\/.*$/gm, ''), extends: m[2] ?? null })
  }
  return out
}

const IFACES = interfaceBodies(protocolSrc)

/** The `type` literal an interface declares. A base like `SessionError` carries none. */
function literalOf(name) {
  const m = IFACES.get(name)?.body.match(/^ {2}type: '([^']+)';?$/m)
  return m ? m[1] : null
}

/** Fields of an interface with `extends` resolved, each suffixed `?` when optional, **sorted**.
 *  Declaration order carries no meaning, and `extends SessionError` puts the inherited pair first —
 *  which reordered three signatures that had not otherwise changed. Sorting keeps the check aimed at
 *  what a consumer can observe: which fields exist and which are optional. */
function fieldsOf(name) {
  const decl = IFACES.get(name)
  if (!decl) return null
  const own = []
  let nest = 0
  for (const line of decl.body.split('\n')) {
    const before = nest
    nest += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    if (before !== 0) continue
    // Top-level fields only — a nested `payload: { deviceId: string }` must not contribute `deviceId`.
    const m = line.match(/^ {2}(\w+)(\??):/)
    if (m && m[1] !== 'type') own.push(m[1] + m[2])
  }
  const inherited = decl.extends ? (fieldsOf(decl.extends) ?? '').split(' ').filter(Boolean) : []
  return [...inherited, ...own].sort().join(' ')
}

function unionBody(src, name) {
  const start = src.indexOf(`export type ${name} =`)
  expect(start, `${name} not found in protocol`).toBeGreaterThan(-1)
  const rest = src.slice(start)
  const end = rest.search(/\n\s*\n/)
  return rest.slice(0, end === -1 ? undefined : end).replace(/^\s*\/\/.*$/gm, '')
}

/** Interface names a union denotes, following one level of referenced unions (`| OtherUnion`). */
function unionRefs(src, name) {
  const out = []
  for (const m of unionBody(src, name).matchAll(/^\s*\|\s*(\w+)\s*$/gm)) {
    if (IFACES.has(m[1])) out.push(m[1])
    else out.push(...unionRefs(src, m[1]))
  }
  return out
}

/** Message `type` literals a union denotes. */
function unionMembers(src, name) {
  const types = new Set()
  for (const ref of unionRefs(src, name)) {
    const lit = literalOf(ref)
    expect(lit, `${ref} declares no type literal`).not.toBeNull()
    types.add(lit)
  }
  return types
}

/** The pinned signature lookup: find the interface in this union that owns `type`, return its fields. */
function memberSignature(src, name, type) {
  for (const ref of unionRefs(src, name)) {
    if (literalOf(ref) === type) return fieldsOf(ref)
  }
  return null
}

describe('browser-inbound routing matches the protocol union', () => {
  const forwarded = forwardedToBrowser(relaySrc)
  const declared = unionMembers(protocolSrc, 'AgentToBrowser')

  it('every message the relay forwards to a browser is declared in AgentToBrowser', () => {
    expect([...forwarded].filter((t) => !declared.has(t)).sort()).toEqual([])
  })

  it('every AgentToBrowser member is actually forwarded', () => {
    expect([...declared].filter((t) => !forwarded.has(t)).sort()).toEqual([])
  })

  // A parser that quietly finds nothing passes both assertions above. These pin what it found, so a
  // refactor that moves the forward blocks out of reach fails here instead of going green on an
  // empty set. L2 shipped exactly that mistake in the other direction — a lazy regex truncated a
  // nested literal to 6 of 11 fields and the by-name assertion passed anyway.
  it('the parser reached every forward site', () => {
    expect(forwarded.size).toBe(22)
    const sends = (relaySrc.match(/browserSocket\.send\(JSON\.stringify\(msg\)\)/g) ?? []).length
    expect(sends).toBe(8) // 6 single-label blocks + the 13-label block + the clipboard block
  })

  it('RelayOrAgentToBrowser is shared by both directions rather than copied', () => {
    const shared = unionMembers(protocolSrc, 'RelayOrAgentToBrowser')
    expect(shared.size).toBe(10)
    for (const name of ['RelayToBrowser', 'AgentToBrowser']) {
      expect(protocolSrc).toContain(`export type ${name} =\n  | RelayOrAgentToBrowser`)
    }
  })

  // The field sets, pinned. Without these the check is name-only, and every drift it was written in
  // response to comes back green: turning all twelve `sessionId` optional, re-optionalising
  // `capabilities`, dropping `payload` off `device:shutdown-done` — same names, same counts. `tsc`
  // does not object either, because the dashboard's consumers compare `msg.sessionId === sessionId`
  // and that still compiles against `string | undefined`.
  //
  // `sessionId` is required on all twelve forwarded messages and on the seven shared errors, and on two
  // of the three the relay also replays. `device:ready` is the one exception, and it is deliberate —
  // see the note above the declarations for the measurement.
  //
  // All five message unions are here, not just the browser-inbound three. The bindings in
  // `typeAssertions.ts` pin 58 literals and read like per-message coverage, but a literal is all they
  // pin — measured, `ScreenshotRequest.requestId`, `DeviceBoot.sessionId` and `DeviceBoot.payload.deviceId`
  // could all be made optional with every assertion green, and `sessionId?` is the widening
  // `packages/protocol/AGENTS.md` calls near-irreversible.
  //
  // `payload` is one token here, so a change *inside* a nested literal is still invisible. The named
  // payload types have their field counts pinned in `protocolPayloadTypes`; inline ones like
  // `device:boot`'s do not, and closing that is a separate job.
  const SIGNATURES = {
    AgentToBrowser: {
      'device:booting': 'sessionId',
      'device:shutdown-done': 'payload sessionId',
      'app:install-done': 'requestId sessionId',
      'app:launch-done': 'requestId sessionId',
      'app:clear-state-done': 'requestId sessionId',
      'open-url:done': 'requestId sessionId',
      'input:done': 'sessionId',
      'input:type-done': 'sessionId',
      'input:type-error': 'message sessionId',
      'keyboard:toggled': 'payload sessionId',
      'clipboard:data': 'payload requestId sessionId',
      'clipboard:write-done': 'requestId sessionId',
    },
    RelayOrAgentToBrowser: {
      'session:chrome': 'payload sessionId',
      'session:deviceInfo': 'payload sessionId',
      'device:ready': 'payload sessionId?',
      'app:install-error': 'message requestId sessionId',
      'app:launch-error': 'message requestId sessionId',
      'device:boot-error': 'message sessionId',
      'open-url:error': 'message requestId sessionId',
      'app:clear-state-error': 'message requestId sessionId',
      'input:error': 'message reason? sessionId',
      'clipboard:error': 'message payload? requestId sessionId',
    },
    BrowserToRelay: {
      'agents:list': '',
      'session:start': 'sessionId',
      'session:end': 'sessionId',
      'session:leave': 'sessionId',
      'device:boot': 'payload sessionId',
      'device:shutdown': 'payload sessionId',
      'app:install': 'buildId requestId sessionId',
      'app:launch': 'buildId requestId sessionId',
      'app:clear-state': 'payload requestId sessionId',
      'open-url': 'payload requestId sessionId',
      'input:touch:start': 'payload sessionId',
      'input:touch:move': 'payload sessionId',
      'input:touch:end': 'payload? sessionId',
      'input:pinch:start': 'payload sessionId',
      'input:pinch:move': 'payload sessionId',
      'input:pinch:end': 'sessionId',
      'input:key': 'payload sessionId',
      'input:type': 'payload sessionId',
      'input:button': 'payload sessionId',
      'input:rotate': 'sessionId',
      'input:keyboard:toggle': 'sessionId',
      'clipboard:read': 'payload? requestId sessionId',
      'clipboard:write': 'payload requestId sessionId',
    },
    RelayToAgent: {
      'agent:registered': 'registeredSessions',
      'stream:request-idr': 'sessionId',
      'device:shutdown': 'payload sessionId',
      'app:install': 'payload requestId sessionId',
      'app:launch': 'payload requestId sessionId',
      'screenshot:request': 'format requestId sessionId',
      'ui:tree:request': 'requestId sessionId',
    },
    RelayToBrowser: {
      'agents:listed': 'sessions',
      'session:joined': 'capabilities sessionId',
      'session:terminated': 'reason sessionId',
      'session:agent-away': 'sessionId',
      'session:rebound': 'capabilities sessionId',
      error: 'message reason',
    },
  }

  for (const [union, members] of Object.entries(SIGNATURES)) {
    it(`${union} member fields are unchanged`, () => {
      const actual = {}
      for (const type of Object.keys(members)) actual[type] = memberSignature(protocolSrc, union, type)
      expect(actual).toEqual(members)
    })
  }

  // The whole point of the layer is that this surface has one declaration. A second one is easy to
  // reintroduce — the original was written because a viewer needed a type for its message handler and
  // protocol did not have one — and it costs nothing until it drifts, which is how the last one
  // survived four divergences.
  //
  // Scoped to the whole package and to both spellings, because the first version of this assertion
  // read one file and matched one form: a union written without a leading `|`, or moved to
  // `hooks/useRelay.ts`, walked straight past it. The regex that found the mutation was the only
  // regex the mutation could have failed.
  it('no consumer declares a wire-message union of its own', () => {
    // The vocabulary comes from protocol, so "is this a wire message union" is decided by the wire and
    // not by a shape heuristic. A first version flagged any alias with two `{ type: '…' }` members and
    // reported `flow-runner`'s `Step` — a union of flow steps, which is a domain type and belongs
    // where it is.
    const wire = new Set([...protocolSrc.matchAll(/\{\s*type: '([^']+)'/g)].map((m) => m[1]))
    const found = []
    for (const pkg of ['packages/dashboard', 'packages/mcp-server/src', 'packages/flow-runner/src']) {
      const files = execFileSync('git', ['ls-files', pkg], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes('__tests__'))
      for (const f of files) {
        const src = readFileSync(join(root, f), 'utf8').replace(/^\s*\/\/.*$/gm, '')
        for (const m of src.matchAll(/export type (\w+)\s*=\s*((?:\s*\|?\s*\{[^{}]*\}\s*)+)/g)) {
          const types = [...m[2].matchAll(/type: '([^']+)'/g)].map((t) => t[1]).filter((t) => wire.has(t))
          if (types.length >= 2) found.push(`${f}: ${m[1]} (${types.join(', ')})`)
        }
      }
    }
    expect(found).toEqual([])
    expect(readFileSync(join(root, 'packages/dashboard/lib/types.ts'), 'utf8')).toMatch(/BrowserInbound/)
  })

  // Removing the payload casts made the clipboard bridge's *shapes* compiler-checked, but the list of
  // types `DeviceViewer` routes into it is still plain control flow that nothing reads. Dropping
  // `clipboard:write-done` from that condition leaves every dashboard test green — the bridge's own
  // tests call `handlerRef.current` directly and skip the viewer — and the user sees a paste that
  // lands on the device followed by "the device is taking too long".
  //
  // Both sides are derived, so the guard cannot drift with either one.
  it('DeviceViewer routes exactly the messages the clipboard bridge declares', () => {
    const bridge = readFileSync(join(root, 'packages/dashboard/hooks/useClipboardBridge.ts'), 'utf8')
    const viewer = readFileSync(join(root, 'packages/dashboard/components/DeviceViewer.tsx'), 'utf8')

    // L1 replaced the `Extract<>` with named members, so the expected set comes from resolving those
    // names to their literals — still derived from the bridge's own declaration, not restated here.
    // Up to the next blank line, not the next newline. A one-line capture truncates the moment the
    // declaration wraps, and it truncates *silently*: `wanted` loses the trailing members, and if the
    // author also forgot to route them then `routed` is short by the same ones and the sets match. The
    // count pin below does not help — the truncation lands on exactly the old count.
    const declared = bridge.match(/export type ClipboardBridgeMessage =([\s\S]*?)\n\s*\n/)
    expect(declared, 'ClipboardBridgeMessage is no longer a union of named wire messages').not.toBeNull()
    const wanted = declared[1].split('|').map((n) => n.trim()).filter(Boolean).map((n) => {
      const lit = literalOf(n)
      expect(lit, `${n} is not a protocol message interface`).not.toBeNull()
      return lit
    }).sort()

    const at = viewer.indexOf('clipboardHandlerRef.current?.(msg)')
    expect(at, 'DeviceViewer no longer routes into the clipboard bridge').toBeGreaterThan(-1)
    const condition = viewer.slice(viewer.lastIndexOf('if (', at), at)
    const routed = [...condition.matchAll(/msg\.type === '([^']+)'/g)].map((m) => m[1]).sort()

    expect(routed).toEqual(wanted)
    expect(wanted.length).toBe(3)
  })

  it('stream:registered is not on the browser-inbound surface', () => {
    // It goes to an agent's stream socket; the consumer is agent-core's stream registration. It sat
    // in `RelayToBrowser` because that union was "everything that is not an agent".
    const inbound = new Set([...unionMembers(protocolSrc, 'BrowserInbound')])
    expect(inbound.has('stream:registered')).toBe(false)
    expect(unionMembers(protocolSrc, 'RelayToStream').has('stream:registered')).toBe(true)
  })
})
