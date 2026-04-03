/**
 * Admin cache management routes.
 *
 * Mounted under /api/v1/admin/cache via admin.route().
 * Platform-admin only: the query cache is a global resource.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createPlatformRouter } from "./admin-router";

const log = createLogger("admin-cache");

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getCacheStatsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Admin — Cache"],
  summary: "Cache statistics",
  description: "Returns cache hit/miss statistics. Platform admin only.",
  responses: {
    200: {
      description: "Cache stats",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const flushCacheRoute = createRoute({
  method: "post",
  path: "/flush",
  tags: ["Admin — Cache"],
  summary: "Flush cache",
  description: "Flushes all cache entries. Platform admin only.",
  responses: {
    200: {
      description: "Cache flushed",
      content: { "application/json": { schema: z.object({ ok: z.boolean(), flushed: z.number(), message: z.string() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminCache = createPlatformRouter();

// GET /stats — cache statistics
adminCache.openapi(getCacheStatsRoute, async (c) => runHandler(c, "retrieve cache statistics", async () => {
  const { getCache, cacheEnabled } = await import("@atlas/api/lib/cache/index");
  if (!cacheEnabled()) {
    return c.json({ enabled: false, hits: 0, misses: 0, hitRate: 0, missRate: 0, entryCount: 0, maxSize: 0, ttl: 0 }, 200);
  }
  const stats = getCache().stats();
  const total = stats.hits + stats.misses;
  const hitRate = total > 0 ? stats.hits / total : 0;
  const missRate = total > 0 ? stats.misses / total : 0;
  return c.json({ enabled: true, ...stats, hitRate, missRate }, 200);
}));

// POST /flush — flush entire cache
adminCache.openapi(flushCacheRoute, async (c) => runHandler(c, "flush cache", async () => {
  const requestId = c.get("requestId") as string;
  const authResult = c.get("authResult");

  const { getCache, flushCache, cacheEnabled } = await import("@atlas/api/lib/cache/index");
  if (!cacheEnabled()) {
    return c.json({ ok: false, flushed: 0, message: "Cache is disabled" }, 200);
  }
  const count = getCache().stats().entryCount;
  flushCache();
  log.info({ requestId, userId: authResult.user?.id, flushed: count }, "Cache flushed via admin API");
  return c.json({ ok: true, flushed: count, message: "Cache flushed" }, 200);
}));

export { adminCache };
