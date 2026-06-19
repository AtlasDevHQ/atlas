/**
 * DurableSession Effect layers (#3745, ADR-0020).
 *
 * `DurableSessionLive` is selected when an internal DB is present; the
 * `NoopDurableSessionLayer` otherwise — the same `hasInternalDB()` gate and
 * Noop-layer shape as the enterprise services. Both delegate to the plain
 * helpers in `lib/durable-session.ts` so there is a single write/sweep
 * implementation shared with the agent loop (which calls the plain helpers
 * directly, mirroring the `token_usage` write it sits beside).
 */

import { Effect, Layer } from "effect";
import { DurableSession, type DurableSessionShape } from "@atlas/api/lib/effect/services";
import {
  recordTerminalAgentRun,
  sweepTerminalAgentRuns,
} from "@atlas/api/lib/durable-session";

/** Real, internal-DB-backed durable store. */
export const DurableSessionLive: Layer.Layer<DurableSession> = Layer.succeed(
  DurableSession,
  {
    available: true,
    recordTerminal: (args) => recordTerminalAgentRun(args),
    sweepTerminal: (retentionDays) =>
      Effect.promise(() => sweepTerminalAgentRuns(retentionDays)),
  } satisfies DurableSessionShape,
);

/**
 * No-op store selected when no internal DB is present. The loop then behaves
 * exactly as it does today: no `agent_runs` writes, nothing to sweep.
 */
export const NoopDurableSessionLayer: Layer.Layer<DurableSession> = Layer.succeed(
  DurableSession,
  {
    available: false,
    recordTerminal: () => {},
    sweepTerminal: () => Effect.succeed(0),
  } satisfies DurableSessionShape,
);

/** Select the real layer iff an internal DB is configured (`hasInternalDB()`). */
export function durableSessionLayer(hasInternalDB: boolean): Layer.Layer<DurableSession> {
  return hasInternalDB ? DurableSessionLive : NoopDurableSessionLayer;
}
