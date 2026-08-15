/**
 * Type-level machinery that keeps the schemas in this directory tied to the interfaces in
 * `../index.ts`.
 *
 * A schema file is a **second copy** of the contract, and a second copy drifts — that is the whole
 * reason `@tapflowio/protocol` exists (see AGENTS.md). Every assertion here is a compile error at the
 * declaration rather than a test somebody has to remember to run, and all of them cost nothing at
 * runtime.
 *
 * Deliberately a copy of `Assert` / `IsEmpty` rather than an import from `relay/src/types.ts`:
 * importing would invert the dependency — the relay depends on protocol, not the other way round.
 * `../typeAssertions.ts` established that convention with its own `AssertTrue` / `NoOverlap` pair.
 */
import type * as z from 'zod'

/** Fails to instantiate when its argument is not `true`.
 *
 *  **`never` passes this** (`never extends true` is true), which is why every conditional below is
 *  bracketed. An unbracketed conditional distributes over a union and can answer `never` for an empty
 *  one — and that would be a silently passing assertion, which is worse than none. */
export type Assert<T extends true> = T

/** `[T] extends [never]`, not a bare `T extends never` — see the note on `Assert`. */
export type IsEmpty<T> = [T] extends [never] ? true : false

/** `0 extends 1 & T` is true only for `any`: intersecting anything else with `1` cannot produce a type
 *  `0` is assignable to. */
type IsAny<T> = 0 extends 1 & T ? true : false

/**
 * Mutual assignability, with `any` refused on both sides.
 *
 * Without the `IsAny` arms this is vacuously `true` whenever either side is `any`, because `any`
 * extends and is extended by everything. `z.any()` is the obvious way to hit that.
 */
export type Exact<A, B> =
  [IsAny<A>] extends [true] ? false
  : [IsAny<B>] extends [true] ? false
  : [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * What the Envelope tier is allowed to type: the interface projected onto the three fields the door
 * actually checks.
 *
 * `Pick` rather than a hand-written shape, so the projection cannot disagree with the interface it
 * projects — `DeviceShutdown`'s `requestId?` stays optional here, and `AgentsList`, which declares
 * nothing but `type`, projects to `{ type }` and is therefore checked *exactly* rather than passing
 * because there was nothing to compare.
 */
export type EnvelopeOf<I extends { type: string }> =
  Pick<I, Extract<keyof I, 'type' | 'sessionId' | 'requestId'>>

/**
 * The one assertion both tiers use. Only the target differs: the interface for Validated, its
 * `EnvelopeOf` projection for Envelope.
 *
 * **The `ZodObject` guard is the part `IsAny` cannot do.** A first design paired `Exact` with an
 * `IsAny` rejection and named `z.custom<T>()` among the holes it closed — it is not one. In zod 4.4.3
 * `custom<O>(…): ZodCustom<O, O>` (`v4/classic/schemas.d.ts:741`), so `z.output` is `O` with no `any`
 * anywhere in the comparison, and `Exact<O, O>` is `true` while the schema checks no structure at all.
 * The same goes for the `const s: z.ZodType<T> = …` annotation somebody reaches for when a schema is
 * awkward. Neither is a `ZodObject`, so both are refused here by kind rather than by output.
 *
 * `$strip` is pinned, not incidental: it states in the type that unknown keys are removed rather than
 * rejected, which is what the browser-direction forward depends on — the relay sends the parse product
 * on that side precisely so a key an attacker added is gone by the time an agent sees the frame.
 * Switching a schema to `z.strictObject` would refuse the whole frame instead, so it should be a
 * decision with a reason, and this makes it a compile error until someone writes one.
 */
export type SchemaExact<S, Target> =
  [S] extends [z.ZodObject<z.core.$ZodShape, z.core.$strip>] ? Exact<z.output<S>, Target> : false
