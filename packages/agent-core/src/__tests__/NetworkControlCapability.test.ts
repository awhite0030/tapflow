import { describe, it, expect } from 'vitest'
import { hasNetworkControl } from '../NetworkControlCapability'
import type { NetworkControlCapability, NetworkState } from '../NetworkControlCapability'
import type { DeviceAgent } from '../DeviceAgent'
import type { Device, UIElement } from '../types'

// An agent that implements DeviceAgent and nothing optional — the shape every platform can meet.
class PlainAgent implements DeviceAgent {
  listDevices(): Promise<Device[]> { return Promise.resolve([]) }
  boot(_deviceId: string): Promise<void> { return Promise.resolve() }
  shutdown(_deviceId: string): Promise<void> { return Promise.resolve() }
  installApp(_path: string): Promise<void> { return Promise.resolve() }
  launchApp(_bundleId: string): Promise<void> { return Promise.resolve() }
  screenshot(): Promise<Buffer> { return Promise.resolve(Buffer.alloc(0)) }
  stream(): ReadableStream<Buffer> { return new ReadableStream() }
  touchStart(_x: number, _y: number): void {}
  touchMove(_x: number, _y: number): Promise<void> { return Promise.resolve() }
  touchEnd(): Promise<void> { return Promise.resolve() }
  openUrl(_url: string): Promise<void> { return Promise.resolve() }
  queryUITree(): Promise<UIElement[]> { return Promise.resolve([]) }
}

class NetworkAgent extends PlainAgent implements NetworkControlCapability {
  private offline = false
  setNetworkOffline(offline: boolean): Promise<NetworkState> {
    this.offline = offline
    return Promise.resolve({ offline, available: true })
  }
  networkState(): Promise<NetworkState> {
    return Promise.resolve({ offline: this.offline, available: true })
  }
}

/** Implements the feature but cannot run it on this device — the case the capability string cannot
 *  express, because it is announced once per agent and this is per device. */
class UnavailableNetworkAgent extends PlainAgent implements NetworkControlCapability {
  setNetworkOffline(_offline: boolean): Promise<NetworkState> {
    return Promise.resolve({ offline: false, available: false, reason: 'hooks-not-installed' })
  }
  networkState(): Promise<NetworkState> {
    return Promise.resolve({ offline: false, available: false, reason: 'hooks-not-installed' })
  }
}

describe('NetworkControlCapability', () => {
  it('hasNetworkControl is false for an agent without it', () => {
    expect(hasNetworkControl(new PlainAgent())).toBe(false)
  })

  it('hasNetworkControl is true for an agent that implements both methods', () => {
    expect(hasNetworkControl(new NetworkAgent())).toBe(true)
  })

  // Both members, not either — a half-implemented agent would satisfy a one-sided check and then
  // throw at the call site the viewer already enabled a control for.
  it('is false when only one of the two methods is present', () => {
    const halves = [
      Object.assign(new PlainAgent(), { setNetworkOffline: () => Promise.resolve({ offline: true, available: true }) }),
      Object.assign(new PlainAgent(), { networkState: () => Promise.resolve({ offline: true, available: true }) }),
    ]
    for (const half of halves) expect(hasNetworkControl(half as DeviceAgent)).toBe(false)
  })

  it('round-trips the offline flag', async () => {
    const agent = new NetworkAgent()
    expect((await agent.networkState()).offline).toBe(false)
    expect((await agent.setNetworkOffline(true)).offline).toBe(true)
    expect((await agent.networkState()).offline).toBe(true)
    expect((await agent.setNetworkOffline(false)).offline).toBe(false)
  })

  // The distinction the whole two-layer design rests on: an agent can implement this and still be
  // unable to do it here. `hasNetworkControl` answers the first question and must not be read as
  // answering the second — that is what `available` is for.
  it('an agent that cannot run it on this device still has the capability', async () => {
    const agent = new UnavailableNetworkAgent()
    expect(hasNetworkControl(agent)).toBe(true)

    const state = await agent.setNetworkOffline(true)
    expect(state.available).toBe(false)
    expect(state.reason).toBe('hooks-not-installed')
    // And it did not pretend the request landed.
    expect(state.offline).toBe(false)
  })
})
