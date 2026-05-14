/**
 * Admin connection management routes.
 *
 * Mounted under /api/v1/admin/connections via admin.route().
 * Org-scoped: workspace admins see only connections belonging to their org.
 * The config-managed `default` connection is surfaced as a fallback when the
 * org has no `connections` rows of its own (self-hosted single-tenant).
 * Platform admins see all.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { connections, detectDBType } from "@atlas/api/lib/db/connection";
import { hasInternalDB, internalQuery, encryptSecret, decryptSecret, type URLSecret } from "@atlas/api/lib/db/internal";
import { activeKeyVersion } from "@atlas/api/lib/db/encryption-keys";
import { maskConnectionUrl } from "@atlas/api/lib/security";
import { _resetWhitelists } from "@atlas/api/lib/semantic";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { checkResourceLimit } from "@atlas/api/lib/billing/enforcement";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext, requirePermission } from "./admin-router";
import { Effect } from "effect";
import {
  CONTENT_MODE_TABLES,
  makeService,
} from "@atlas/api/lib/content-mode";

/**
 * Module-level synchronous content-mode registry (#1515 phase 2c).
 * `readFilter` is a pure function of the static tuple; `Effect.runSync`
 * is safe because no I/O and the key is a known-simple entry.
 */
const contentModeRegistry = makeService(CONTENT_MODE_TABLES);

const log = createLogger("admin-connections");

