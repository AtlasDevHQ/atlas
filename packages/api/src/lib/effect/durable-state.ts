/**
 * DurableState Effect layers (#3754, ADR-0020).
 *
 * `DurableStateLive` is selected when an internal DB is present; the
 * `NoopDurableStateLayer` otherwise — the same `hasInternalDB()` gate and
 * Noop-layer shape as {@link DurableSession} and the enterprise services. Both
 * delegate to the plain helpers in `lib/durable-state.ts` so there is a single
 * load/commit implementation shared with the agent loop (which calls the plain
 * helpers directly, the same way it calls the transcript-checkpoint helpers).
 */

import { Effect, Layer } from "effect";
import { DurableState, type DurableStateShape } from "@atlas/api/lib/effect/services";
import {
  commitSessionMemory,
  loadSessionMemory,
  sweepExpiredSessionMemory,
} from "@atlas/api/lib/durable-state";

/** Real, internal-DB-backed durable memory store. */
export const DurableStateLive: Layer.Layer<DurableState> = Layer.succeed(
  DurableState,
  {
    available: true,
    load: (conversationId) => Effect.promise(() => loadSessionMemory(conversationId)),
    commit: (args) => commitSessionMemory(args),
    sweepExpired: (retentionDays) =>
      Effect.promise(() => sweepExpiredSessionMemory(retentionDays)),
  } satisfies DurableStateShape,
);

/**
 * No-op memory store selected when no internal DB is present. Loads yield an
 * empty map and commits are dropped, so the agent behaves exactly as it does
 * today.
 */
export const NoopDurableStateLayer: Layer.Layer<DurableState> = Layer.succeed(
  DurableState,
  {
    available: false,
    load: () => Effect.succeed(new Map<string, unknown>()),
    commit: () => {},
    sweepExpired: () => Effect.succeed(0),
  } satisfies DurableStateShape,
);

/** Select the real layer iff an internal DB is configured (`hasInternalDB()`). */
export function durableStateLayer(hasInternalDB: boolean): Layer.Layer<DurableState> {
  return hasInternalDB ? DurableStateLive : NoopDurableStateLayer;
}
