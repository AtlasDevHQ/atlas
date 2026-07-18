/**
 * Admin cache management routes.
 *
 * Mounted under /api/v1/admin/cache via admin.route().
 * Org-admin scope: the cache is a per-workspace operational surface
 * (already listed in the org-admin sidebar). Responses are per-caller
 * (#4549): a workspace admin sees their own org's bucket and flushes only
 * their own org's entries (no-org / single-tenant deployments degenerate to
 * a full flush — see the handler); fleet-wide counters and the fleet flush
 * are platform-admin-only, so cross-tenant activity never leaks to a tenant.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminActionAwait, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter } from "./admin-router";

const log = createLogger("admin-cache");

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

/**
 * Per-caller stats payload. `scope` tells the page which view it is looking
 * at (self-describing — the page never consults the user's role):
 *   - `workspace` — the caller's org bucket. `maxSize` is `null`: the fleet
 *     capacity budget is a platform framing a tenant shouldn't reason about.
 *   - `platform` — fleet aggregate + resolved backend capacity.
 * `since: null` with `enabled: true` is the "warming" state (no recorded
 * activity yet); rates are `null` (not 0) when there is nothing to rate.
 * `entryCount: null` means the count is structurally unavailable (a plugin
 * backend has no per-org count) — never rendered as a confident 0.
 */
const CacheStatsResponseSchema = z.object({
  scope: z.enum(["workspace", "platform"]),
  enabled: z.boolean(),
  ttl: z.number(),
  since: z.number().nullable(),
  hits: z.number(),
  misses: z.number(),
  hitRate: z.number().nullable(),
  windowHitRate: z.number().nullable(),
  windowTotal: z.number(),
  entryCount: z.number().nullable(),
  maxSize: z.number().nullable(),
});

/**
 * Flush scope. Default `workspace`: remove only the caller's org's entries.
 * `fleet` (platform admin only) clears every workspace's entries in this
 * process — the blast radius the page's fleet dialog discloses.
 */
const FlushRequestSchema = z.object({
  scope: z.enum(["workspace", "fleet"]).default("workspace"),
});

