/**
 * Proactive chat — public dataset for non-linked askers (#2297, PRD #2291).
 *
 * Hosts the curated allowlist of semantic entity names that an unlinked
 * (non-OAuth'd) asker is allowed to ask questions about. Backed by the
 * `proactive_public_dataset` table from migration 0079.
 *
 * Three layers live here:
 *
 *   1. Pure decision helper `isEntityAllowed(allowlist, entityName,
 *      metricsTouched)` — exported separately so the listener gate, the
 *      admin "Make public" preview, and the unit tests can all share the
 *      same join-strict semantics without a DB round-trip.
 *
 *   2. DB-backed `getAllowlist` / `addEntry` / `removeEntry` for the
 *      admin endpoints. `addEntry` is upsert-on-(workspace, entityName)
 *      so a POST that re-saves an existing row replaces its
 *      `denyMetrics`. No partial-update semantics: an empty
 *      `denyMetrics` array on POST means "no denied metrics on this
 *      entity", which matches the admin form's "clear all" affordance.
 *
 *   3. `summarizePublicRefused` — pulls the discoverability rollup
 *      (most-refused entity names, with 30-day counts) from the meter.
 *      Lives here rather than in `answer-meter.ts` so the answer-meter
 *      summary stays content-blind; this rollup is intentionally
 *      content-aware (entity names are admin-visible already).
 *
 * Relocated to `@atlas/ee/proactive` (#3999); reached from the core
 * admin route through the `ProactiveService` Tag. The module stays
 * gate-agnostic — the enterprise boundary is enforced at the route
 * layer (`ProactiveGate.requireEnabled()` + `requireFeatureEntitlement(…,
 * "proactive")`) — so a test layer can exercise the DB shape directly.
 */

import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import type { PublicDatasetEntry, AllowDecision } from "@useatlas/types";
import type { PublicRefusedRollupRow } from "@atlas/api/lib/proactive/types";

const log = createLogger("proactive:public-dataset");

// `PublicDatasetEntry` / `AllowDecision` are the canonical wire shapes;
// the `PublicRefusedRollupRow` projection is CORE-resident
// (`@atlas/api/lib/proactive/types`) so the public-dataset route + the
// `ProactiveService` Tag can reference it without importing `@atlas/ee`
// (#3999). Re-exported here so co-located tests keep their import path.
export type { PublicDatasetEntry, AllowDecision, PublicRefusedRollupRow };

// ---------------------------------------------------------------------------
// Pure decision helper
// ---------------------------------------------------------------------------

/**
 * Decide whether an unlinked-asker query that touches `entityName` (and
 * mentions the listed `metricsTouched`) is allowed under the curated
 * allowlist.
 *
 * Strict semantics:
 *
 *   - The entity must appear in the allowlist. A missing entry refuses.
 *   - If the allowlist row has a non-empty `denyMetrics`, ANY overlap
 *     with `metricsTouched` refuses the whole query — this matches the
 *     HITL decision that the workspace should keep the safer default.
 *   - Cross-entity joins are enforced by the listener: it walks every
 *     referenced entity in the query and calls `isEntityAllowed` per
 *     entity. If `revenue` joins to `customers` and `customers` is
 *     absent from the allowlist, the listener refuses on the second
 *     call here — not in this function. Keeping that walk in the
 *     listener means the per-entity decision stays a one-liner and the
 *     test surface is the cartesian product of "in / out of allowlist"
 *     × "with / without denyMetrics overlap".
 *
 * `deniedReason` is short and content-blind in callers' use — it's the
 * audit-row tag, NOT the user-facing copy. Refusal copy is the admin
 * config's `proactive.refusalCopy` (see `plugins/chat/src/config.ts`).
 */
