import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// An agent's outbound literal is the one place in the wire contract the compiler could not see. The relay
// forwards with `JSON.stringify(msg)`, so a reply is never re-created by anything typed, and an agent used
// to hand its literal straight to `ws.send`. #489 (an agent answering nobody) and #490 (a missing `reason`)
// both came out of that gap, and `inputErrorReason.test.mjs` exists because a script had to stand in for a
// compiler.
//
// L4a closed it with two typed helpers per agent. This file's only job is that nothing goes **around** them.
//
// It matches **serialization**, not a spelling of `.send`. Three earlier drafts of this check were bypassed
// in review by renaming the socket: `streamWs.send(JSON.stringify(…))` and `const alias = this.ws;
// alias?.send(…)` both walked past a pattern keyed on `this.ws`, and the first is not hypothetical —
// `streamWs` is in scope in `startBinaryStream`, and the relay dispatches a text frame from a stream socket
// through the same agent cases. `const p = JSON.stringify(m); alias?.send(p)` defeated it too.
//
// So the rule is: in a file that writes to a socket, `JSON.stringify` appears only inside a send helper.
// Binary frames do not serialize, and files that stringify for other reasons (shell quoting in
// `DeviceChromeLoader`) never touch `.send(`.

const root = join(import.meta.dirname, '../..')

/** Comments out, including `/* … *\/` blocks. A commented-out copy of the canonical helper satisfied the
 *  positive assertion below while the real one took `msg: object` — 66 sends unchecked, check green. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Files in the agent packages that hold a socket, and the helper bodies allowed to serialize. */
const AGENTS = {
  'ios-agent': 'packages/ios-agent/src/IOSAgent.ts',
  'android-agent': 'packages/android-agent/src/AndroidAgent.ts',
}

const HELPER_BODIES = [
  /private sendMsg\(msg: AgentControlOutbound\): void \{\n {4}this\.ws\?\.send\(JSON\.stringify\(msg\)\)\n {2}\}/,
  /private sendOn\(ws: WebSocket, msg: AgentControlOutbound\): void \{\n {4}ws\.send\(JSON\.stringify\(msg\)\)\n {2}\}/,
]

describe('agent sends go through the typed helpers', () => {
  for (const [name, path] of Object.entries(AGENTS)) {
    const src = stripComments(readFileSync(join(root, path), 'utf8'))

    it(`${name} declares both helpers`, () => {
      // Read from the comment-stripped source, so a decoy in a comment cannot satisfy it.
      for (const rx of HELPER_BODIES) expect(src).toMatch(rx)
    })

    it(`${name} serializes nothing outside them`, () => {
      let rest = src
      for (const rx of HELPER_BODIES) rest = rest.replace(rx, '')
      expect([...rest.matchAll(/JSON\.stringify/g)].map((m) => rest.slice(Math.max(0, m.index - 60), m.index + 30))).toEqual([])
    })
  }

  it('the control socket bound excludes StreamToRelay', () => {
    // Re-merging them would hand back the hazard the direction split exists to avoid: the relay's
    // `case 'stream:register'` calls `setStreamSocket(session.id, ws)` with no role gate, so a control
    // socket that could type-check that message could take over the session's video path.
    const proto = readFileSync(join(root, 'packages/protocol/src/index.ts'), 'utf8')
    expect(proto).toContain('export type AgentControlOutbound = AgentToRelay | AgentToBrowser')
    expect(proto).not.toMatch(/AgentControlOutbound = [^\n]*StreamToRelay/)
  })

  it('every other socket-holding file in the agent packages is accounted for', () => {
    // The two agents above are not the whole surface: `stream.ts` sends on the stream socket, and a new file
    // could add another. Anything that both writes to a socket and serializes has to be listed here with a
    // reason, so adding one is a decision rather than an omission.
    const ALLOWED = new Map([
      ['packages/agent-core/src/utils/stream.ts',
        'the stream socket, handed in as an argument; typed at its send site as StreamToRelay'],
    ])
    const offenders = []
    for (const pkg of ['packages/ios-agent/src', 'packages/android-agent/src', 'packages/agent-core/src']) {
      const files = execFileSync('git', ['ls-files', pkg], { cwd: root, encoding: 'utf8' })
        .split('\n').filter((f) => f.endsWith('.ts') && !f.includes('__tests__'))
      for (const f of files) {
        if (Object.values(AGENTS).includes(f) || ALLOWED.has(f)) continue
        const body = stripComments(readFileSync(join(root, f), 'utf8'))
        if (/\.send\(/.test(body) && /JSON\.stringify/.test(body)) offenders.push(f)
      }
    }
    expect(offenders).toEqual([])
    // And the listed one really is what its reason says.
    const stream = stripComments(readFileSync(join(root, 'packages/agent-core/src/utils/stream.ts'), 'utf8'))
    expect(stream).toMatch(/const register: StreamToRelay = \{ type: 'stream:register', sessionId \}/)
    expect([...stream.matchAll(/JSON\.stringify/g)]).toHaveLength(1)
  })
})
