/**
 * Organization activity stamping (#2377).
 *
 * `markOrgActive` records that a workspace was touched by an authenticated
 * request, by bumping `organization.last_active_at`. The BYOT catalog refresh
 * scheduler (lib/scheduler/byot-catalog-refresh.ts) reads that column to skip
 * refreshing model catalogs for workspaces nobody has used in
 * `ATLAS_BYOT_DORMANCY_DAYS` — keeping upstream provider rate-limit + audit
 * noise off dormant orgs.
 *
 * Two properties make this safe to call on the hot path of every chat turn:
 *
 *   1. Throttled. The dormancy gate operates at multi-day granularity, so
 *      sub-window freshness is irrelevant. We write at most once per org per
 *      `ACTIVITY_THROTTLE_MS` window and short-circuit otherwise, keeping the
 *      UPDATE off the per-request path almost always. The throttle is
 *      per-pod (in-memory): a few redundant writes across pods are harmless.
 *
 *   2. Fire-and-forget. `internalExecute` never throws on async failure (it
 *      logs + trips a circuit breaker), so a write miss can't fail or block
 *      the request. We still guard `hasInternalDB()` first because
 *      `internalExecute` throws *synchronously* when DATABASE_URL is unset.
 *
 * Managed-auth only. The `organization` table exists solely in managed-auth
 * deployments (Better Auth owns its DDL — see MANAGED_AUTH_MIGRATIONS); an
 * UPDATE against it in any other mode would error. Dormancy gating is a
 * multi-tenant concern that does not apply to single-tenant self-hosted, so
 * we no-op there.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalExecute } from "@atlas/api/lib/db/internal";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";

const log = createLogger("org-activity");

/**
 * Minimum gap between two `last_active_at` writes for the same org. One hour
 * is far below the dormancy threshold (days), so activity stays fresh enough
 * to gate on while the write rate stays negligible.
 */
const ACTIVITY_THROTTLE_MS = 60 * 60 * 1000;

/**
 * Cap on the per-pod throttle map. Active-org cardinality is naturally
 * bounded, but a long-lived pod serving a large fleet should not accumulate
 * entries without limit. On overflow we clear the map wholesale — worst case
 * every org writes once more within the next window, which is negligible.
 */
const MAX_TRACKED_ORGS = 100_000;

/** orgId → epoch-ms of the last write we issued for it. */
const _lastMarkedActive = new Map<string, number>();

/**
 * Stamp `organization.last_active_at = now()` for `orgId`, throttled and
 * fire-and-forget. No-ops when `orgId` is empty, the internal DB is
 * unavailable, the deployment is not managed-auth, or the org was already
 * stamped within the throttle window. Never throws.
 */
export function markOrgActive(orgId: string | undefined | null): void {
  if (!orgId) return;
  try {
    if (!hasInternalDB()) return;
    // The `organization` table only exists under managed auth (see module
    // doc). Cached + cheap; safe to call per request. Kept INSIDE the try so
    // the "never throws" contract holds even on an invalid ATLAS_AUTH_MODE
    // (detectAuthMode throws on that — cached, would normally fail at boot).
    if (detectAuthMode() !== "managed") return;

    const now = Date.now();
    const last = _lastMarkedActive.get(orgId);
    if (last !== undefined && now - last < ACTIVITY_THROTTLE_MS) return;

    if (_lastMarkedActive.size >= MAX_TRACKED_ORGS) {
      _lastMarkedActive.clear();
    }
    _lastMarkedActive.set(orgId, now);

    // Fire-and-forget. internalExecute logs async failures + trips its own
    // circuit breaker; this try also covers the synchronous pool-init throw
    // (already guarded by hasInternalDB above, but belt-and-braces).
    internalExecute(`UPDATE organization SET last_active_at = now() WHERE id = $1`, [orgId]);
  } catch (err) {
    // A failed activity stamp must never surface to the caller — the worst
    // consequence is the BYOT catalog skips one refresh for an org that is
    // in fact active, which self-corrects on the next stamped request.
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "markOrgActive: activity not stamped",
    );
  }
}

/** Test-only: clear the in-memory throttle map. */
export function _resetOrgActivityThrottleForTests(): void {
  _lastMarkedActive.clear();
}
