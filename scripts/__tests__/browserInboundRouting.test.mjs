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

/** One member's field names, each suffixed `?` when optional. The names are the cheap half of this
 *  file and they are not the substance: the twelve new declarations exist for their *fields*, and a
 *  name-only check stays green if every one of them loses `sessionId` or turns it optional. */
function memberSignature(src, name, type) {
  const body = unionBody(src, name)
  const at = body.indexOf(`{ type: '${type}'`)
  if (at === -1) return null
  let depth = 0
  let end = at
  for (; end < body.length; end++) {
    if (body[end] === '{') depth++
    else if (body[end] === '}' && --depth === 0) break
  }
  const inner = body.slice(at + 1, end)
  // Top-level fields only — a nested `payload: { deviceId: string }` must not contribute `deviceId`.
  const fields = []
  let nest = 0
  for (const part of inner.split(';')) {
    const before = nest
    nest += (part.match(/\{/g) ?? []).length - (part.match(/\}/g) ?? []).length
    if (before !== 0) continue
    const m = part.match(/^\s*(\w+)(\??):/)
    if (m && m[1] !== 'type') fields.push(m[1] + m[2])
  }
  return fields.join(' ')
}

function unionBody(src, name) {
  const start = src.indexOf(`export type ${name} =`)
  const rest = src.slice(start)
  const end = rest.search(/\n\s*\n/)
  return rest.slice(0, end === -1 ? undefined : end).replace(/^\s*\/\/.*$/gm, '')
}

/** Members of a union type, following one level of referenced unions (`| OtherUnion`). */
function unionMembers(src, name) {
  const start = src.indexOf(`export type ${name} =`)
  expect(start, `${name} not found in protocol`).toBeGreaterThan(-1)
  const rest = src.slice(start)
  const end = rest.search(/\n\s*\n/)
  // Comments out, or a member is whatever the prose mentions: the note on `RelayOrAgentToBrowser`
  // points at `{ type: 'error' }` to explain why that one is NOT shared, and the parser read it as
  // an eleventh member — a false positive that reads exactly like a real declaration.
  const body = rest.slice(0, end === -1 ? undefined : end).replace(/^\s*\/\/.*$/gm, '')

  const types = new Set()
  for (const m of body.matchAll(/\{\s*type: '([^']+)'/g)) types.add(m[1])
  for (const m of body.matchAll(/^\s*\|\s*([A-Z]\w+)\s*$/gm)) {
    for (const t of unionMembers(src, m[1])) types.add(t)
  }
  return types
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
  // `sessionId` is required on all twelve forwarded messages and on the seven shared errors; it is
  // optional on exactly the three the relay also replays without one (see the note in the union).
  const SIGNATURES = {
    AgentToBrowser: {
      'device:booting': 'sessionId',
      'device:shutdown-done': 'sessionId payload',
      'app:install-done': 'sessionId',
      'app:launch-done': 'sessionId',
      'app:clear-state-done': 'sessionId',
      'open-url:done': 'sessionId',
      'input:done': 'sessionId',
      'input:type-done': 'sessionId',
      'input:type-error': 'sessionId message',
      'keyboard:toggled': 'sessionId payload',
      'clipboard:data': 'sessionId requestId payload',
      'clipboard:write-done': 'sessionId requestId',
    },
    RelayOrAgentToBrowser: {
      'session:chrome': 'sessionId? payload',
      'session:deviceInfo': 'sessionId? payload',
      'device:ready': 'sessionId? payload',
      'app:install-error': 'sessionId message',
      'app:launch-error': 'sessionId message',
      'device:boot-error': 'sessionId message',
      'open-url:error': 'sessionId message',
      'app:clear-state-error': 'sessionId message',
      'input:error': 'sessionId message reason?',
      'clipboard:error': 'sessionId requestId message payload?',
    },
    RelayToBrowser: {
      'agents:listed': 'sessions',
      'session:joined': 'sessionId capabilities',
      'session:terminated': 'sessionId reason',
      'session:agent-away': 'sessionId',
      'session:rebound': 'sessionId capabilities',
      error: 'message',
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

    const declared = bridge.match(/export type ClipboardBridgeMessage = Extract<[\s\S]*?>\n/)
    expect(declared, 'ClipboardBridgeMessage is no longer an Extract<> of the wire union').not.toBeNull()
    const wanted = [...declared[0].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()

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
