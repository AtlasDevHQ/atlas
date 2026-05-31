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
 * `setInterval`-based with `unref()` (doesn't pin the process), an initial cycle
 * on start, and a single-running guard so double-start is a no-op — mirrors
 * `byot-catalog-refresh.ts`. No internal-DB dependency (the cache is process-
 * local), so it starts unconditionally; a cycle with an empty cache is a cheap
 * no-op.
 *
 * @see ./byot-catalog-refresh.ts — the periodic-refresh pattern this follows.
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
 */
export async function runOpenApiSpecRefreshCycle(): Promise<SharedRefreshCycleResult> {
  return refreshSharedSpecsCycle({ specUrlFor: specUrlForCatalog });
}

// ---------------------------------------------------------------------------
// Lifecycle (setInterval-based, mirrors byot-catalog-refresh.ts)
// ---------------------------------------------------------------------------

let _timer: ReturnType<typeof setInterval> | null = null;
let _running = false;
/** A still-running cycle, so a slow tick never overlaps the next one. */
let _inFlight = false;

function runCycleWithDefectGuard(): void {
  // Overlap guard: a cycle does network I/O (conditional GETs). With the default
  // 24h cadence overlap is impossible, but a misconfigured short interval — or a
  // very slow upstream — could otherwise start a second cycle before the first
  // finished, racing on the shared-cache pointers. Skip this tick if one is still
  // in flight; the next tick picks the work back up.
  if (_inFlight) {
    log.debug("Shared OpenAPI spec refresh cycle still in flight — skipping this tick");
    return;
  }
  _inFlight = true;
  runOpenApiSpecRefreshCycle()
    .catch((err: unknown) => {
      // The cycle catches per-catalog failures internally; this guard only fires
      // on an unexpected defect (e.g. the registry import threw) so the loop
      // survives and the next tick still runs.
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Shared OpenAPI spec refresh cycle defected past its internal catch",
      );
    })
    .finally(() => {
      _inFlight = false;
    });
}

/**
 * Start the shared OpenAPI spec refresh scheduler. Runs an initial cycle
 * immediately, then repeats at the configured interval. No-op if already running.
 * A non-positive / non-finite `intervalMs` falls back to the configured default
 * rather than hot-looping `setInterval`.
 */
export function startOpenApiSpecRefreshScheduler(intervalMs?: number): void {
  if (_running) {
    log.debug("Shared OpenAPI spec refresh scheduler already running — skipping start");
    return;
  }
  // Validate the explicit override: a 0 / negative / NaN interval would make
  // setInterval fire continuously. Fall back to the (already-validated) configured
  // interval so a bad caller-supplied value can't spin the event loop.
  const interval =
    intervalMs !== undefined && Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : getSharedSpecRefreshIntervalMs();
  _running = true;
  log.info({ intervalMs: interval }, "Starting shared OpenAPI spec refresh scheduler");

  runCycleWithDefectGuard();
  _timer = setInterval(runCycleWithDefectGuard, interval);
  _timer.unref();
}

export function stopOpenApiSpecRefreshScheduler(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _running = false;
  log.info("Shared OpenAPI spec refresh scheduler stopped");
}

export function isOpenApiSpecRefreshSchedulerRunning(): boolean {
  return _running;
}

/** Test-only: reset scheduler state. */
export function _resetOpenApiSpecRefreshScheduler(): void {
  stopOpenApiSpecRefreshScheduler();
}

/**
 * Manual-trigger entry point (admin scheduler page / tests). Runs a single cycle
 * and returns its structured result.
 */
export async function triggerOpenApiSpecRefreshCycle(): Promise<SharedRefreshCycleResult> {
  return runOpenApiSpecRefreshCycle();
}
