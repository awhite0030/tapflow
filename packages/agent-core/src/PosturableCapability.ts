import type { DevicePosture } from '@tapflowio/protocol'
import type { DeviceAgent } from './DeviceAgent.js'

// Optional posture capability (a foldable's screens can be rearranged), kept OUT of the core
// DeviceAgent interface (ISP): most devices have one fixed screen, so only agents that can answer
// implement it. Consumers feature-detect with isPosturable() — the same shape as
// `NetworkControlCapability` beside this file.

// `DevicePosture` is a **wire** type, so `@tapflowio/protocol` owns it and this re-exports rather
// than re-declares — the rule `types.ts` states for `ClipboardErrorPayload` and the five beside it.
export type { DevicePosture }

/**
 * An agent that can report and change a device's posture.
 *
 * **The capability is the agent's, not the device's.** One `AndroidAgent` hosts a foldable AVD and
 * an ordinary one in the same process, so `isPosturable` cannot mean "this device folds" — it means
 * "ask, and you will get an answer". The answer for a device with one fixed screen is an empty
 * list, and **the list's length is the real gate**: a viewer shows a control when there is more than
 * one posture to choose between.
 */
export interface PosturableAgent {
  /**
   * The postures `deviceId` can take, ordered **most closed → most open**, or `[]` when it has none.
   *
   * The ordering is the whole contract. Posture ids are opaque and platform-owned, so a viewer
   * cannot ask "which one is open?" — but it can render the list in order, and then the question
   * does not arise. A future platform's postures will have different names and still satisfy this,
   * because closed-to-open is what folding means.
   */
  listPostures(deviceId: string): Promise<DevicePosture[]>

  /** The posture `deviceId` is in, or `null` when it has none. */
  getPosture(deviceId: string): Promise<DevicePosture | null>

  /** Put `deviceId` into `postureId`. Rejects when the id is not one this device offers. */
  setPosture(deviceId: string, postureId: string): Promise<void>
}

/** Feature detection for `PosturableAgent`. See the interface for why this is about the agent
 *  rather than the device. */
export function isPosturable(agent: DeviceAgent): agent is DeviceAgent & PosturableAgent {
  const a = agent as Partial<PosturableAgent>
  return typeof a.listPostures === 'function'
    && typeof a.getPosture === 'function'
    && typeof a.setPosture === 'function'
}
