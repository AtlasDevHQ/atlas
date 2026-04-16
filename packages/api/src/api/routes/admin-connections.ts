/**
 * Admin connection management routes.
 *
 * Mounted under /api/v1/admin/connections via admin.route().
 * Org-scoped: workspace admins see only connections belonging to their org
 * (plus the "default" config-managed connection). Platform admins see all.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { connections, detectDBType } from "@atlas/api/lib/db/connection";
import { hasInternalDB, internalQuery, encryptUrl, decryptUrl } from "@atlas/api/lib/db/internal";
import { maskConnectionUrl } from "@atlas/api/lib/security";
import { _resetWhitelists } from "@atlas/api/lib/semantic";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { checkResourceLimit } from "@atlas/api/lib/billing/enforcement";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";
import { buildUnionStatusClause } from "./middleware";

const log = createLogger("admin-connections");

/** Read atlasMode from the Hono context. Defaults to "published" (most restrictive) when not set. */
function getAtlasMode(c: { get(key: string): unknown }): import("@useatlas/types/auth").AtlasMode {
  return (c.get("atlasMode") as import("@useatlas/types/auth").AtlasMode | undefined) ?? "published";
}

/** Reserved ID for the onboarding demo connection. Writes in published mode are read-only. */
const DEMO_CONNECTION_ID = "__demo__";

/** Demo-readonly response for writes in published mode against `__demo__`. */
function demoReadonly(requestId: string): { error: string; message: string; requestId: string } {
  return {
    error: "demo_readonly",
    message: "Demo connection is read-only in published mode. Switch to developer mode to manage connections.",
    requestId,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the set of connection IDs visible to a workspace admin.
 * Returns null for platform admins (they see all connections).
 *
 * @param mode - Atlas mode. Published mode sees only published connections;
 *   developer mode additionally sees drafts. Archived connections are hidden
 *   in both modes.
 */
async function getVisibleConnectionIds(
  orgId: string,
  isPlatformAdmin: boolean,
  mode?: import("@useatlas/types/auth").AtlasMode,
): Promise<Set<string> | null> {
  if (isPlatformAdmin) return null; // null = no filter

  // "default" connection from config is always visible
  const visible = new Set<string>(["default"]);

  if (hasInternalDB()) {
    const statusClause = buildUnionStatusClause(mode);
    const rows = await internalQuery<{ id: string }>(
      `SELECT id FROM connections WHERE org_id = $1${statusClause}`,
      [orgId],
    );
    for (const row of rows) {
      visible.add(row.id);
    }
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

// GET / — list connections scoped to active org
adminConnections.openapi(listConnectionsRoute, async (c) => runHandler(c, "list connections", async () => {
  const { orgId } = c.get("orgContext");
  const authResult = c.get("authResult");
  const isPlatformAdmin = authResult.user?.role === "platform_admin";
  const connList = connections.describe();
  const visible = await getVisibleConnectionIds(orgId, isPlatformAdmin, getAtlasMode(c));
  const filtered = visible ? connList.filter((conn) => visible.has(conn.id)) : connList;

  return c.json({ connections: filtered }, 200);
}));

// GET /pool — pool metrics scoped to active org
adminConnections.openapi(getPoolMetricsRoute, async (c) => runHandler(c, "get pool metrics", async () => {
  const { orgId } = c.get("orgContext");
  const authResult = c.get("authResult");
  const isPlatformAdmin = authResult.user?.role === "platform_admin";

  if (isPlatformAdmin) {
    const metrics = connections.getAllPoolMetrics();
    return c.json({ metrics }, 200);
  }

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
    return c.json({ error: "metrics_failed", message: err instanceof Error ? err.message : "Failed to retrieve metrics", requestId }, 500);
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
    return c.json(result, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), orgId: targetOrgId, requestId }, "Org pool drain failed");
    return c.json({ error: "drain_failed", message: err instanceof Error ? err.message : "Org drain failed", requestId }, 500);
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
    return c.json({ drained: true, message: result.message }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), connectionId: id, requestId }, "Pool drain failed");
    return c.json({ error: "drain_failed", message: err instanceof Error ? err.message : "Drain failed", requestId }, 500);
  }
}));

