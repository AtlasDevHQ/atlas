/**
 * Scheduler-driven periodic refresh for the SHARED, cross-workspace OpenAPI spec
 * cache (#2970, Tier-1).
 *
 * `shared-spec-cache.ts` downloads + normalizes a public catalog spec (Stripe,
 * GitHub, Notion) ONCE across all workspaces. This fiber keeps that working set
 * fresh on a cadence: it conditional-GETs every spec currently warm in the shared
 * cache (`If-None-Match` / `If-Modified-Since`). A `304` re-arms the freshness
 * window and serves every workspace on the pod for free; a `200` re-normalizes the
 * changed document ONCE and advances the catalog's "current" pointer so the next
 * install reuses the fresh graph instead of re-downloading.
 *
 * ## Scope guard (Tier-1 vs Tier-2)
 * This is the TIER-1 refresh: the SHARED cache of PUBLIC catalog specs. It is
 * deliberately bounded to the in-process working set (specs at least one workspace
 * installed/resolved on this pod) — it never proactively downloads a public spec
 * no one uses, and it NEVER mutates any workspace's persisted snapshot. Per-
 * install, customer-configurable re-discovery of private/custom datasources is
 * Tier-2 (#2976 diff, #2977 interval knob, #2978 scheduler, #2979 breaking-change
 * signal) and stays orthogonal — so this loop can't conflict with the per-install
 * snapshot/diff/persist path.
 *
 * ## Lifecycle
 * Scheduled by `registerPeriodicFiber` in `effect/layers.ts` (#4195): a
 * `forkScoped` fiber that runs an initial cycle on boot then repeats on the
 * configured cadence, interrupted cleanly on layer-scope shutdown. No internal-DB
 * dependency (the cache is process-local), so it starts unconditionally; a cycle
 * with an empty cache is a cheap no-op.
 *
 * @see ../effect/layers.ts — `registerPeriodicFiber`, the fiber scheduler.
 * @see ./periodic-db-job.ts — the DB-cycle skeleton the byot/rediscover siblings
 *   share and that this (non-DB) job deliberately does NOT use.
 * @see ../openapi/shared-spec-cache.ts — the cache + the per-cycle logic.
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  refreshSharedSpecsCycle,
  type SharedRefreshCycleResult,
} from "@atlas/api/lib/openapi/shared-spec-cache";
import { findDataCandidateByCatalogId } from "@atlas/api/lib/openapi/data-candidates";

const log = createLogger("openapi-spec-refresh");

/** Default interval: 24 hours (mirrors the BYOT + semantic-expert cadence). */
export const DEFAULT_SHARED_SPEC_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve a cached catalog id back to its spec URL via the code-resident
 * data-candidate registry — the SAME pinned, public URL the install probed. A
 * catalog id with no registry entry (drift) returns `undefined`, and the cycle
 * skips it rather than refreshing against a guessed URL.
 */
function specUrlForCatalog(catalogId: string): string | undefined {
  return findDataCandidateByCatalogId(catalogId)?.openapiUrl;
}

/**
 * The periodic refresh interval (ms). Reads
 * `ATLAS_OPENAPI_SPEC_REFRESH_INTERVAL_HOURS`, defaults to 24. Mirrors
 * `getExpertSchedulerIntervalMs` so the cadence is operator-tunable without a
 * code change.
 */
export function getSharedSpecRefreshIntervalMs(): number {
  const raw = process.env.ATLAS_OPENAPI_SPEC_REFRESH_INTERVAL_HOURS;
  if (!raw) return DEFAULT_SHARED_SPEC_REFRESH_INTERVAL_MS;
  const hours = Number.parseFloat(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_SHARED_SPEC_REFRESH_INTERVAL_MS;
  return hours * 60 * 60 * 1000;
}

/**
 * Run a single refresh cycle over the shared cache's working set. Never throws —
 * `refreshSharedSpecsCycle` isolates per-catalog failures (logged + counted) so a
 * down upstream can't stall the others or kill the scheduler loop.
 *
 * Heartbeat (#3183 L-1): emits a per-cycle `log.info` start line, and — for the
 * empty-cache case `refreshSharedSpecsCycle` doesn't otherwise log — a completion
 * heartbeat, so a hung tick is visible in logs. The per-tick liveness SPAN
 * (`atlas.scheduler.openapi_spec_refresh`) is applied by `registerPeriodicFiber`
 * around the fiber in `effect/layers.ts` (#4195), where the fiber's
 * `spanResultAttributes` carry the inspected/updated/not-modified/failed counts.
 * This job schedules through `registerPeriodicFiber` like its siblings but,
 * having no internal-DB working set (its cache is process-local), does NOT use
 * the `runPeriodicDbCycle` DB-cycle skeleton the byot/rediscover jobs share.
 */
export async function runOpenApiSpecRefreshCycle(): Promise<SharedRefreshCycleResult> {
  log.info("Shared OpenAPI spec refresh cycle starting");
  const result = await refreshSharedSpecsCycle({ specUrlFor: specUrlForCatalog });
  // `refreshSharedSpecsCycle` already emits a detailed "cycle complete" log
  // (with per-catalog counts) when the working set is non-empty. Emit our own
  // completion heartbeat for the empty-cache case — the common shape on a
  // fresh pod or low-traffic region — so the cadence is unbroken there too
  // and the two paths each leave exactly one start + one complete log.
  if (result.inspected === 0) {
    log.info("Shared OpenAPI spec refresh cycle complete — empty working set (no cached specs to refresh)");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Scheduling — via `registerPeriodicFiber` in `effect/layers.ts` (#4195)
// ---------------------------------------------------------------------------
//
// The Tier-1 refresh no longer hand-rolls a `setInterval` lifecycle. The fiber
// that repeats `runOpenApiSpecRefreshCycle` — interval
// (`getSharedSpecRefreshIntervalMs`), per-tick span, and `withFiberDeathLog` —
// is owned by `registerPeriodicFiber` (arch-win #100 / #4130), forked
// `forkScoped` for the pod lifetime. It starts unconditionally (no internal-DB
// gate; the cache is process-local). `Schedule.spaced` there spaces ticks by
// completion, so a slow cycle can never overlap the next — subsuming the old
// `_inFlight` guard.

/**
 * Manual-trigger entry point (admin scheduler page / tests). Runs a single cycle
 * and returns its structured result.
 */
export async function triggerOpenApiSpecRefreshCycle(): Promise<SharedRefreshCycleResult> {
  return runOpenApiSpecRefreshCycle();
}