/** Read atlasMode from the Hono context. Defaults to "published" (most restrictive) when not set. */
function getAtlasMode(c: { get(key: string): unknown }): import("@useatlas/types/auth").AtlasMode {
  return (c.get("atlasMode") as import("@useatlas/types/auth").AtlasMode | undefined) ?? "published";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the set of connection IDs visible to a workspace admin.
 * Returns null for platform admins (they see all connections).
 *
 * The runtime-registered `default` connection (sourced from
 * `ATLAS_DATASOURCE_URL`) is only surfaced when the org has zero rows of its
 * own in `connections`. On SaaS every onboarded org owns either `__demo__` or
 * a wizard-created connection that aliases the same physical DB as `default`,
 * so seeding `default` unconditionally produced a phantom duplicate in the
 * Connections list, the Semantic page, and the Schema Diff picker. Self-
 * hosted single-tenant deployments still see `default` because they have no
 * `connections` rows at all.
 *
 * @param mode - Atlas mode. Published mode sees only published connections;
 *   developer mode additionally sees drafts. Archived connections are hidden
 *   in both modes.
 */
export async function getVisibleConnectionIds(
  orgId: string,
  _isPlatformAdmin: boolean,
  mode?: import("@useatlas/types/auth").AtlasMode,
): Promise<Set<string> | null> {
  // Always scope to the active org. Platform admins requiring cross-org
  // visibility must use the workspace switcher to set their active org or
  // the dedicated `/platform/*` surfaces — bypassing the org filter here
  // leaks every customer's connections into every workspace's admin page,
  // which is what the `isPlatformAdmin → return null` branch did before
  // #2303.
  const visible = new Set<string>();

  if (hasInternalDB()) {
    const statusClause = Effect.runSync(
      contentModeRegistry.readFilter("connections", mode ?? "published", "c"),
    );
    // Org's own rows + `__global__` fallback. A per-org row with the same
    // id shadows the global row so onboarding-chosen demos (e.g. an
    // industry-specific `__demo__`) override the canonical global one.
    const rows = await internalQuery<{ id: string }>(
      `SELECT c.id FROM connections c WHERE c.org_id = $1 AND ${statusClause}
       UNION
       SELECT c.id FROM connections c
       WHERE c.org_id = '__global__' AND ${statusClause}
         AND NOT EXISTS (
           SELECT 1 FROM connections c2 WHERE c2.org_id = $1 AND c2.id = c.id
         )
       ORDER BY 1`,
      [orgId],
    );
    for (const row of rows) {
      visible.add(row.id);
    }
  }

  if (visible.size === 0 && connections.has("default")) {
    visible.add("default");
  }

  return visible;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listConnectionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Connections"],
  summary: "List connections",
  description: "Returns registered database connections. Scoped to active organization.",
  responses: {
    200: {
      description: "Connection list",
      content: { "application/json": { schema: z.object({ connections: z.array(z.unknown()) }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getPoolMetricsRoute = createRoute({
  method: "get",
  path: "/pool",
  tags: ["Admin — Connections"],
  summary: "Pool metrics",
  description: "Returns connection pool metrics. Scoped to active organization.",
  responses: {
    200: {
      description: "Pool metrics",
      content: { "application/json": { schema: z.object({ metrics: z.unknown() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getOrgPoolMetricsRoute = createRoute({
  method: "get",
  path: "/pool/orgs",
  tags: ["Admin — Connections"],
  summary: "Org-scoped pool metrics",
  description: "Returns connection pool metrics scoped by organization.",
  responses: {
    200: {
      description: "Org pool metrics",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const drainOrgPoolRoute = createRoute({
  method: "post",
  path: "/pool/orgs/{orgId}/drain",
  tags: ["Admin — Connections"],
  summary: "Drain org pools",
  description: "Drains all connection pools for a specific organization.",
  request: {
    params: z.object({
      orgId: z.string().min(1).openapi({ param: { name: "orgId", in: "path" }, example: "org_abc123" }),
    }),
  },
  responses: {
    200: {
      description: "Drain result",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const drainConnectionPoolRoute = createRoute({
  method: "post",
  path: "/{id}/drain",
  tags: ["Admin — Connections"],
  summary: "Drain connection pool",
  description: "Drains and recreates the pool for a specific connection.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "warehouse" }),
    }),
  },
  responses: {
    200: {
      description: "Pool drained",
      content: { "application/json": { schema: z.object({ drained: z.boolean(), message: z.string() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Connection not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Pool drain conflict", content: { "application/json": { schema: z.object({ drained: z.boolean(), message: z.string() }) } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const testConnectionRoute = createRoute({
  method: "post",
  path: "/test",
  tags: ["Admin — Connections"],
  summary: "Test connection URL",
  description: "Tests a database connection URL without persisting it.",
  responses: {
    200: {
      description: "Connection test result",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid request or connection failed", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const testExistingConnectionRoute = createRoute({
  method: "post",
  path: "/{id}/test",
  tags: ["Admin — Connections"],
  summary: "Health check connection",
  description: "Runs a health check on an existing connection.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "warehouse" }),
    }),
  },
  responses: {
    200: {
      description: "Health check result",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Connection not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createConnectionRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Connections"],
  summary: "Create connection",
  description: "Creates a new database connection. Tests it before saving. Scoped to active organization.",
  responses: {
    201: {
      description: "Connection created",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid request or connection failed", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Connection already exists", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateConnectionRoute = createRoute({
  method: "put",
  path: "/{id}",
  tags: ["Admin — Connections"],
  summary: "Update connection",
  description: "Updates an existing connection's URL, description, or schema. Scoped to active organization.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "warehouse" }),
    }),
  },
  responses: {
    200: {
      description: "Connection updated",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid request or connection failed", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Connection not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteConnectionRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — Connections"],
  summary: "Delete connection",
  description: "Removes a connection from the registry and internal database. Scoped to active organization.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "warehouse" }),
    }),
  },
  responses: {
    200: {
      description: "Connection deleted",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Connection not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Connection has references", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getConnectionRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin — Connections"],
  summary: "Get connection detail",
  description: "Returns connection detail including masked URL and schema. Scoped to active organization.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "warehouse" }),
    }),
  },
  responses: {
    200: {
      description: "Connection detail",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Connection not found", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminConnections = createAdminRouter();
adminConnections.use(requireOrgContext());
// F-53 — admin:connections refines adminAuth with the custom-role permission
// check. Pool drains, secret rotation (decrypt) and CRUD on connection rows
// all require the flag.
adminConnections.use(requirePermission("admin:connections"));

// GET / — list connections scoped to active org
adminConnections.openapi(listConnectionsRoute, async (c) => runHandler(c, "list connections", async () => {
  const { orgId } = c.get("orgContext");
  const authResult = c.get("authResult");
  const isPlatformAdmin = authResult.user?.role === "platform_admin";
  const connList = connections.describe();
  const visible = await getVisibleConnectionIds(orgId, isPlatformAdmin, getAtlasMode(c));
  const filtered = visible ? connList.filter((conn) => visible.has(conn.id)) : connList;

  // Decorate with `group_id` from the internal DB. The in-memory registry
  // tracks runtime metadata but not group membership; merging here keeps
  // both surfaces in lockstep without a second round-trip from the admin
  // UI. The no-internal-DB branch (self-hosted single-tenant) and the
  // empty-result branch both fall through with `groupId: null` on every
  // row. Transient DB errors propagate via runHandler's classifyError —
  // a flaky pool surfaces as a 500 here just like every other list
  // endpoint, no silent-success fallback.
  let groupIdByConnection = new Map<string, string | null>();
  if (hasInternalDB() && filtered.length > 0) {
    const ids = filtered.map((c) => c.id);
    const rows = await internalQuery<{ id: string; group_id: string | null }>(
      `SELECT id, group_id FROM connections WHERE org_id = $1 AND id = ANY($2::text[])`,
      [orgId, ids],
    );
    groupIdByConnection = new Map(rows.map((r) => [r.id, r.group_id]));
  }

  const decorated = filtered.map((c) => ({
    ...c,
    groupId: groupIdByConnection.get(c.id) ?? null,
  }));

  return c.json({ connections: decorated }, 200);
}));

// GET /pool — pool metrics scoped to active org
adminConnections.openapi(getPoolMetricsRoute, async (c) => runHandler(c, "get pool metrics", async () => {
  const { orgId } = c.get("orgContext");
  // Same scoping rule as the connections list: platform admins see the
  // active org's pools, not every tenant's. Cross-org pool views belong
  // to `/platform/*`. Pre-fix, platform admins saw pools for every
  // tenant's `__demo__` and wizard-created connections aggregated into
  // the default Pool stats card.
  const metrics = connections.getOrgPoolMetrics(orgId);
  return c.json({ metrics }, 200);
}));

// GET /pool/orgs — org pool metrics (workspace admins restricted to own org)
adminConnections.openapi(getOrgPoolMetricsRoute, async (c) => runHandler(c, "get org pool metrics", async () => {
  const { requestId, orgId } = c.get("orgContext");
  const authResult = c.get("authResult");
  const isPlatformAdmin = authResult.user?.role === "platform_admin";

  try {
    // Workspace admins can only see their own org's metrics
    const targetOrgId = isPlatformAdmin ? (c.req.query("orgId") || undefined) : orgId;
    const metrics = connections.getOrgPoolMetrics(targetOrgId);
    const config = connections.getOrgPoolConfig();
    return c.json({
      metrics,
      config,
      orgCount: isPlatformAdmin ? connections.listOrgs().length : 1,
    }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to retrieve org pool metrics");
    return c.json({ error: "metrics_failed", message: errorMessage(err), requestId }, 500);
  }
}));

// POST /pool/orgs/:orgId/drain — drain org pools (restricted to own org for workspace admins)
adminConnections.openapi(drainOrgPoolRoute, async (c) => runHandler(c, "drain org pools", async () => {
  const { requestId, orgId } = c.get("orgContext");
  const authResult = c.get("authResult");
  const isPlatformAdmin = authResult.user?.role === "platform_admin";
  const targetOrgId = c.req.valid("param").orgId;

  // Workspace admins can only drain their own org's pools
  if (!isPlatformAdmin && targetOrgId !== orgId) {
    return c.json({ error: "forbidden", message: "Cannot drain pools for another organization.", requestId }, 403);
  }

  try {
    const result = await connections.drainOrg(targetOrgId);
    log.info({ orgId: targetOrgId, drained: result.drained, requestId, userId: authResult.user?.id }, "Org pools drained via admin API");

    logAdminAction({
      actionType: ADMIN_ACTIONS.connection.poolDrain,
      targetType: "connection",
      targetId: targetOrgId,
      scope: "platform",
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { orgId: targetOrgId, drainedConnections: result.drained },
    });

    return c.json(result, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), orgId: targetOrgId, requestId }, "Org pool drain failed");
    return c.json({ error: "drain_failed", message: errorMessage(err), requestId }, 500);
  }
}));

// POST /:id/drain — drain a specific connection pool (must be visible to org)
adminConnections.openapi(drainConnectionPoolRoute, async (c) => runHandler(c, "drain connection pool", async () => {
  const { requestId, orgId } = c.get("orgContext");
  const authResult = c.get("authResult");
  const isPlatformAdmin = authResult.user?.role === "platform_admin";
  const { id } = c.req.valid("param");

  if (!connections.has(id)) {
    return c.json({ error: "not_found", message: `Connection "${id}" not found`, requestId }, 404);
  }

  // Workspace admins can only drain connections visible to their org
  const visible = await getVisibleConnectionIds(orgId, isPlatformAdmin, getAtlasMode(c));
  if (visible && !visible.has(id)) {
    return c.json({ error: "not_found", message: `Connection "${id}" not found`, requestId }, 404);
  }

  try {
    const result = await connections.drain(id);
    if (!result.drained) {
      return c.json({ drained: false, message: result.message }, 409);
    }
    log.info({ connectionId: id, requestId, userId: authResult.user?.id }, "Pool drained via admin API");

    logAdminAction({
      actionType: ADMIN_ACTIONS.connection.poolDrain,
      targetType: "connection",
      targetId: id,
      scope: "workspace",
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { connectionId: id },
    });

    return c.json({ drained: true, message: result.message }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), connectionId: id, requestId }, "Pool drain failed");
    logAdminAction({
      actionType: ADMIN_ACTIONS.connection.poolDrain,
      targetType: "connection",
      targetId: id,
      scope: "workspace",
      status: "failure",
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { connectionId: id, error: errorMessage(err) },
    });
    return c.json({ error: "drain_failed", message: errorMessage(err), requestId }, 500);
  }
}));

// POST /test — test a connection URL (transient, no org scoping needed)
adminConnections.openapi(testConnectionRoute, async (c) => runHandler(c, "test connection", async () => {
  const { requestId } = c.get("orgContext");

  const body = await c.req.json().catch((err: unknown) => {
    log.warn({ err: errorMessage(err), requestId }, "Failed to parse JSON body in test connection request");
    return null;
  });
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_request", message: "Request body is required.", requestId }, 400);
  }

  const { url, schema } = body as Record<string, unknown>;
  if (!url || typeof url !== "string") {
    return c.json({ error: "invalid_request", message: "Connection URL is required.", requestId }, 400);
  }

  let dbType: string;
  try {
    dbType = detectDBType(url);
  } catch (err) {
    return c.json({ error: "invalid_request", message: errorMessage(err), requestId }, 400);
  }

  const tempId = `_test_${Date.now()}`;
  // Ephemeral probes have no persisted target — use the tempId as the
  // target so forensic queries can count probes without conflating them
  // with the existing-connection health-check surface. See F-29 / F-34.
  const ipAddress = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
  try {
    connections.register(tempId, {
      url,
      description: undefined,
      schema: typeof schema === "string" ? schema : undefined,
    });
    const result = await connections.healthCheck(tempId);
    logAdminAction({
      actionType: ADMIN_ACTIONS.connection.probe,
      targetType: "connection",
      targetId: tempId,
      status: result.status === "healthy" ? "success" : "failure",
      ipAddress,
      metadata: { success: result.status === "healthy", dbType, latencyMs: result.latencyMs },
    });
    return c.json({ status: result.status, latencyMs: result.latencyMs, dbType }, 200);
  } catch (err) {
    log.warn({ err: errorMessage(err), requestId }, "Connection test failed");
    logAdminAction({
      actionType: ADMIN_ACTIONS.connection.probe,
      targetType: "connection",
      targetId: tempId,
      status: "failure",
      ipAddress,
      metadata: { success: false, dbType },
    });
    return c.json({
      error: "connection_failed",
      message: `Connection test failed: ${errorMessage(err)}`,
      requestId,
    }, 400);
  } finally {
    if (connections.has(tempId)) {
      connections.unregister(tempId);
    }
  }
}));

// POST /:id/test — health check existing connection (must be visible to org)
adminConnections.openapi(testExistingConnectionRoute, async (c) => runHandler(c, "health check connection", async () => {
  const { requestId, orgId } = c.get("orgContext");
  const authResult = c.get("authResult");
  const isPlatformAdmin = authResult.user?.role === "platform_admin";
  const { id } = c.req.valid("param");

  const registered = connections.list();
  if (!registered.includes(id)) {
    return c.json({ error: "not_found", message: `Connection "${id}" not found.`, requestId }, 404);
  }

  const visible = await getVisibleConnectionIds(orgId, isPlatformAdmin, getAtlasMode(c));
  if (visible && !visible.has(id)) {
    return c.json({ error: "not_found", message: `Connection "${id}" not found.`, requestId }, 404);
  }

  const result = await connections.healthCheck(id);

  // `connection.health_check` is distinct from `connection.probe` (the
  // ephemeral `POST /test` surface) so forensic queries can separately
  // count privilege-escalation probes vs. routine health checks against
  // a persisted datasource. Metadata shape matches probe: same success
  // / dbType / latencyMs fields so downstream dashboards can union the
  // two when appropriate. See F-29 / F-34.
  const registryEntry = connections.describe().find((entry) => entry.id === id);
  logAdminAction({
    actionType: ADMIN_ACTIONS.connection.healthCheck,
    targetType: "connection",
    targetId: id,
    status: result.status === "healthy" ? "success" : "failure",
    ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    metadata: {
      success: result.status === "healthy",
      dbType: registryEntry?.dbType ?? "unknown",
      latencyMs: result.latencyMs,
    },
  });

  return c.json(result, 200);
}));

// POST / — create connection scoped to active org
adminConnections.openapi(createConnectionRoute, async (c) => runHandler(c, "create connection", async () => {
  const { requestId, orgId } = c.get("orgContext");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Connection management requires an internal database (DATABASE_URL).", requestId }, 404);
  }

  // Enforce plan connection limit before proceeding. Exclude archived
  // rows so per-org delete-as-hide tombstones (the shadow rows for
  // hidden `__global__` connections) don't count against the org's plan
  // limit. A workspace that hides the demo shouldn't lose a slot for it.
  const connCountRows = await internalQuery<{ count: number }>(
    `SELECT COUNT(*)::int as count FROM connections WHERE org_id = $1 AND status != 'archived'`,
    [orgId],
  );
  const connCount = connCountRows[0]?.count ?? 0;
  const resourceCheck = await checkResourceLimit(orgId, "connections", connCount);
  if (!resourceCheck.allowed) {
    return c.json({ error: "plan_limit_exceeded", message: resourceCheck.errorMessage, requestId }, 429);
  }

  const body = await c.req.json().catch((err: unknown) => {
    log.warn({ err: errorMessage(err), requestId }, "Failed to parse JSON body in create connection request");
    return null;
  });

  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_request", message: "Request body is required.", requestId }, 400);
  }

  const { id, url, description, schema } = body as Record<string, unknown>;

  if (!id || typeof id !== "string" || !/^[a-z][a-z0-9_-]*$/.test(id)) {
    return c.json({ error: "invalid_request", message: "Connection ID must be lowercase alphanumeric with hyphens/underscores (e.g. 'warehouse').", requestId }, 400);
  }
  if (id === "default") {
    return c.json({ error: "invalid_request", message: "Cannot create a connection with ID 'default'. The default connection is managed via ATLAS_DATASOURCE_URL.", requestId }, 400);
  }
  if (!url || typeof url !== "string") {
    return c.json({ error: "invalid_request", message: "Connection URL is required.", requestId }, 400);
  }

  let dbType: string;
  try {
    dbType = detectDBType(url);
  } catch (err) {
    return c.json({ error: "invalid_request", message: errorMessage(err), requestId }, 400);
  }

  if (connections.has(id)) {
    return c.json({ error: "conflict", message: `Connection "${id}" already exists.`, requestId }, 409);
  }

  // Archive-aware conflict check: the archive-on-delete flow preserves rows,
  // so the (id, org_id) PK may collide even when the registry has no entry.
  // If an archived row already owns this PK, the INSERT below would 500;
  // we revive it instead via UPDATE. Any other status (published/draft) is a
  // real conflict.
  let existingRow: { status: string }[];
  try {
    existingRow = await internalQuery<{ status: string }>(
      `SELECT status FROM connections WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
  } catch (err) {
    log.error({ err: errorMessage(err), connectionId: id, requestId }, "Failed to check for existing connection row before create");
    return c.json({ error: "internal_error", message: "Failed to check for existing connection. Try again.", requestId }, 500);
  }
  if (existingRow.length > 0 && existingRow[0].status !== "archived") {
    return c.json({ error: "conflict", message: `Connection "${id}" already exists.`, requestId }, 409);
  }
  const revivingArchived = existingRow.length > 0;

  // Test the connection before saving
  try {
    connections.register(id, {
      url,
      description: typeof description === "string" ? description : undefined,
      schema: typeof schema === "string" ? schema : undefined,
    });
    await connections.healthCheck(id);
  } catch (err) {
    connections.unregister(id);
    return c.json({
      error: "connection_failed",
      message: `Connection test failed: ${errorMessage(err)}. Fix the URL and try again.`,
      requestId,
    }, 400);
  }

  // Encrypt and persist to internal DB with org_id
  let encryptedUrl: URLSecret;
  try {
    encryptedUrl = encryptSecret(url);
  } catch (err) {
    connections.unregister(id);
    log.error({ err: errorMessage(err), connectionId: id, requestId }, "Failed to encrypt connection URL");
    return c.json({ error: "encryption_failed", message: "Failed to encrypt connection URL. Check ATLAS_ENCRYPTION_KEY or BETTER_AUTH_SECRET.", requestId }, 500);
  }

  // All new connections stamp `status = 'draft'` regardless of the caller's
  // `atlasMode` header (#2177). The pending-changes pill in the admin top bar
  // surfaces the draft count; the admin publishes via the atomic
  // `/api/v1/admin/publish` endpoint instead of flipping a mode toggle first.
  const status = "draft";

  try {
    const urlKeyVersion = activeKeyVersion();
    if (revivingArchived) {
      // The archived row owns the PK — revive it in place so we preserve
      // audit/version history rather than stranding it.
      await internalQuery(
        `UPDATE connections SET url = $1, url_key_version = $8, type = $2, description = $3, schema_name = $4, status = $5, updated_at = now() WHERE id = $6 AND org_id = $7`,
        [encryptedUrl, dbType, typeof description === "string" ? description : null, typeof schema === "string" ? schema : null, status, id, orgId, urlKeyVersion],
      );
    } else {
      await internalQuery(
        `INSERT INTO connections (id, url, url_key_version, type, description, schema_name, org_id, status) VALUES ($1, $2, $8, $3, $4, $5, $6, $7)`,
        [id, encryptedUrl, dbType, typeof description === "string" ? description : null, typeof schema === "string" ? schema : null, orgId, status, urlKeyVersion],
      );
    }
  } catch (err) {
    connections.unregister(id);
    log.error({ err: errorMessage(err), connectionId: id, requestId }, "Failed to persist connection");
    return c.json({ error: "internal_error", message: "Failed to save connection.", requestId }, 500);
  }

  try {
    _resetWhitelists();
  } catch (err) {
    log.warn({ err: errorMessage(err), requestId }, "Failed to reset whitelists after connection create");
  }

  log.info({ requestId, connectionId: id, dbType, orgId, actorId: authResult.user?.id }, "Connection created");

  logAdminAction({
    actionType: ADMIN_ACTIONS.connection.create,
    targetType: "connection",
    targetId: id as string,
    ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    metadata: { name: id as string, dbType },
  });

  return c.json({
    id,
    dbType,
    description: typeof description === "string" ? description : null,
    maskedUrl: maskConnectionUrl(url),
  }, 201);
}));

// PUT /:id — update connection (must belong to org)
adminConnections.openapi(updateConnectionRoute, async (c) => runHandler(c, "update connection", async () => {
  const { requestId, orgId } = c.get("orgContext");
  const authResult = c.get("authResult");
  const { id } = c.req.valid("param");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Connection management requires an internal database (DATABASE_URL).", requestId }, 404);
  }

  if (id === "default") {
    return c.json({ error: "forbidden", message: "Cannot modify the default connection. Update ATLAS_DATASOURCE_URL instead.", requestId }, 403);
  }

  // Check it exists in the DB and belongs to this org. Excludes archived
  // rows so per-org delete-as-hide tombstones (whose `url = ''` placeholder
  // would crash `decryptSecret` below) read as "not found here, did you mean
  // to restore first?" rather than a misleading "encryption key changed"
  // 500.
  const existing = await internalQuery<{ id: string; url: string; type: string; description: string | null; schema_name: string | null }>(
    `SELECT id, url, type, description, schema_name FROM connections
     WHERE id = $1 AND org_id = $2 AND status != 'archived'`,
    [id, orgId],
  );

  if (existing.length === 0) {
    return c.json({ error: "not_found", message: `Connection "${id}" not found or is not admin-managed.`, requestId }, 404);
  }

  const body = await c.req.json().catch((err: unknown) => {
    log.warn({ err: errorMessage(err), requestId }, "Failed to parse JSON body in update connection request");
    return null;
  });

  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_request", message: "Request body is required.", requestId }, 400);
  }

  const { url, description, schema } = body as Record<string, unknown>;
  const current = existing[0];

  let currentUrl: string;
  try {
    currentUrl = decryptSecret(current.url);
  } catch (err) {
    log.error({ connectionId: id, requestId, err: errorMessage(err) }, "Failed to decrypt stored connection URL");
    return c.json({ error: "decryption_failed", message: "Stored connection URL could not be decrypted. The encryption key may have changed.", requestId }, 500);
  }

  const newUrl = typeof url === "string" ? url : currentUrl;
  const newDescription = typeof description === "string" ? description : current.description;
  const newSchema = typeof schema === "string" ? (schema || null) : current.schema_name;
  const urlChanged = typeof url === "string" && url !== currentUrl;

  let dbType = current.type;
  if (urlChanged) {
    try {
      dbType = detectDBType(newUrl);
    } catch (err) {
      return c.json({ error: "invalid_request", message: errorMessage(err), requestId }, 400);
    }
  }

  // Re-test if URL changed
  if (urlChanged) {
    try {
      connections.register(id, { url: newUrl, description: newDescription ?? undefined, schema: newSchema ?? undefined });
      await connections.healthCheck(id);
    } catch (err) {
      let rollbackFailed = false;
      try {
        connections.register(id, { url: currentUrl, description: current.description ?? undefined, schema: current.schema_name ?? undefined });
      } catch (restoreErr) {
        rollbackFailed = true;
        log.error({ connectionId: id, requestId, err: errorMessage(restoreErr) }, "Failed to restore previous connection after update failure — connection unregistered");
        connections.unregister(id);
      }
      const baseMsg = `Connection test failed: ${errorMessage(err)}. Fix the URL and try again.`;
      if (rollbackFailed) {
        return c.json({ error: "internal_error", message: `${baseMsg} The connection may need a server restart to restore.`, requestId }, 500);
      }
      return c.json({ error: "connection_failed", message: baseMsg, requestId }, 400);
    }
  } else {
    try {
      connections.register(id, { url: newUrl, description: newDescription ?? undefined, schema: newSchema ?? undefined });
    } catch (err) {
      log.error({ err: errorMessage(err), connectionId: id, requestId }, "Failed to re-register connection with updated metadata");
      return c.json({ error: "internal_error", message: "Failed to update connection.", requestId }, 500);
    }
  }

  // Encrypt and update in DB — rollback registry on failure
  let encryptedNewUrl: URLSecret;
  try {
    encryptedNewUrl = encryptSecret(newUrl);
  } catch (err) {
    let rollbackFailed = false;
    try {
      connections.register(id, { url: currentUrl, description: current.description ?? undefined, schema: current.schema_name ?? undefined });
    } catch (restoreErr) {
      rollbackFailed = true;
      log.error({ connectionId: id, requestId, err: restoreErr instanceof Error ? restoreErr.message : String(restoreErr) }, "Failed to restore previous connection after encryption failure — connection unregistered");
      connections.unregister(id);
    }
    log.error({ err: errorMessage(err), connectionId: id, requestId }, "Failed to encrypt connection URL");
    const encMsg = rollbackFailed
      ? "Failed to encrypt connection URL. Check ATLAS_ENCRYPTION_KEY or BETTER_AUTH_SECRET. The connection may need a server restart to restore."
      : "Failed to encrypt connection URL. Check ATLAS_ENCRYPTION_KEY or BETTER_AUTH_SECRET.";
    return c.json({ error: "encryption_failed", message: encMsg, requestId }, 500);
  }

  try {
    const urlKeyVersion = activeKeyVersion();
    await internalQuery(
      `UPDATE connections SET url = $1, url_key_version = $7, type = $2, description = $3, schema_name = $4, updated_at = NOW() WHERE id = $5 AND org_id = $6`,
      [encryptedNewUrl, dbType, newDescription, newSchema, id, orgId, urlKeyVersion],
    );
  } catch (err) {
    let rollbackFailed = false;
    try {
      connections.register(id, { url: currentUrl, description: current.description ?? undefined, schema: current.schema_name ?? undefined });
    } catch (restoreErr) {
      rollbackFailed = true;
      log.error({ connectionId: id, requestId, err: restoreErr instanceof Error ? restoreErr.message : String(restoreErr) }, "Failed to restore previous connection after DB update failure — connection unregistered");
      connections.unregister(id);
    }
    log.error({ err: errorMessage(err), connectionId: id, requestId }, "Failed to update connection in DB");
    const updateMsg = rollbackFailed
      ? "Failed to update connection. The connection may need a server restart to restore."
      : "Failed to update connection.";
    return c.json({ error: "internal_error", message: updateMsg, requestId }, 500);
  }

  try {
    _resetWhitelists();
  } catch (err) {
    log.warn({ err: errorMessage(err), requestId }, "Failed to reset whitelists after connection update");
  }

  log.info({ requestId, connectionId: id, urlChanged, actorId: authResult.user?.id }, "Connection updated");

  logAdminAction({
    actionType: ADMIN_ACTIONS.connection.update,
    targetType: "connection",
    targetId: id,
    ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    metadata: { name: id, urlChanged },
  });

  return c.json({ id, dbType, description: newDescription, maskedUrl: maskConnectionUrl(newUrl) }, 200);
}));

// DELETE /:id — delete connection (must belong to org)
adminConnections.openapi(deleteConnectionRoute, async (c) => runHandler(c, "delete connection", async () => {
  const { requestId, orgId } = c.get("orgContext");
  const authResult = c.get("authResult");
  const { id } = c.req.valid("param");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Connection management requires an internal database (DATABASE_URL).", requestId }, 404);
  }

  if (id === "default") {
    return c.json({ error: "forbidden", message: "Cannot delete the default connection.", requestId }, 403);
  }

  // With the global demo + per-org tombstone model (#2304), "delete" no
  // longer mutates shared state — it inserts a per-org archived row that
  // hides the global from this workspace only. Other tenants are
  // untouched. Updates to the canonical demo URL/description go through
  // the PUT handler; #2177 removed the demo-readonly 403 there so admins
  // can edit demo data without flipping the mode toggle first.

  // Two cases:
  //   - Org-owned row exists → archive in place (existing behavior).
  //   - Only a `__global__` row exists for this id (e.g. the shared
  //     `__demo__` provisioned by onboarding under #2304) → insert a
  //     per-org archived shadow row. The visibility query's NOT EXISTS
  //     check then hides the global from this org's view while leaving
  //     it intact for every other workspace.
  // `type` is NOT NULL in the schema (migration 0000_baseline.sql:170,
  // schema.ts:276) — declare it as `string`, not `string | null`. The
  // previous annotation invented a nullable case the DB cannot produce.
  const existing = await internalQuery<{ id: string; org_id: string; type: string }>(
    `SELECT id, org_id, type FROM connections WHERE id = $1 AND org_id IN ($2, '__global__')`,
    [id, orgId],
  );
  const ownRow = existing.find((r) => r.org_id === orgId);
  const globalRow = existing.find((r) => r.org_id === "__global__");

  if (!ownRow && !globalRow) {
    return c.json({ error: "not_found", message: `Connection "${id}" not found or is not admin-managed.`, requestId }, 404);
  }

  try {
    const groupRefs = await internalQuery<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM scheduled_tasks st
         JOIN connections c
           ON c.group_id = st.connection_group_id
          AND c.org_id = st.org_id
        WHERE c.id = $1 AND c.org_id = $2`,
      [id, orgId],
    );
    const refCount = parseInt(String(groupRefs[0]?.count ?? "0"), 10);
    if (refCount > 0) {
      return c.json({
        error: "conflict",
        message: `Cannot delete connection "${id}" — its environment is referenced by ${refCount} scheduled task(s). Remove or update those tasks first.`,
        requestId,
      }, 409);
    }
  } catch (err) {
    // Only ignore "relation does not exist" (42P01) — scheduled_tasks table may not exist yet
    const isTableMissing = err instanceof Error && "code" in err && (err as { code: string }).code === "42P01";
    if (!isTableMissing) {
      log.error({ err: errorMessage(err), connectionId: id, requestId }, "Failed to check scheduled task references");
      return c.json({ error: "internal_error", message: "Failed to verify scheduled task references before deletion. Try again or contact your administrator.", requestId }, 500);
    }
    log.warn({ connectionId: id, requestId }, "Scheduled tasks table does not exist — skipping reference check");
  }

  try {
    if (ownRow) {
      // Archive in place — drafts can be restored, publish flow retains history.
      await internalQuery(
        `UPDATE connections SET status = 'archived', updated_at = now() WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
    } else {
      // Global-only row: insert a per-org archived shadow. URL is empty
      // because we never want to mutate the canonical global URL — the
      // archived status alone hides it from this org's lists.
      //
      // Readers must filter by `status != 'archived'` before passing this
      // row to `decryptSecret` or runtime registration — the empty URL is a
      // marker, not a value. Those filters live in `wizard.ts`,
      // `internal.ts::loadSavedConnections`, and the PUT/GET handlers in
      // this file.
      await internalQuery(
        `INSERT INTO connections (id, url, url_key_version, type, description, org_id, status)
         VALUES ($1, '', 1, $2, $3, $4, 'archived')
         ON CONFLICT (id, org_id) DO UPDATE SET status = 'archived', updated_at = now()`,
        [id, globalRow!.type, `Hidden from this workspace`, orgId],
      );
    }
  } catch (err) {
    log.error({ err: errorMessage(err), connectionId: id, requestId }, "Failed to archive connection");
    return c.json({ error: "internal_error", message: "Failed to archive connection.", requestId }, 500);
  }

  // Only unregister from the in-memory pool when we actually archived the
  // org-owned row. Global-only delete is a per-org hide — the underlying
  // connection must stay registered for other workspaces.
  if (ownRow) {
    try {
      connections.unregister(id);
    } catch (err) {
      log.warn({ err: errorMessage(err), connectionId: id, requestId }, "Failed to unregister connection from in-memory registry — will reconcile on restart");
    }
  }

  log.info({ requestId, connectionId: id, actorId: authResult.user?.id }, "Connection archived");

  logAdminAction({
    actionType: ADMIN_ACTIONS.connection.delete,
    targetType: "connection",
    targetId: id,
    ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    metadata: { name: id },
  });

  return c.json({ success: true }, 200);
}));

// GET /:id — get connection detail (must be visible to org)
adminConnections.openapi(getConnectionRoute, async (c) => runHandler(c, "get connection detail", async () => {
  const { requestId, orgId } = c.get("orgContext");
  const authResult = c.get("authResult");
  const isPlatformAdmin = authResult.user?.role === "platform_admin";
  const { id } = c.req.valid("param");

  if (!connections.has(id)) {
    return c.json({ error: "not_found", message: `Connection "${id}" not found.`, requestId }, 404);
  }

  // Verify visibility for workspace admins
  const visible = await getVisibleConnectionIds(orgId, isPlatformAdmin, getAtlasMode(c));
  if (visible && !visible.has(id)) {
    return c.json({ error: "not_found", message: `Connection "${id}" not found.`, requestId }, 404);
  }

  const meta = connections.describe().find((m) => m.id === id);

  // If admin-managed, include masked URL and schema from DB
  let maskedUrl: string | null = null;
  let schema: string | null = null;
  let managed = false;
  if (hasInternalDB()) {
    try {
      // Defense-in-depth: even though visibility already filters out
      // archived rows, exclude them here too so a future visibility-layer
      // bug can never feed the empty-string tombstone marker to decryptSecret.
      const rows = await internalQuery<{ url: string; schema_name: string | null }>(
        "SELECT url, schema_name FROM connections WHERE id = $1 AND org_id = $2 AND status != 'archived'",
        [id, orgId],
      );
      if (rows.length > 0) {
        managed = true;
        schema = rows[0].schema_name;
        try {
          maskedUrl = maskConnectionUrl(decryptSecret(rows[0].url));
        } catch (decryptErr) {
          log.error({ connectionId: id, requestId, err: decryptErr instanceof Error ? decryptErr.message : String(decryptErr) }, "Failed to decrypt stored connection URL");
          maskedUrl = "[encrypted — decryption failed]";
        }
      }
    } catch (err) {
      log.error({ err: errorMessage(err), connectionId: id, requestId }, "Failed to fetch connection details from internal DB");
      return c.json({ error: "internal_error", message: "Failed to fetch connection details from internal database.", requestId }, 500);
    }
  }

  return c.json({
    id,
    dbType: meta?.dbType ?? "unknown",
    description: meta?.description ?? null,
    health: meta?.health ?? null,
    maskedUrl,
    schema,
    managed,
  }, 200);
}));

export { adminConnections };
