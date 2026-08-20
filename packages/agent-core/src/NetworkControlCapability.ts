import type { DeviceAgent } from './DeviceAgent.js'

// Optional network-control capability (take the device under test off the network and back), kept
// OUT of the core DeviceAgent interface (ISP): the mechanism is platform-asymmetric and opt-in, so
// only agents that can do it implement it. Consumers must feature-detect with hasNetworkControl().
// Same shape as AudioStreamCapability, and for the same reason.

/** Why control is not available on this device right now. Mirrors the wire's
 *  `NetworkUnavailableReason` — the dashboard cannot import from this package, so the closed set
 *  lives in `@tapflowio/protocol` and this is the agent-side name for it. */
export type NetworkUnavailable = 'hooks-not-installed' | 'not-armed' | 'unsupported-device'

export interface NetworkState {
  offline: boolean
  /**
   * Whether tapflow can actually steer this device's network **right now**.
   *
   * Deliberately not the same question as the `network-control` capability. That string is sent
   * once in `agent:register`, before any device is booted or app launched, so it can only ever
   * claim "this agent has the code". Whether the mechanism took is per device and per app — an
   * injection that did not land, an emulator image too old for the command — and that is this.
   */
  available: boolean
  /** Set when `available` is false, and only then. */
  reason?: NetworkUnavailable
}

export interface NetworkControlCapability {
  /** Take the device off the network, or put it back. Returns the state that resulted, which may
   *  report `available: false` — asking for something the device cannot do is an answer, not an
   *  error. */
  setNetworkOffline(offline: boolean): Promise<NetworkState>
  /** The current state, for the unsolicited report a session gets on `device:ready` and after a
   *  boot re-arms whatever the platform needs armed. */
  networkState(): Promise<NetworkState>
}

export function hasNetworkControl(
  agent: DeviceAgent,
): agent is DeviceAgent & NetworkControlCapability {
  const a = agent as Partial<NetworkControlCapability>
  return typeof a.setNetworkOffline === 'function' && typeof a.networkState === 'function'
}
