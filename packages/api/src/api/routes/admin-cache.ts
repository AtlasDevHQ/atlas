/**
 * Admin cache management routes.
 *
 * Mounted under /api/v1/admin/cache via admin.route().
 * Org-admin scope: the cache is a per-workspace operational surface
 * (already listed in the org-admin sidebar). Stats are aggregate counters
 * with no per-org breakdown so there's no cross-org leak.
 *
 * Flush is process-global — `flushCache()` clears every workspace's
 * entries on the same runtime, not just the caller's. Acceptable because
 * cache misses just trigger re-fetch (no confidentiality / integrity
 * impact, only a noisy-neighbor cache-warmup hit), but every flush emits
 * a `cache.flush` admin_action_log row so a fleet-wide invalidation can
 * always be attributed to a specific admin.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminActionAwait, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter } from "./admin-router";

const log = createLogger("admin-cache");

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getCacheStatsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Admin — Cache"],
  summary: "Cache statistics",
  description: "Returns cache hit/miss statistics.",
  responses: {
    200: {
      description: "Cache stats",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin/owner role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const flushCacheRoute = createRoute({
  method: "post",
  path: "/flush",
  tags: ["Admin — Cache"],
  summary: "Flush cache",
  description: "Flushes all cache entries.",
  responses: {
    200: {
      description: "Cache flushed",
      content: { "application/json": { schema: z.object({ ok: z.boolean(), flushed: z.number(), message: z.string() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin/owner role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminCache = createAdminRouter();

// GET /stats — cache statistics
adminCache.openapi(getCacheStatsRoute, async (c) => runHandler(c, "retrieve cache statistics", async () => {
  const authResult = c.get("authResult");
  // Resolve enabled/ttl for the CALLER's workspace so a per-workspace
  // ATLAS_CACHE_ENABLED / ATLAS_CACHE_TTL override is reflected (#4545).
  const orgId = authResult.user?.activeOrganizationId;
  const { getCache, cacheEnabled, getDefaultTtl } = await import("@atlas/api/lib/cache/index");
  // Reported stats derive from RESOLVED settings, never constructor-frozen
  // values: `ttl` is the workspace-resolved TTL; `maxSize` comes from the
  // backend, which getCache() has already reconciled to the resolved
  // platform setting.
  const ttl = getDefaultTtl(orgId);
  if (!cacheEnabled(orgId)) {
    return c.json({ enabled: false, hits: 0, misses: 0, hitRate: 0, missRate: 0, entryCount: 0, maxSize: 0, ttl }, 200);
  }
  const stats = await getCache().stats();
  const total = stats.hits + stats.misses;
  const hitRate = total > 0 ? stats.hits / total : 0;
  const missRate = total > 0 ? stats.misses / total : 0;
  return c.json({ enabled: true, ...stats, ttl, hitRate, missRate }, 200);
}));

// POST /flush — flush entire cache
adminCache.openapi(flushCacheRoute, async (c) => runHandler(c, "flush cache", async () => {
  const requestId = c.get("requestId") as string;
  const authResult = c.get("authResult");

  const { getCache, flushCache, cacheEnabled } = await import("@atlas/api/lib/cache/index");
  if (!cacheEnabled(authResult.user?.activeOrganizationId)) {
    return c.json({ ok: false, flushed: 0, message: "Cache is disabled" }, 200);
  }
  const count = (await getCache().stats()).entryCount;
  // Attribution IS the security control here: flush is process-global (clears
  // every workspace's entries on this runtime), so a fleet-wide invalidation
  // must always be attributable to a specific admin. Commit the audit row
  // BEFORE the flush takes effect — via `logAdminActionAwait` (not
  // fire-and-forget `logAdminAction`, whose insert is swallowed by a
  // circuit breaker) — so a circuit-open / DB-down window can never leave a
  // successful flush with no committed record. A rejection propagates to
  // runHandler as a 500 (with requestId) rather than a silent 200; the flush
  // never runs. Cache is a process-singleton so `targetId: "default"` mirrors
  // the SLA / backup-config pattern for non-row-keyed admin surfaces.
  await logAdminActionAwait({
    actionType: ADMIN_ACTIONS.cache.flush,
    targetType: "cache",
    targetId: "default",
    metadata: { flushed: count },
  });
  await flushCache();
  log.info({ requestId, userId: authResult.user?.id, flushed: count }, "Cache flushed via admin API");
  return c.json({ ok: true, flushed: count, message: "Cache flushed" }, 200);
}));

export { adminCache };
