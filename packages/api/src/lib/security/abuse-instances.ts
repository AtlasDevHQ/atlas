/**
 * Pure grouping of abuse events into "instances" for the admin detail panel.
 *
 * An *instance* is one continuous stretch of non-"none" activity bookended by
 * an escalation event and (optionally) a manual reinstatement. The current
 * (unreinstated) instance is returned separately from prior closed instances
 * so the UI can render them differently — active incident vs history.
 *
 * Kept pure and mock-free so it can be unit-tested without a DB.
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

function makeInstance(eventsChrono: AbuseEvent[]): AbuseInstance {
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
      closed.push(makeInstance(buffer));
      buffer = [];
    }
  }

  const currentInstance = makeInstance(buffer);
  const priorInstances = closed.toReversed().slice(0, priorLimit);

  return { currentInstance, priorInstances };
}