const FlushResponseSchema = z.object({
  ok: z.boolean(),
  flushed: z.number(),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getCacheStatsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Admin — Cache"],
  summary: "Cache statistics",
  description:
    "Returns per-caller cache statistics: a workspace admin gets their " +
    "org's hit/miss bucket (lifetime + sliding last-hour rates), a platform " +
    "admin gets fleet totals plus resolved capacity.",
  responses: {
    200: {
      description: "Cache stats",
      content: { "application/json": { schema: CacheStatsResponseSchema } },
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
  description:
    "Removes cached query results. Default scope `workspace` purges only the " +
    "caller's org's entries; scope `fleet` (platform admin only) clears every " +
    "workspace's entries in this process. Refused with 409 when caching is " +
    "disabled.",
  request: {
    body: {
      content: { "application/json": { schema: FlushRequestSchema } },
      required: false,
    },
  },
  responses: {
    200: {
      description: "Cache flushed",
      content: { "application/json": { schema: FlushResponseSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin/owner role (and MFA enrollment) required; fleet scope additionally requires platform admin", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Invalid request body — rejected by request validation", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Cache is disabled — nothing to flush", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminCache = createAdminRouter();

// GET /stats — per-caller cache statistics
adminCache.openapi(getCacheStatsRoute, async (c) => runHandler(c, "retrieve cache statistics", async () => {
  const authResult = c.get("authResult");
  const isPlatformAdmin = authResult.user?.role === "platform_admin";
  const scope = isPlatformAdmin ? ("platform" as const) : ("workspace" as const);
  // Resolve enabled/ttl for the CALLER's workspace so a per-workspace
  // ATLAS_CACHE_ENABLED / ATLAS_CACHE_TTL override is reflected (#4545).
  const orgId = authResult.user?.activeOrganizationId;
  const { getCache, cacheEnabled, getDefaultTtl, getOrgCacheStats, getFleetCacheStats, cacheOrgEntryCount } =
    await import("@atlas/api/lib/cache/index");
  const ttl = getDefaultTtl(orgId);
  if (!cacheEnabled(orgId)) {
    // Honest disabled state: no placeholder telemetry — rates are null, not
    // a 0.0% that reads as "broken".
    return c.json({
      scope, enabled: false, ttl,
      since: null, hits: 0, misses: 0, hitRate: null, windowHitRate: null, windowTotal: 0,
      entryCount: 0, maxSize: null,
    }, 200);
  }
  if (isPlatformAdmin) {
    // Fleet view: registry aggregate (app-maintained per-org accounting)
    // plus the backend's live entry count / capacity. The LRU's `stats()`
    // prunes expired entries (a plugin backend MAY not, per the contract),
    // so the fill gauge is corpse-free for the owned backend.
    const fleet = getFleetCacheStats();
    const stats = await getCache().stats();
    return c.json({
      scope, enabled: true, ttl, ...fleet,
      entryCount: stats.entryCount, maxSize: stats.maxSize,
    }, 200);
  }
  // Workspace view: the caller's org bucket only — fleet-wide counters
  // (cross-tenant activity) never reach a tenant (closes audit L13). With no
  // org (auth mode "none"), the whole cache belongs to this one tenant, so
  // the backend's own count is their count. `entryCount` stays null when the
  // count is structurally unavailable (plugin backend) — the page renders
  // "unavailable", never a confident 0 over a warm cache.
  const bucket = getOrgCacheStats(orgId);
  const entryCount = orgId !== undefined
    ? await cacheOrgEntryCount(orgId)
    : (await getCache().stats()).entryCount;
  return c.json({
    scope, enabled: true, ttl, ...bucket,
    entryCount, maxSize: null,
  }, 200);
}));

// POST /flush — org-scoped by default; fleet-wide for platform admins only
adminCache.openapi(flushCacheRoute, async (c) => runHandler(c, "flush cache", async () => {
  const requestId = c.get("requestId") as string;
  const authResult = c.get("authResult");
  const isPlatformAdmin = authResult.user?.role === "platform_admin";
  const orgId = authResult.user?.activeOrganizationId;

  // A declared `application/json` body is validated by zod-openapi (invalid
  // scope → 422 before this handler). The body is optional and the framework
  // skips validation for other content types, so re-read the raw text and
  // validate here too: an ABSENT body defaults to a workspace-scoped flush,
  // but a PRESENT-yet-invalid one is a 422 — never a silent downgrade of a
  // fleet flush the caller thinks they issued.
  const rawText = await c.req.text();
  let scope: "workspace" | "fleet" = "workspace";
  if (rawText.trim() !== "") {
    let rawBody: unknown;
    try {
      rawBody = JSON.parse(rawText);
    } catch (err) {
      log.warn({ requestId, err: err instanceof Error ? err.message : String(err) }, "Unparseable cache-flush body rejected");
      return c.json({ error: "invalid_request", message: "Request body must be JSON.", requestId }, 422);
    }
    const parsed = FlushRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: "Invalid request body: scope must be \"workspace\" or \"fleet\".", requestId }, 422);
    }
    scope = parsed.data.scope;
  }

  const { getCache, flushCache, flushCacheByOrg, cacheEnabled, cacheOrgEntryCount } =
    await import("@atlas/api/lib/cache/index");
  if (!cacheEnabled(orgId)) {
    // A refused flush is a refusal, not a success with a body flag — the
    // page must render an error surface, never "Flushed 0 entries" (#4549).
    return c.json({
      error: "cache_disabled",
      message: "Caching is disabled for this workspace — there is nothing to flush.",
      requestId,
    }, 409);
  }

  // #4533 — attribution IS the security control on a shared surface: the
  // audit row is committed via `logAdminActionAwait` BEFORE the flush takes
  // effect in EVERY branch below, so a circuit-open / DB-down window can
  // never leave a successful flush with no committed record. A rejection
  // propagates to runHandler as a 500 (with requestId) and the flush never
  // runs.
  if (scope === "fleet") {
    if (!isPlatformAdmin) {
      return c.json({
        error: "forbidden_scope",
        message: "Fleet-wide flush requires the platform admin role. Omit scope (or send scope: \"workspace\") to flush your own workspace's entries.",
        requestId,
      }, 403);
    }
    const count = (await getCache().stats()).entryCount;
    await logAdminActionAwait({
      actionType: ADMIN_ACTIONS.cache.flush,
      targetType: "cache",
      targetId: "default",
      metadata: { scope: "fleet", flushed: count },
    });
    await flushCache();
    log.info({ requestId, userId: authResult.user?.id, flushed: count }, "Cache flushed fleet-wide via admin API");
    return c.json({ ok: true, flushed: count, message: "Cache flushed" }, 200);
  }

  if (orgId === undefined) {
    // Auth mode "none" / single-tenant: the whole cache is this one
    // tenant's, so a workspace flush degenerates to a full flush.
    const count = (await getCache().stats()).entryCount;
    await logAdminActionAwait({
      actionType: ADMIN_ACTIONS.cache.flush,
      targetType: "cache",
      targetId: "default",
      metadata: { scope: "workspace", flushed: count },
    });
    await flushCache();
    log.info({ requestId, userId: authResult.user?.id, flushed: count }, "Cache flushed (single-tenant) via admin API");
    return c.json({ ok: true, flushed: count, message: "Cache flushed" }, 200);
  }

  // The audit row commits BEFORE the flush (#4533), so it records the
  // pre-flush count — honestly: `null` (not a fake 0) when the count is
  // structurally unavailable on a plugin backend. The response's `flushed`
  // is the backend's actual removal count either way.
  const count = await cacheOrgEntryCount(orgId);
  await logAdminActionAwait({
    actionType: ADMIN_ACTIONS.cache.flush,
    targetType: "cache",
    targetId: orgId,
    metadata: { scope: "workspace", orgId, flushed: count },
  });
  const removed = await flushCacheByOrg(orgId);
  log.info({ requestId, userId: authResult.user?.id, orgId, flushed: removed }, "Cache flushed for workspace via admin API");
  return c.json({ ok: true, flushed: removed, message: "Cache flushed" }, 200);
}));

export { adminCache };