// POST /test — test a connection URL (transient, no org scoping needed)
adminConnections.openapi(testConnectionRoute, async (c) => runHandler(c, "test connection", async () => {
  const { requestId } = c.get("orgContext");

  const body = await c.req.json().catch((err: unknown) => {
    log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body in test connection request");
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
    return c.json({ error: "invalid_request", message: err instanceof Error ? err.message : "Unsupported database URL scheme.", requestId }, 400);
  }

  const tempId = `_test_${Date.now()}`;
  try {
    connections.register(tempId, {
      url,
      description: undefined,
      schema: typeof schema === "string" ? schema : undefined,
    });
    const result = await connections.healthCheck(tempId);
    return c.json({ status: result.status, latencyMs: result.latencyMs, dbType }, 200);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Connection test failed");
    return c.json({
      error: "connection_failed",
      message: `Connection test failed: ${err instanceof Error ? err.message : "Unknown error"}`,
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
  return c.json(result, 200);
}));

// POST / — create connection scoped to active org
adminConnections.openapi(createConnectionRoute, async (c) => runHandler(c, "create connection", async () => {
  const { requestId, orgId } = c.get("orgContext");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Connection management requires an internal database (DATABASE_URL).", requestId }, 404);
  }

  // Enforce plan connection limit before proceeding
  const connCountRows = await internalQuery<{ count: number }>(
    `SELECT COUNT(*)::int as count FROM connections WHERE org_id = $1`,
    [orgId],
  );
  const connCount = connCountRows[0]?.count ?? 0;
  const resourceCheck = await checkResourceLimit(orgId, "connections", connCount);
  if (!resourceCheck.allowed) {
    return c.json({ error: "plan_limit_exceeded", message: resourceCheck.errorMessage, requestId }, 429);
  }

  const body = await c.req.json().catch((err: unknown) => {
    log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body in create connection request");
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
    return c.json({ error: "invalid_request", message: err instanceof Error ? err.message : "Unsupported database URL scheme.", requestId }, 400);
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
    log.error({ err: err instanceof Error ? err.message : String(err), connectionId: id, requestId }, "Failed to check for existing connection row before create");
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
      message: `Connection test failed: ${err instanceof Error ? err.message : "Unknown error"}. Fix the URL and try again.`,
      requestId,
    }, 400);
  }

  // Encrypt and persist to internal DB with org_id
  let encryptedUrl: string;
  try {
    encryptedUrl = encryptUrl(url);
  } catch (err) {
    connections.unregister(id);
    log.error({ err: err instanceof Error ? err.message : String(err), connectionId: id, requestId }, "Failed to encrypt connection URL");
    return c.json({ error: "encryption_failed", message: "Failed to encrypt connection URL. Check ATLAS_ENCRYPTION_KEY or BETTER_AUTH_SECRET.", requestId }, 500);
  }

  // Mode-aware status: in developer mode, new connections are saved as drafts
  // so non-admin users don't see them until publish. In published mode, new
  // connections go live immediately (preserves existing single-mode behavior).
  const status = getAtlasMode(c) === "developer" ? "draft" : "published";

  try {
    if (revivingArchived) {
      // The archived row owns the PK — revive it in place so we preserve
      // audit/version history rather than stranding it.
      await internalQuery(
        `UPDATE connections SET url = $1, type = $2, description = $3, schema_name = $4, status = $5, updated_at = now() WHERE id = $6 AND org_id = $7`,
        [encryptedUrl, dbType, typeof description === "string" ? description : null, typeof schema === "string" ? schema : null, status, id, orgId],
      );
    } else {
      await internalQuery(
        `INSERT INTO connections (id, url, type, description, schema_name, org_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, encryptedUrl, dbType, typeof description === "string" ? description : null, typeof schema === "string" ? schema : null, orgId, status],
      );
    }
  } catch (err) {
    connections.unregister(id);
    log.error({ err: err instanceof Error ? err.message : String(err), connectionId: id, requestId }, "Failed to persist connection");
    return c.json({ error: "internal_error", message: "Failed to save connection.", requestId }, 500);
  }

  try {
    _resetWhitelists();
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to reset whitelists after connection create");
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

  // Demo content is read-only in published mode — admins must toggle to
  // developer mode to edit demo data.
  if (id === DEMO_CONNECTION_ID && getAtlasMode(c) !== "developer") {
    return c.json(demoReadonly(requestId), 403);
  }

  // Check it exists in the DB and belongs to this org
  const existing = await internalQuery<{ id: string; url: string; type: string; description: string | null; schema_name: string | null }>(
    `SELECT id, url, type, description, schema_name FROM connections WHERE id = $1 AND org_id = $2`,
    [id, orgId],
  );

  if (existing.length === 0) {
    return c.json({ error: "not_found", message: `Connection "${id}" not found or is not admin-managed.`, requestId }, 404);
  }

  const body = await c.req.json().catch((err: unknown) => {
    log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body in update connection request");
    return null;
  });

  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_request", message: "Request body is required.", requestId }, 400);
  }

  const { url, description, schema } = body as Record<string, unknown>;
  const current = existing[0];

  let currentUrl: string;
  try {
    currentUrl = decryptUrl(current.url);
  } catch (err) {
    log.error({ connectionId: id, requestId, err: err instanceof Error ? err.message : String(err) }, "Failed to decrypt stored connection URL");
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
      return c.json({ error: "invalid_request", message: err instanceof Error ? err.message : "Unsupported database URL scheme.", requestId }, 400);
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
        log.error({ connectionId: id, requestId, err: restoreErr instanceof Error ? restoreErr.message : String(restoreErr) }, "Failed to restore previous connection after update failure — connection unregistered");
        connections.unregister(id);
      }
      const baseMsg = `Connection test failed: ${err instanceof Error ? err.message : "Unknown error"}. Fix the URL and try again.`;
      if (rollbackFailed) {
        return c.json({ error: "internal_error", message: `${baseMsg} The connection may need a server restart to restore.`, requestId }, 500);
      }
      return c.json({ error: "connection_failed", message: baseMsg, requestId }, 400);
    }
  } else {
    try {
      connections.register(id, { url: newUrl, description: newDescription ?? undefined, schema: newSchema ?? undefined });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), connectionId: id, requestId }, "Failed to re-register connection with updated metadata");
      return c.json({ error: "internal_error", message: "Failed to update connection.", requestId }, 500);
    }
  }

  // Encrypt and update in DB — rollback registry on failure
  let encryptedNewUrl: string;
  try {
    encryptedNewUrl = encryptUrl(newUrl);
  } catch (err) {
    let rollbackFailed = false;
    try {
      connections.register(id, { url: currentUrl, description: current.description ?? undefined, schema: current.schema_name ?? undefined });
    } catch (restoreErr) {
      rollbackFailed = true;
      log.error({ connectionId: id, requestId, err: restoreErr instanceof Error ? restoreErr.message : String(restoreErr) }, "Failed to restore previous connection after encryption failure — connection unregistered");
      connections.unregister(id);
    }
    log.error({ err: err instanceof Error ? err.message : String(err), connectionId: id, requestId }, "Failed to encrypt connection URL");
    const encMsg = rollbackFailed
      ? "Failed to encrypt connection URL. Check ATLAS_ENCRYPTION_KEY or BETTER_AUTH_SECRET. The connection may need a server restart to restore."
      : "Failed to encrypt connection URL. Check ATLAS_ENCRYPTION_KEY or BETTER_AUTH_SECRET.";
    return c.json({ error: "encryption_failed", message: encMsg, requestId }, 500);
  }

  try {
    await internalQuery(
      `UPDATE connections SET url = $1, type = $2, description = $3, schema_name = $4, updated_at = NOW() WHERE id = $5 AND org_id = $6`,
      [encryptedNewUrl, dbType, newDescription, newSchema, id, orgId],
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
    log.error({ err: err instanceof Error ? err.message : String(err), connectionId: id, requestId }, "Failed to update connection in DB");
    const updateMsg = rollbackFailed
      ? "Failed to update connection. The connection may need a server restart to restore."
      : "Failed to update connection.";
    return c.json({ error: "internal_error", message: updateMsg, requestId }, 500);
  }

  try {
    _resetWhitelists();
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to reset whitelists after connection update");
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

  // Demo content is read-only in published mode — writes in published mode
  // against __demo__ must be blocked. Developer mode can archive the demo.
  if (id === DEMO_CONNECTION_ID && getAtlasMode(c) !== "developer") {
    return c.json(demoReadonly(requestId), 403);
  }

  // Must exist in the DB and belong to the org
  const existing = await internalQuery<{ id: string }>(
    `SELECT id FROM connections WHERE id = $1 AND org_id = $2`,
    [id, orgId],
  );

  if (existing.length === 0) {
    return c.json({ error: "not_found", message: `Connection "${id}" not found or is not admin-managed.`, requestId }, 404);
  }

  // Check for scheduled tasks referencing this connection
  try {
    const refs = await internalQuery<{ count: string }>(
      "SELECT COUNT(*) as count FROM scheduled_tasks WHERE connection_id = $1",
      [id],
    );
    const refCount = parseInt(String(refs[0]?.count ?? "0"), 10);
    if (refCount > 0) {
      return c.json({
        error: "conflict",
        message: `Cannot delete connection "${id}" — it is referenced by ${refCount} scheduled task(s). Remove or update those tasks first.`,
        requestId,
      }, 409);
    }
  } catch (err) {
    // Only ignore "relation does not exist" (42P01) — scheduled_tasks table may not exist yet
    const isTableMissing = err instanceof Error && "code" in err && (err as { code: string }).code === "42P01";
    if (!isTableMissing) {
      log.error({ err: err instanceof Error ? err.message : String(err), connectionId: id, requestId }, "Failed to check scheduled task references");
      return c.json({ error: "internal_error", message: "Failed to verify scheduled task references before deletion. Try again or contact your administrator.", requestId }, 500);
    }
    log.warn({ connectionId: id, requestId }, "Scheduled tasks table does not exist — skipping reference check");
  }

  // Archive instead of hard-delete so drafts can be restored and the
  // publish flow retains history. Cascades to entities is handled at publish time.
  try {
    await internalQuery(
      `UPDATE connections SET status = 'archived', updated_at = now() WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), connectionId: id, requestId }, "Failed to archive connection");
    return c.json({ error: "internal_error", message: "Failed to archive connection.", requestId }, 500);
  }

  try {
    connections.unregister(id);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), connectionId: id, requestId }, "Failed to unregister connection from in-memory registry — will reconcile on restart");
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
      const rows = await internalQuery<{ url: string; schema_name: string | null }>(
        "SELECT url, schema_name FROM connections WHERE id = $1 AND org_id = $2",
        [id, orgId],
      );
      if (rows.length > 0) {
        managed = true;
        schema = rows[0].schema_name;
        try {
          maskedUrl = maskConnectionUrl(decryptUrl(rows[0].url));
        } catch (decryptErr) {
          log.error({ connectionId: id, requestId, err: decryptErr instanceof Error ? decryptErr.message : String(decryptErr) }, "Failed to decrypt stored connection URL");
          maskedUrl = "[encrypted — decryption failed]";
        }
      }
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), connectionId: id, requestId }, "Failed to fetch connection details from internal DB");
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
