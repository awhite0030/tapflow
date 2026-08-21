import type { NetworkStatePayload, NetworkUnavailableReason } from '@tapflowio/protocol'
import type { DeviceAgent } from './DeviceAgent.js'

// Optional network-control capability (take the device under test off the network and back), kept
// OUT of the core DeviceAgent interface (ISP): the mechanism is platform-asymmetric and opt-in, so
// only agents that can do it implement it. Consumers must feature-detect with hasNetworkControl().
// Same shape as AudioStreamCapability, and for the same reason.

// The state shape and its reason set are **wire** types, so `@tapflowio/protocol` owns them and this
// re-exports rather than re-declares — the rule `types.ts` states for `ClipboardErrorPayload` and the
// five beside it. A second copy here would drift the moment a reason is added: nothing would fail,
// and an agent typed against this package simply could not return the new value.
//
// `NetworkState` is deliberately **not** the name used here. Protocol exports that as the *message*;
// taking it for the payload would put two different types under one name across two packages an
// agent imports in the same file.
export type { NetworkStatePayload, NetworkUnavailableReason }

export interface NetworkControlCapability {
  /** Take the device off the network, or put it back. Returns the state that resulted, which may
   *  report `available: false` — asking for something the device cannot do is an answer, not an
   *  error. */
  setNetworkOffline(offline: boolean): Promise<NetworkStatePayload>
  /** The current state, for the unsolicited report a session gets on `device:ready` and after a
   *  boot re-arms whatever the platform needs armed. */
  networkState(): Promise<NetworkStatePayload>
}

export function hasNetworkControl(
  agent: DeviceAgent,
): agent is DeviceAgent & NetworkControlCapability {
  const a = agent as Partial<NetworkControlCapability>
  return typeof a.setNetworkOffline === 'function' && typeof a.networkState === 'function'
}
