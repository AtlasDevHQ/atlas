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
 *
 * MUST MATCH the client copy in
 * `packages/web/src/app/admin/cache/page.tsx` (`CacheStatsResponseSchema`)
 * — the web package can't import from `@atlas/api`, so the two are
 * hand-synced (same for the entries schema below).
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

/**
 * One live entry's metadata row for the inspection table (#4550). Metadata
 * ONLY — the cached rows blob never crosses the wire on this surface, and
 * `sqlPreview` is the ~200-char capped preview stamped at write time
 * (absent on entries written before #4550).
 */
const CacheEntryMetaSchema = z.object({
  key: z.string(),
  sqlPreview: z.string().optional(),
  connectionId: z.string(),
  rowCount: z.number(),
  ageMs: z.number(),
  ttl: z.number(),
});

/**
 * `entries: null` = listing structurally unavailable (plugin backend — no
 * trustworthy org index), mirroring the #4549 nullable-entryCount pattern:
 * never a confident empty table over a warm cache.
 */
const CacheEntriesResponseSchema = z.object({
  entries: z.array(CacheEntryMetaSchema).nullable(),
});

// A 200 always means the entry was removed (not-found is a 404, unsupported
// backend a 409) — literals make the contract self-documenting.
const DeleteEntryResponseSchema = z.object({
  ok: z.literal(true),
  deleted: z.literal(true),
});

/**
 * Fail-closed guard for the no-org branches (#4550 review): an absent
 * `activeOrganizationId` means "single-tenant deployment" ONLY outside
 * managed auth (mode "none" / simple-key have no org concept). A managed
 * session without an active org must never widen to whole-cache reach —
 * that would silently disclose (or delete) co-tenant data. Platform admins
 * are exempt: cross-tenant reach is their legitimate authority (they can
 * fleet-flush and inspect any org). Mirrors `requireOrgContext()`'s 400
 * contract without imposing it router-wide (which would break the
 * single-tenant modes this page supports).
 */
