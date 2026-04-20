/**
 * Pure helpers for the admin abuse detail panel.
 *
 * Three helpers, all deliberately framework- and DB-free so they can be
 * exercised without the sliding-window engine or the internal DB:
 *
 *   1. `createAbuseInstance` — the narrowed constructor for `AbuseInstance`.
 *      Encodes the invariants (peakLevel is the max of event levels, endedAt
 *      non-null iff the last event is a manual "none" reinstatement, empty
 *      events → sentinel shape) so production callers go through one place
 *      rather than hand-rolling a mismatched object. Note: `AbuseInstance`
 *      is a structurally-typed interface, so the factory is an *advisory*
 *      boundary — tests and wire-format parsers can still produce the shape
 *      directly.
 *   2. `splitIntoInstances` — groups a workspace's event stream into the
 *      current (open) instance plus prior closed instances.
 *   3. `errorRatePct` — the counter arithmetic the detail panel needs for
 *      the "error rate %" card. Pure function, rounds to 2 decimals to
 *      preserve threshold-comparison precision at the 0.01% level.
 */

import type { AbuseEvent, AbuseInstance, AbuseLevel } from "@useatlas/types";

const LEVEL_RANK: Record<AbuseLevel, number> = {
  none: 0,
  warning: 1,
  throttled: 2,
  suspended: 3,
};

/** Reinstatement sentinel — system-generated events never use `trigger: "manual"`. */
function isReinstatement(e: AbuseEvent): boolean {
  return e.level === "none" && e.trigger === "manual";
}

/**
 * Build an `AbuseInstance` from a chronologically-ordered slice of events.
 *
 * The sole constructor for `AbuseInstance` in this codebase — callers MUST go
 * through the factory rather than assembling the object inline, so the
 * invariants below are enforced in exactly one place:
 *
 *   - `startedAt` = first event's `createdAt` (or `""` for an empty instance)
 *   - `endedAt`   = last event's `createdAt` iff it is a manual "none"
 *                   reinstatement, else `null` (instance still open)
 *   - `peakLevel` = highest-ranked level across all events (escalation order,
 *                   not chronological order)
 *   - `events`    = the input array, verbatim (no mutation, no reorder)
 *
 * Input is expected to be chronological (oldest first). Passing events in
 * reverse order will still produce a valid instance object, but `startedAt`
 * will then be the newest rather than oldest timestamp — the factory does
 * not sort for the caller.
 */
export function createAbuseInstance(eventsChrono: AbuseEvent[]): AbuseInstance {
  if (eventsChrono.length === 0) {
    return { startedAt: "", endedAt: null, peakLevel: "none", events: [] };
  }
  const last = eventsChrono[eventsChrono.length - 1]!;
  const endedAt = isReinstatement(last) ? last.createdAt : null;
  let peak: AbuseLevel = "none";
  for (const e of eventsChrono) {
    if (LEVEL_RANK[e.level] > LEVEL_RANK[peak]) peak = e.level;
  }
  return {
    startedAt: eventsChrono[0]!.createdAt,
    endedAt,
    peakLevel: peak,
    events: eventsChrono,
  };
}

/**
 * Compute error rate as a percentage on [0, 100], rounded to 2 decimal places.
 *
 * Returns `0` when `totalCount` is 0 so callers never surface `NaN` or
 * `Infinity`. The "baseline pending" decision (`null` when the window has
 * fewer than the minimum samples) stays at the call site — this helper is a
 * pure arithmetic primitive, not a display-policy decision.
 *
 * Rounding is 2 decimals (not 1) deliberately: the admin detail panel reads
 * the returned value both for display (`.toFixed(0)`) AND for a derived
 * "over threshold" flag (`errorRatePct / 100 > errorRateThreshold`). Rounding
 * to 1 decimal silently flips that flag within ±0.05% of the threshold while
 * the engine's own `checkThresholds` still escalates on the unrounded
 * fraction — so the UI and the engine would disagree at boundary values.
 * Two-decimal rounding matches the SLA surface (`ee/src/sla/metrics.ts`) and
 * keeps the boundary comparison faithful to 0.01%.
 *
 * Preconditions: `errorCount` and `totalCount` must be finite, non-negative,
 * and `errorCount <= totalCount` in practice. The helper throws on
 * non-finite or negative inputs (those would otherwise produce `NaN` /
 * `Infinity` / negative percentages), and clamps `errorCount > totalCount`
 * cases to 100 rather than returning a percentage > 100 — the latter is a
 * caller bug, but surfacing e.g. 150% would mislead the admin more than
 * displaying 100% does.
 */
export function errorRatePct(errorCount: number, totalCount: number): number {
  if (!Number.isFinite(errorCount) || !Number.isFinite(totalCount)) {
    throw new Error(
      `errorRatePct: non-finite input (errorCount=${errorCount}, totalCount=${totalCount})`,
    );
  }
  if (errorCount < 0 || totalCount < 0) {
    throw new Error(
      `errorRatePct: negative input (errorCount=${errorCount}, totalCount=${totalCount})`,
    );
  }
  if (totalCount === 0) return 0;
  const raw = (errorCount / totalCount) * 100;
  return Math.min(100, Math.round(raw * 100) / 100);
}

/**
 * Split a workspace's abuse-event stream into its current instance and prior
 * instances.
 *
 * @param events Events ordered DESC by `createdAt` (the DB's natural order).
 * @param priorLimit Max number of prior instances to return (newest-first).
 */
export function splitIntoInstances(
  events: AbuseEvent[],
  priorLimit: number,
): { currentInstance: AbuseInstance; priorInstances: AbuseInstance[] } {
  // Flip to chronological so a forward walk can close instances on
  // reinstatement events naturally.
  const chronological = events.toReversed();
  const closed: AbuseInstance[] = [];
  let buffer: AbuseEvent[] = [];

  for (const e of chronological) {
    buffer.push(e);
    if (isReinstatement(e)) {
      closed.push(createAbuseInstance(buffer));
      buffer = [];
    }
  }

  const currentInstance = createAbuseInstance(buffer);
  const priorInstances = closed.toReversed().slice(0, priorLimit);

  return { currentInstance, priorInstances };
}
