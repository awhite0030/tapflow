import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionManager } from '../SessionManager'
import type { WebSocket } from 'ws'

// `readyState` matters: `list()` leaves out sessions whose agent socket is closed, because those
// are being held for a returning agent and are not something anyone can pick (#426).
const OPEN = 1
const mockSocket = () => ({ readyState: OPEN } as WebSocket)
const closedSocket = () => ({ readyState: 3 } as WebSocket)

describe('SessionManager', () => {
  describe('create()', () => {
    it('returns an empty array when no devices given', () => {
      const sm = new SessionManager()
      const ids = sm.create(mockSocket(), [])
      expect(ids).toEqual([])
    })

    it('creates one session per device and returns sessionIds', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      const devices = [
        { id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' },
        { id: 'devB', name: 'iPhone B', platform: 'ios', status: 'shutdown' },
      ]
      const ids = sm.create(ws, devices)
      expect(ids).toHaveLength(2)
      expect(typeof ids[0]).toBe('string')
      expect(typeof ids[1]).toBe('string')
      expect(ids[0]).not.toBe(ids[1])
    })

    it('each session stores the correct deviceId', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      const devices = [
        { id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' },
        { id: 'devB', name: 'iPhone B', platform: 'ios', status: 'shutdown' },
      ]
      const [idA, idB] = sm.create(ws, devices)
      expect(sm.get(idA)?.deviceId).toBe('devA')
      expect(sm.get(idB)?.deviceId).toBe('devB')
    })

    it('sessions share the same agentSocket', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      const [idA, idB] = sm.create(ws, [
        { id: 'devA', name: 'A', platform: 'ios', status: 'shutdown' },
        { id: 'devB', name: 'B', platform: 'ios', status: 'shutdown' },
      ])
      expect(sm.get(idA)?.agentSocket).toBe(ws)
      expect(sm.get(idB)?.agentSocket).toBe(ws)
    })

    it('new sessions start with null browserSocket and streamSocket', () => {
      const sm = new SessionManager()
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      const s = sm.get(id)!
      expect(s.browserSocket).toBeNull()
      expect(s.streamSocket).toBeNull()
    })
  })

  describe('get()', () => {
    it('returns undefined for unknown sessionId', () => {
      const sm = new SessionManager()
      expect(sm.get('unknown')).toBeUndefined()
    })

    it('retrieves a created session', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      const [id] = sm.create(ws, [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      expect(sm.get(id)?.agentSocket).toBe(ws)
    })
  })

  describe('getAllByAgentSocket()', () => {
    it('returns all sessions for a given agent socket', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      const ids = sm.create(ws, [
        { id: 'devA', name: 'A', platform: 'ios', status: 'shutdown' },
        { id: 'devB', name: 'B', platform: 'ios', status: 'shutdown' },
      ])
      const found = sm.getAllByAgentSocket(ws)
      expect(found).toHaveLength(2)
      expect(found.map((s) => s.id).sort()).toEqual(ids.sort())
    })

    it('returns empty array for an unknown socket', () => {
      const sm = new SessionManager()
      expect(sm.getAllByAgentSocket(mockSocket())).toEqual([])
    })

    it('does not return sessions from other agents', () => {
      const sm = new SessionManager()
      const wsA = mockSocket()
      const wsB = mockSocket()
      sm.create(wsA, [{ id: 'devA', name: 'A', platform: 'ios', status: 'shutdown' }])
      sm.create(wsB, [{ id: 'devB', name: 'B', platform: 'ios', status: 'shutdown' }])
      expect(sm.getAllByAgentSocket(wsA)).toHaveLength(1)
      expect(sm.getAllByAgentSocket(wsB)).toHaveLength(1)
    })
  })

  describe('getAgentSocketsByIdentity()', () => {
    it('returns sockets sharing the same hostname + platform', () => {
      const sm = new SessionManager()
      const wsOld = mockSocket()
      const wsNew = mockSocket()
      sm.create(wsOld, [{ id: 'd1', name: 'A', platform: 'ios', status: 'shutdown' }], 'MyMac', 'ios')
      sm.create(wsNew, [{ id: 'd2', name: 'B', platform: 'ios', status: 'shutdown' }], 'MyMac', 'ios')
      const found = sm.getAgentSocketsByIdentity('MyMac', 'ios')
      expect(found).toHaveLength(2)
      expect(found).toContain(wsOld)
      expect(found).toContain(wsNew)
    })

    it('does not mix platforms — iOS + Android on one Mac stay separate', () => {
      const sm = new SessionManager()
      const wsIos = mockSocket()
      const wsAndroid = mockSocket()
      sm.create(wsIos, [{ id: 'd1', name: 'A', platform: 'ios', status: 'shutdown' }], 'MyMac', 'ios')
      sm.create(wsAndroid, [{ id: 'd2', name: 'B', platform: 'android', status: 'shutdown' }], 'MyMac', 'android')
      expect(sm.getAgentSocketsByIdentity('MyMac', 'ios')).toEqual([wsIos])
      expect(sm.getAgentSocketsByIdentity('MyMac', 'android')).toEqual([wsAndroid])
    })

    it('returns one socket once even with multiple device sessions', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      sm.create(ws, [
        { id: 'd1', name: 'A', platform: 'ios', status: 'shutdown' },
        { id: 'd2', name: 'B', platform: 'ios', status: 'shutdown' },
      ], 'MyMac', 'ios')
      expect(sm.getAgentSocketsByIdentity('MyMac', 'ios')).toEqual([ws])
    })

    it('returns empty array when nothing matches', () => {
      const sm = new SessionManager()
      sm.create(mockSocket(), [{ id: 'd1', name: 'A', platform: 'ios', status: 'shutdown' }], 'MyMac', 'ios')
      expect(sm.getAgentSocketsByIdentity('OtherMac', 'ios')).toEqual([])
    })

    it('keys on machine id — same hostname, different machine ids stay separate', () => {
      const sm = new SessionManager()
      const wsA = mockSocket()
      const wsB = mockSocket()
      sm.create(wsA, [{ id: 'd1', name: 'A', platform: 'ios', status: 'shutdown' }], 'DupName', 'ios', 'uuid-A')
      sm.create(wsB, [{ id: 'd2', name: 'B', platform: 'ios', status: 'shutdown' }], 'DupName', 'ios', 'uuid-B')
      expect(sm.getAgentSocketsByIdentity('uuid-A', 'ios')).toEqual([wsA])
      expect(sm.getAgentSocketsByIdentity('uuid-B', 'ios')).toEqual([wsB])
    })

    it('falls back to hostname when machine id is absent (older agent)', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      sm.create(ws, [{ id: 'd1', name: 'A', platform: 'ios', status: 'shutdown' }], 'OldMac', 'ios')
      expect(sm.getAgentSocketsByIdentity('OldMac', 'ios')).toEqual([ws])
    })
  })

  describe('getByStreamSocket()', () => {
    it('returns undefined when no stream socket registered', () => {
      const sm = new SessionManager()
      expect(sm.getByStreamSocket(mockSocket())).toBeUndefined()
    })

    it('returns the session after setStreamSocket()', () => {
      const sm = new SessionManager()
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      const streamWs = mockSocket()
      sm.setStreamSocket(id, streamWs)
      expect(sm.getByStreamSocket(streamWs)?.id).toBe(id)
    })
  })

  describe('join()', () => {
    it('sets browserSocket on the session', () => {
      const sm = new SessionManager()
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      const browserWs = mockSocket()
      sm.join(id, browserWs)
      expect(sm.get(id)?.browserSocket).toBe(browserWs)
    })

    // The two expected failures are **returned**, not thrown, as of #515. Both used to be
    // `ValidationError`s, and the handler's single `catch` could not tell them from a bug — so it
    // guessed a `reason`, and guessed wrong for the most common case (see the re-join tests below).
    it('reports a session that is not there', () => {
      const sm = new SessionManager()
      expect(sm.join('bad-id', mockSocket())).toEqual({ ok: false, failure: 'not-found' })
    })

    it('reports a session another OPEN socket holds', () => {
      const sm = new SessionManager()
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      const busyWs = { readyState: OPEN } as WebSocket
      sm.join(id, busyWs)
      expect(sm.join(id, mockSocket())).toEqual({ ok: false, failure: 'held-by-another' })
      // The refusal must not have moved the binding — a rejected join that stole the session would be
      // the defect this check exists to prevent, wearing a refusal's clothes.
      expect(sm.get(id)?.browserSocket).toBe(busyWs)
    })

    it('a re-join by the owning socket succeeds and keeps the binding (#515)', () => {
      const sm = new SessionManager()
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      const owner = { readyState: OPEN } as WebSocket
      sm.join(id, owner)
      expect(sm.join(id, owner)).toEqual({ ok: true })
      expect(sm.get(id)?.browserSocket).toBe(owner)
      // And the socket still holds it exactly once. `unindexBrowser` reads `session.browserSocket`, so a
      // re-join that ran it would drop the entry this join is re-establishing — leaving the session bound
      // for commands while invisible to the close handler, which is #507 rebuilt one method over.
      expect(sm.getByBrowserSocket(owner).map((s) => s.id)).toEqual([id])
    })

    it('one socket holds several sessions at once', () => {
      // `mcp-server` runs a single WebSocket for the whole process and joins a session per device. The
      // index was `Map<WebSocket, Session>` until #507, so the second join here evicted the first from the
      // reverse lookup — and the close handler, which resolves through it, then released only one.
      const sm = new SessionManager()
      const agent = mockSocket()
      const [a, b] = sm.create(agent, [
        { id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' },
        { id: 'd2', name: 'Y', platform: 'ios', status: 'shutdown' },
      ])
      const ws = { readyState: OPEN } as WebSocket
      sm.join(a!, ws)
      sm.join(b!, ws)
      expect(sm.getByBrowserSocket(ws).map((s) => s.id).sort()).toEqual([a, b].sort())
      expect(sm.get(a!)?.browserSocket).toBe(ws)
      expect(sm.get(b!)?.browserSocket).toBe(ws)
    })

    it('releasing one of several leaves the others held, and empties the key at the end', () => {
      const sm = new SessionManager()
      const [a, b] = sm.create(mockSocket(), [
        { id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' },
        { id: 'd2', name: 'Y', platform: 'ios', status: 'shutdown' },
      ])
      const ws = { readyState: OPEN } as WebSocket
      sm.join(a!, ws)
      sm.join(b!, ws)
      sm.clearBrowser(a!)
      expect(sm.getByBrowserSocket(ws).map((s) => s.id)).toEqual([b])
      sm.clearBrowser(b!)
      expect(sm.getByBrowserSocket(ws)).toEqual([])
      // **The key is gone, not merely empty.** `getByBrowserSocket` spreads the set, so it answers `[]`
      // either way — the assertion above cannot see the difference, and a first version of this test
      // claimed it could. The index is a `Map` keyed by socket, so a leftover entry pins a closed socket
      // for the life of the relay: a leak the old one-slot index could not have, introduced by the fix
      // for it. Reaching the private field is the only way to state it, and it is what mutation testing
      // said was missing.
      const index = (sm as unknown as { browserSocketIndex: Map<WebSocket, unknown> }).browserSocketIndex
      expect(index.has(ws)).toBe(false)
    })

    it('remove() takes the session out of its socket set', () => {
      const sm = new SessionManager()
      const [a, b] = sm.create(mockSocket(), [
        { id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' },
        { id: 'd2', name: 'Y', platform: 'ios', status: 'shutdown' },
      ])
      const ws = { readyState: OPEN } as WebSocket
      sm.join(a!, ws)
      sm.join(b!, ws)
      sm.remove(a!)
      expect(sm.getByBrowserSocket(ws).map((s) => s.id)).toEqual([b])
    })
  })

  describe('remove()', () => {
    it('removes a session', () => {
      const sm = new SessionManager()
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      sm.remove(id)
      expect(sm.get(id)).toBeUndefined()
    })
  })

  describe('clearBrowser()', () => {
    it('sets browserSocket to null', () => {
      const sm = new SessionManager()
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      sm.join(id, mockSocket())
      sm.clearBrowser(id)
      expect(sm.get(id)?.browserSocket).toBeNull()
    })
  })

  describe('updateDeviceStatus()', () => {
    it('updates deviceStatus on the session', () => {
      const sm = new SessionManager()
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      sm.updateDeviceStatus(id, 'booted')
      expect(sm.get(id)?.deviceStatus).toBe('booted')
    })
  })

  describe('setResources() / removeResources()', () => {
    it('list() has undefined resources when none reported', () => {
      const sm = new SessionManager()
      sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }], 'Mac1')
      expect(sm.list()[0].resources).toBeUndefined()
    })

    it('setResources() is reflected in list()', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      sm.create(ws, [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }], 'Mac1')
      const resources = { cpuPercent: 42, memUsedMB: 8192, memTotalMB: 16384, slotsAvailable: 2, slotsTotal: 3, reportedAt: 1000 }
      sm.setResources(ws, resources)
      expect(sm.list()[0].resources).toEqual(resources)
    })

    it('removeResources() clears resources from list()', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      sm.create(ws, [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }], 'Mac1')
      sm.setResources(ws, { cpuPercent: 50, memUsedMB: 4096, memTotalMB: 16384, slotsAvailable: 3, slotsTotal: 3, reportedAt: 1000 })
      sm.removeResources(ws)
      expect(sm.list()[0].resources).toBeUndefined()
    })

    it('setResources() on unknown socket does not throw', () => {
      const sm = new SessionManager()
      expect(() => sm.setResources(mockSocket(), { cpuPercent: 0, memUsedMB: 0, memTotalMB: 0, slotsAvailable: 0, slotsTotal: 0, reportedAt: 0 })).not.toThrow()
    })

    it('resources from different agents are independent', () => {
      const sm = new SessionManager()
      const ws1 = mockSocket()
      const ws2 = mockSocket()
      sm.create(ws1, [{ id: 'd1', name: 'A', platform: 'ios', status: 'shutdown' }], 'Mac1')
      sm.create(ws2, [{ id: 'd2', name: 'B', platform: 'ios', status: 'shutdown' }], 'Mac2')
      sm.setResources(ws1, { cpuPercent: 10, memUsedMB: 1000, memTotalMB: 8000, slotsAvailable: 3, slotsTotal: 3, reportedAt: 1000 })
      const listed = sm.list()
      const mac1 = listed.find((g) => g.agentName === 'Mac1')!
      const mac2 = listed.find((g) => g.agentName === 'Mac2')!
      expect(mac1.resources?.cpuPercent).toBe(10)
      expect(mac2.resources).toBeUndefined()
    })
  })

  describe('idle timeout', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('clearBrowser() with onTimeout fires callback after idleTimeoutMs', () => {
      const sm = new SessionManager({ idleTimeoutMs: 1000 })
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      sm.join(id, mockSocket())
      const onTimeout = vi.fn()
      sm.clearBrowser(id, onTimeout)
      expect(onTimeout).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1000)
      expect(onTimeout).toHaveBeenCalledOnce()
    })

    it('join() cancels a pending idle timer', () => {
      const sm = new SessionManager({ idleTimeoutMs: 1000 })
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      sm.join(id, mockSocket())
      const onTimeout = vi.fn()
      sm.clearBrowser(id, onTimeout)
      sm.join(id, mockSocket())          // reconnect before timeout
      vi.advanceTimersByTime(2000)
      expect(onTimeout).not.toHaveBeenCalled()
    })

    it('remove() cancels a pending idle timer', () => {
      const sm = new SessionManager({ idleTimeoutMs: 1000 })
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      sm.join(id, mockSocket())
      const onTimeout = vi.fn()
      sm.clearBrowser(id, onTimeout)
      sm.remove(id)
      vi.advanceTimersByTime(2000)
      expect(onTimeout).not.toHaveBeenCalled()
    })

    it('clearBrowser() without onTimeout starts no timer', () => {
      const sm = new SessionManager({ idleTimeoutMs: 1000 })
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      sm.join(id, mockSocket())
      sm.clearBrowser(id)               // no callback
      expect(sm.get(id)?.idleTimer).toBeNull()
    })
  })

  describe('list()', () => {
    it('returns empty array when no sessions', () => {
      const sm = new SessionManager()
      expect(sm.list()).toEqual([])
    })

    it('groups devices by agent into one SessionInfo', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      sm.create(ws, [
        { id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' },
        { id: 'devB', name: 'iPhone B', platform: 'ios', status: 'shutdown' },
      ], 'MyMac')
      const listed = sm.list()
      expect(listed).toHaveLength(1)
      expect(listed[0].agentName).toBe('MyMac')
      expect(listed[0].devices).toHaveLength(2)
    })

    it('includes sessionId on each device', () => {
      const sm = new SessionManager()
      const ws = mockSocket()
      const [idA] = sm.create(ws, [{ id: 'devA', name: 'A', platform: 'ios', status: 'shutdown' }])
      const listed = sm.list()
      expect(listed[0].devices[0]!.sessionId).toBe(idA)
    })

    it('reflects busy=true when browserSocket is set', () => {
      const sm = new SessionManager()
      const [id] = sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      sm.join(id, mockSocket())
      expect(sm.list()[0].devices[0]!.busy).toBe(true)
    })

    it('reflects busy=false when browserSocket is null', () => {
      const sm = new SessionManager()
      sm.create(mockSocket(), [{ id: 'd1', name: 'X', platform: 'ios', status: 'shutdown' }])
      expect(sm.list()[0].devices[0]!.busy).toBe(false)
    })

  })

  describe('rebind()', () => {
    const DEV = { id: 'devA', name: 'iPhone A', platform: 'ios', status: 'booted' }
    const AGENT = { agentId: 'mac-1', agentName: 'the-mac', agentPlatform: 'ios', agentCapabilities: ['clipboard'] }

    it('moves the session off the old socket entirely', () => {
      // The end-to-end tests observe the session surviving; this observes the index itself, which is
      // what the survival rests on. An id left in the old socket's set is reachable by the eviction
      // that runs on that socket's close.
      const sm = new SessionManager()
      const oldWs = mockSocket()
      const newWs = mockSocket()
      const [id] = sm.create(oldWs, [DEV])

      sm.rebind(id!, newWs, DEV, AGENT)

      expect(sm.getAllByAgentSocket(oldWs)).toEqual([])
      expect(sm.getAllByAgentSocket(newWs).map((x) => x.id)).toEqual([id])
    })

    it('keeps the other sessions on a socket that only lost one', () => {
      const sm = new SessionManager()
      const oldWs = mockSocket()
      const [idA, idB] = sm.create(oldWs, [DEV, { id: 'devB', name: 'iPhone B', platform: 'ios', status: 'booted' }])

      sm.rebind(idA!, mockSocket(), DEV, AGENT)

      expect(sm.getAllByAgentSocket(oldWs).map((x) => x.id)).toEqual([idB])
    })

    it('does nothing for a session id that no longer exists', () => {
      // `handleAgentRegister` reads the sessions before it rebinds them, so a removal in between
      // would otherwise index into undefined.
      const sm = new SessionManager()
      const ws = mockSocket()

      expect(() => sm.rebind('no-such-session', ws, DEV, AGENT)).not.toThrow()
      expect(sm.getAllByAgentSocket(ws)).toEqual([])
    })
  })

  it('separates sessions from different agents', () => {
    const sm = new SessionManager()
    sm.create(mockSocket(), [{ id: 'devA', name: 'A', platform: 'ios', status: 'shutdown' }], 'Mac1')
    sm.create(mockSocket(), [{ id: 'devB', name: 'B', platform: 'ios', status: 'shutdown' }], 'Mac2')
    const listed = sm.list()
    expect(listed).toHaveLength(2)
  })

  describe('list() and held sessions (#426)', () => {
    it('leaves out a session whose agent socket has closed', () => {
      // It is being held for a returning agent. Listing it would put a card on the Mac screen for
      // an agent that is not there — with its last resource sample, and no staleness warning,
      // because that badge keys off a 30s-old reading and the window is far shorter.
      const sm = new SessionManager()
      sm.create(closedSocket(), [{ id: 'devA', name: 'A', platform: 'ios', status: 'booted' }])

      expect(sm.list()).toEqual([])
    })

    it('lists it again once it is rebound to a live socket', () => {
      const sm = new SessionManager()
      const dead = closedSocket()
      const live = mockSocket()
      const dev = { id: 'devA', name: 'A', platform: 'ios', status: 'booted' }
      const [id] = sm.create(dead, [dev])

      sm.rebind(id!, live, dev, { agentId: 'mac-1' })

      expect(sm.list()).toHaveLength(1)
      expect(sm.list()[0]!.devices[0]!.sessionId).toBe(id)
    })
  })
})