export function isEntityAllowed(
  allowlist: ReadonlyArray<PublicDatasetEntry>,
  entityName: string,
  metricsTouched: ReadonlyArray<string>,
): AllowDecision {
  const entry = allowlist.find((row) => row.entityName === entityName);
  if (!entry) {
    return { allowed: false, kind: "entity-not-in-allowlist" };
  }
  if (entry.denyMetrics.length === 0) {
    return { allowed: true };
  }
  const denied = metricsTouched.find((metric) =>
    entry.denyMetrics.includes(metric),
  );
  if (denied) {
    // Caller logs `metric` to audit; the user-facing refusal copy
    // never names the metric (content-blind, per HITL design). Tagged
    // union shape replaces the pre-polish packed `metric-denied:${m}`
    // string — audit consumers pluck `metric` directly.
    return { allowed: false, kind: "metric-denied", metric: denied };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// DB-backed CRUD
// ---------------------------------------------------------------------------

interface RawPublicDatasetRow extends Record<string, unknown> {
  entity_name: string;
  deny_metrics: string[] | null;
}

function toEntry(raw: RawPublicDatasetRow): PublicDatasetEntry {
  return {
    entityName: raw.entity_name,
    denyMetrics: Array.isArray(raw.deny_metrics) ? raw.deny_metrics : [],
  };
}

/**
 * Read the whole allowlist for a workspace. Returns `[]` when there is
 * no internal DB so the listener can fail-closed (every entity falls
 * out of the allowlist → every public-channel query refuses).
 *
 * The set is ordered by `entity_name ASC` to keep the admin UI stable
 * across reloads.
 */
export async function getAllowlist(
  workspaceId: string,
): Promise<PublicDatasetEntry[]> {
  if (!hasInternalDB()) return [];
  const rows = await internalQuery<RawPublicDatasetRow>(
    `SELECT entity_name, deny_metrics
       FROM proactive_public_dataset
      WHERE workspace_id = $1
      ORDER BY entity_name ASC`,
    [workspaceId],
  );
  return rows.map(toEntry);
}

/**
 * Upsert one allowlist entry. Replaces `denyMetrics` on conflict; the
 * intent is "saving an entry replaces the previous shape" rather than
 * "POSTing twice merges". The admin form is the canonical source.
 */
export async function addEntry(
  workspaceId: string,
  entityName: string,
  denyMetrics: string[] = [],
): Promise<void> {
  if (!hasInternalDB()) {
    log.debug(
      { workspaceId, entityName },
      "proactive_public_dataset upsert skipped — no internal DB",
    );
    return;
  }
  // Postgres treats the array literal `'{}'::text[]` as a deterministic
  // empty array; `pg` driver round-trips JS string[] to text[] cleanly.
  // Use COALESCE on the EXCLUDED side so an "empty array" UPDATE
  // doesn't accidentally degrade to NULL on drivers that flatten empties.
  await internalQuery(
    `INSERT INTO proactive_public_dataset (workspace_id, entity_name, deny_metrics)
     VALUES ($1, $2, $3::text[])
     ON CONFLICT (workspace_id, entity_name) DO UPDATE
       SET deny_metrics = EXCLUDED.deny_metrics,
           updated_at = NOW()`,
    [workspaceId, entityName, denyMetrics],
  );
}

/**
 * Remove one allowlist entry. Idempotent — a DELETE that matches zero
 * rows resolves successfully and the route maps it to 404 at the
 * surface layer (mirrors the channel-override DELETE shape).
 */
export async function removeEntry(
  workspaceId: string,
  entityName: string,
): Promise<{ removed: boolean }> {
  if (!hasInternalDB()) {
    return { removed: false };
  }
  const rows = await internalQuery<{ id: string }>(
    `DELETE FROM proactive_public_dataset
      WHERE workspace_id = $1 AND entity_name = $2
      RETURNING id`,
    [workspaceId, entityName],
  );
  return { removed: rows.length > 0 };
}

// ---------------------------------------------------------------------------
// Discoverability rollup ("Refused topics")
// ---------------------------------------------------------------------------

/**
 * 30-day-by-default rollup of `proactive.public_refused` meter events,
 * grouped by `metadata.entityName` and ordered by count desc. The admin
 * console pairs this with an inline "Make `<entity>` public" button —
 * one of the four discoverability decisions on issue #2297.
 *
 * `sinceMs` matches the meter's lookback convention. The cutoff is
 * computed at call time so the same lookback period yields a moving
 * window. Limit is bounded to `MAX_ROLLUP_ROWS` because the admin UI
 * renders the rollup inline; pagination is overkill for the realistic
 * "30 distinct refused entities in a month" upper bound.
 */
const MAX_ROLLUP_ROWS = 50;

export async function summarizePublicRefused(
  workspaceId: string,
  sinceMs: number,
): Promise<PublicRefusedRollupRow[]> {
  if (!hasInternalDB()) return [];
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  const rows = await internalQuery<{ entity_name: string | null; count: string | number }>(
    `SELECT metadata->>'entityName' AS entity_name, COUNT(*) AS count
       FROM proactive_meter_events
      WHERE workspace_id = $1
        AND event_type = 'public_refused'
        AND created_at >= $2
        AND metadata->>'entityName' IS NOT NULL
      GROUP BY metadata->>'entityName'
      ORDER BY count DESC
      LIMIT $3`,
    [workspaceId, cutoff, MAX_ROLLUP_ROWS],
  );
  return rows
    .filter((r): r is { entity_name: string; count: string | number } => r.entity_name !== null)
    .map((r) => ({
      entityName: r.entity_name,
      count: typeof r.count === "string" ? Number(r.count) : r.count,
    }));
}