function managedSessionMissingOrg(authResult: { mode: string; user?: { role?: string; activeOrganizationId?: string } | undefined }): boolean {
  return authResult.mode === "managed"
    && authResult.user?.activeOrganizationId === undefined
    && authResult.user?.role !== "platform_admin";
}

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
    400: { description: "Managed session has no active organization", content: { "application/json": { schema: ErrorSchema } } },
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
    400: { description: "Managed session has no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin/owner role (and MFA enrollment) required; fleet scope additionally requires platform admin", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Invalid request body — rejected by request validation", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Cache is disabled — nothing to flush", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const listCacheEntriesRoute = createRoute({
  method: "get",
  path: "/entries",
  tags: ["Admin — Cache"],
  summary: "List cached entries",
  description:
    "Lists the caller's org's live cached entries as metadata rows (age, row " +
    "count, connection, capped SQL preview) — expired entries never appear " +
    "and the cached rows themselves are never returned. A platform admin may " +
    "pass ?orgId= to inspect a specific org. `entries: null` means the " +
    "listing is unavailable on the current cache backend; an empty list may " +
    "also mean caching is disabled for the listed org.",
  request: {
    query: z.object({
      orgId: z.string().optional().openapi({ param: { name: "orgId", in: "query" } }),
    }),
  },
  responses: {
    200: {
      description: "Live entry metadata",
      content: { "application/json": { schema: CacheEntriesResponseSchema } },
    },
    400: { description: "Managed session has no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin/owner role required; ?orgId= inspection requires platform admin", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteCacheEntryRoute = createRoute({
  method: "delete",
  path: "/entries/{key}",
  tags: ["Admin — Cache"],
  summary: "Delete one cached entry",
  description:
    "Removes exactly one cached entry, authorized org-scoped: the delete " +
    "lands only when the key belongs to the caller's org (404 otherwise — " +
    "a co-tenant's key is indistinguishable from a missing one). Cross-org " +
    "delete is deliberately unsupported (inspection via ?orgId= is " +
    "platform-scoped; mutation stays caller-org-only). Fixing one stale " +
    "dashboard number costs one entry, not the org's whole cache.",
  request: {
    params: z.object({
      key: z.string().min(1).max(256).openapi({ param: { name: "key", in: "path" } }),
    }),
  },
  responses: {
    200: {
      description: "Entry deleted",
      content: { "application/json": { schema: DeleteEntryResponseSchema } },
    },
    400: { description: "Managed session has no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin/owner role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "No such entry in the caller's org", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Cache disabled, or per-entry delete unavailable on the current backend", content: { "application/json": { schema: ErrorSchema } } },
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
  const requestId = c.get("requestId") as string;
  const authResult = c.get("authResult");
  const isPlatformAdmin = authResult.user?.role === "platform_admin";
  const scope = isPlatformAdmin ? ("platform" as const) : ("workspace" as const);
  if (managedSessionMissingOrg(authResult)) {
    return c.json({ error: "bad_request", message: "No active organization. Set an active org first.", requestId }, 400);
  }
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
    if (managedSessionMissingOrg(authResult)) {
      return c.json({ error: "bad_request", message: "No active organization. Set an active org first.", requestId }, 400);
    }
    // Single-tenant deployment (auth mode "none" / simple-key — no org
    // concept): the whole cache is this one tenant's, so a workspace flush
    // degenerates to a full flush.
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

// GET /entries — org-scoped entry inspection (#4550)
adminCache.openapi(listCacheEntriesRoute, async (c) => runHandler(c, "list cache entries", async () => {
  const requestId = c.get("requestId") as string;
  const authResult = c.get("authResult");
  const isPlatformAdmin = authResult.user?.role === "platform_admin";
  const callerOrgId = authResult.user?.activeOrganizationId;
  const { orgId: inspectOrgId } = c.req.valid("query");

  // Strictly org-scoped visibility: a workspace admin may only ever list
  // their own org; ?orgId= inspection of another org is platform-only.
  if (inspectOrgId !== undefined && inspectOrgId !== callerOrgId && !isPlatformAdmin) {
    return c.json({
      error: "forbidden_scope",
      message: "Inspecting another workspace's cache entries requires the platform admin role.",
      requestId,
    }, 403);
  }
  if (managedSessionMissingOrg(authResult)) {
    return c.json({ error: "bad_request", message: "No active organization. Set an active org first.", requestId }, 400);
  }
  const targetOrgId = inspectOrgId ?? callerOrgId;

  const { cacheEnabled, cacheListByOrg } = await import("@atlas/api/lib/cache/index");
  // Gate on the org being LISTED (not the caller's): `ATLAS_CACHE_ENABLED`
  // is workspace-scoped, so a platform admin whose own workspace disabled
  // caching must still see a warm target org's entries — never a confident
  // empty table over live data. When the target org's cache is off, nothing
  // is being served, so an empty list is honest (no 409 — read-only).
  if (!cacheEnabled(targetOrgId)) {
    return c.json({ entries: [] }, 200);
  }
  const entries = await cacheListByOrg(targetOrgId);
  return c.json({ entries }, 200);
}));

// DELETE /entries/{key} — org-authorized single-entry removal (#4550)
adminCache.openapi(deleteCacheEntryRoute, async (c) => runHandler(c, "delete cache entry", async () => {
  const requestId = c.get("requestId") as string;
  const authResult = c.get("authResult");
  const orgId = authResult.user?.activeOrganizationId;
  const { key } = c.req.valid("param");

  if (managedSessionMissingOrg(authResult)) {
    return c.json({ error: "bad_request", message: "No active organization. Set an active org first.", requestId }, 400);
  }

  const { cacheEnabled, cacheDeleteEntry } = await import("@atlas/api/lib/cache/index");
  if (!cacheEnabled(orgId)) {
    return c.json({
      error: "cache_disabled",
      message: "Caching is disabled for this workspace — there is nothing to delete.",
      requestId,
    }, 409);
  }

  // #4533 discipline carried over: the attribution row commits BEFORE the
  // delete takes effect, so a removal can never go unrecorded. The row is
  // written even when the delete then 404s — it records the ATTEMPT, which
  // is forensically useful in itself (a workspace admin probing raw keys
  // against a co-tenant's cache shows up here). Key is stored truncated —
  // it is a lookup hash, and 12 chars is plenty to correlate.
  await logAdminActionAwait({
    actionType: ADMIN_ACTIONS.cache.deleteEntry,
    targetType: "cache",
    targetId: orgId ?? "default",
    metadata: { orgId: orgId ?? null, key: key.slice(0, 12) },
  });

  const removed = await cacheDeleteEntry(orgId, key);
  if (removed === null) {
    return c.json({
      error: "unsupported_backend",
      message: "Per-entry delete is not available on the current cache backend. Use flush instead.",
      requestId,
    }, 409);
  }
  if (!removed) {
    // Not found OR another org's key — deliberately indistinguishable, so a
    // raw key can't be used to probe a co-tenant's cache contents.
    return c.json({
      error: "not_found",
      message: "No such cache entry in your workspace.",
      requestId,
    }, 404);
  }
  log.info({ requestId, userId: authResult.user?.id, orgId, key: key.slice(0, 12) }, "Cache entry deleted via admin API");
  return c.json({ ok: true, deleted: true }, 200);
}));

export { adminCache };
