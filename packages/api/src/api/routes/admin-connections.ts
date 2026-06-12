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
import type { Context } from "hono";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { getConfig } from "@atlas/api/lib/config";
import { connections, detectDBType } from "@atlas/api/lib/db/connection";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { maskConnectionUrl } from "@atlas/api/lib/security";
import { _resetWhitelists } from "@atlas/api/lib/semantic";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { mapInstallError } from "@atlas/api/lib/effect/workspace-installer";
import { checkResourceLimit } from "@atlas/api/lib/billing/enforcement";
import { GROUP_NAME_PATTERN } from "@atlas/api/lib/db/connection-groups-helpers";
import {
  WorkspaceInstaller,
  WorkspaceInstallerLive,
  type WorkspaceInstallerShape,
  type InstallError,
} from "@atlas/api/lib/effect/workspace-installer";
import { decryptSecretFields, parseConfigSchema } from "@atlas/api/lib/plugins/secrets";
import type { WorkspaceId } from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext, requirePermission } from "./admin-router";
import { Cause, Effect } from "effect";
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
// WorkspaceInstaller bridge (#2744)
// ---------------------------------------------------------------------------

/**
 * Discriminated result for `runInstaller`. On error, the route renders
 * the body via `c.json(error.body, error.status)` — keeping `c.json` at
 * the call site preserves the OpenAPI router's `RouteConfigToTypedResponse`
 * narrowing (Hono refuses to widen a plain `Response` returned from a
 * helper).
 *
 * `error` + `message` are required so OpenAPI route inference matches
 * the response schemas; extra tag-specific fields from `mapInstallError`'s
 * `body` (e.g. `fieldErrors`, `reason`, `pillar`) ride on the index
 * signature.
 */
interface InstallerErrorBody {
  readonly error: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

type InstallerResult<A> =
  | { readonly kind: "ok"; readonly value: A }
  | {
      readonly kind: "error";
      readonly status: 400 | 404 | 409;
      readonly body: InstallerErrorBody;
    };

/**
 * Run a `WorkspaceInstaller`-using Effect from inside an async Hono
 * handler. Provides the live installer Layer and maps tagged installer
 * errors into a route-renderable `{ status, body }` pair via
 * {@link mapInstallError}.
 *
 * `mapInstallError` is an exhaustive `switch (error._tag)` — adding a new
 * `InstallError` variant fails at compile time inside `mapInstallError`
 * (not via a runtime "unknown status" log line here). The result type
 * narrows `status` to `400 | 404 | 409` directly so `c.json(body, status)`
 * matches the OpenAPI route schema without a `ContentfulStatusCode` cast.
 *
 * Defects (non-tagged Effect failures) re-throw so `runHandler`'s outer
 * try/catch produces a 500 with a request ID — same posture as a thrown
 * Error in a normal async handler.
 *
 * Avoids the bigger refactor that would convert each `admin-connections`
 * handler into a top-to-bottom Effect program (the pattern
 * `admin-integrations.ts` uses). The route is mostly imperative — keeping
 * the bridge narrow lets the legacy test-connect / audit / billing
 * dances stay in place.
 */
async function runInstaller<A>(
  _c: Context,
  body: (installer: WorkspaceInstallerShape) => Effect.Effect<A, InstallError>,
): Promise<InstallerResult<A>> {
  const program = Effect.gen(function* () {
    const installer = yield* WorkspaceInstaller;
    return yield* body(installer);
  });

  const exit = await Effect.runPromiseExit(
    program.pipe(Effect.provide(WorkspaceInstallerLive)),
  );

  if (exit._tag === "Success") return { kind: "ok", value: exit.value };

  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") {
    const mapping = mapInstallError(failure.value);
    return {
      kind: "error",
      status: mapping.status,
      body: {
        error: mapping.code,
        message: mapping.message,
        ...(mapping.body ?? {}),
      },
    };
  }
  // Defect — let runHandler's outer catch surface it as a 500 with
  // the standard requestId envelope. Throw with the raw Cause so the
  // stack trace makes it into pino's error log.
  throw new Error(`WorkspaceInstaller program died: ${Cause.pretty(exit.cause)}`);
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
 * own in `connections` AND the deployment is not SaaS. On SaaS every
 * onboarded org owns either `__demo__` or a wizard-created connection that
 * aliases the same physical DB as `default`, so seeding `default`
 * unconditionally produced a phantom duplicate in the Connections list and
 * the Semantic page connection picker. The SaaS gate further protects any
 * SaaS workspace whose `connections` rowset is empty (#2483) — without it,
 * the shared `ATLAS_DATASOURCE_URL` service rendered as "their default
 * Atlas connection," a single-tenant lazy-registration leaking into
 * multi-tenant. Self-hosted single-tenant deployments still see `default`
 * because they have no `connections` rows at all.
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
    // Content-mode filter — `readFilter("connections", …)` resolves
    // through CONTENT_MODE_TABLES, which post-#2744 points the
    // `connections` segment key at the `workspace_plugins` physical
    // table. Alias `wp` matches the FROM clause below.
    const statusClause = Effect.runSync(
      contentModeRegistry.readFilter("connections", mode ?? "published", "wp"),
    );
    // Migration 0094 backfilled a per-workspace `demo-postgres` install
    // for every organization (`install_id='__demo__'`). The old
    // `__global__` → per-org tombstone overlay is gone — each
    // workspace owns its demo row outright, archiving hides it
    // locally, so a flat WHERE clause replaces the prior UNION + NOT
    // EXISTS pattern. `install_id` is the post-cutover user-facing
    // identifier the admin UI calls "connection id".
    const rows = await internalQuery<{ install_id: string }>(
      `SELECT DISTINCT wp.install_id
         FROM workspace_plugins wp
        WHERE wp.workspace_id = $1
          AND wp.pillar = 'datasource'
          AND ${statusClause}
        ORDER BY 1`,
      [orgId],
    );
    for (const row of rows) {
      visible.add(row.install_id);
    }
  }

  // SaaS gate: on SaaS the `default` registration is the shared demo service
  // from `ATLAS_DATASOURCE_URL`, not a per-org connection, so never auto-
  // surface it (#2483).
  const isSaas = getConfig()?.deployMode === "saas";
  if (visible.size === 0 && connections.has("default") && !isSaas) {
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
    429: { description: "Rate limit exceeded, or plan connection limit reached: `plan_limit_exceeded`", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    // The plan-limit count couldn't be verified (infra fault) — fail-closed
    // with a transient "try again", not an upgrade prompt (#3433).
    503: { description: "Billing/plan-limit check unavailable: `billing_check_failed`", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateConnectionRoute = createRoute({
  method: "put",
  path: "/{id}",
  tags: ["Admin — Connections"],
  summary: "Update connection",
  description: "Updates an existing connection's URL, description, schema, or environment attachment. Scoped to active organization.",
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
    404: { description: "Connection or environment not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Environment name already in use, or target environment is archived", content: { "application/json": { schema: ErrorSchema } } },
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
    // #2744 — installer can surface an `InvalidInstallIdError` (400) on
    // future tag widenings; documented here so the OpenAPI schema stays
    // in lockstep with the typed status union from `runInstaller`.
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
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

  // Decorate with `group_id` from `workspace_plugins.config`. Per
  // ADR-0007 the `connection_groups` table is gone; named groups
  // collapse into the per-row JSONB key `config->>'group_id'`. The
  // wire still carries both `groupId` and `groupName` for backwards
  // compatibility with the admin UI — post-cutover `groupName` mirrors
  // `groupId` verbatim (a string IS a name now). When the web page
  // drops the group_name column (#2744 step 4), this can collapse.
  //
  // Presence in `groupInfoByConnection` doubles as the `billable` signal
  // (#2490): the SELECT matches the billing counter exactly (the same
  // workspace_plugins WHERE clause used to enforce the plan limit on
  // POST). The lazy `default` fallback and any future runtime-only
  // registration are visible to the user but absent from the DB, so
  // they correctly report `billable: false`. Archived rows are filtered
  // upstream by `getVisibleConnectionIds`'s content-mode read filter so
  // we don't need to repeat the `status != 'archived'` check here.
  let groupInfoByConnection = new Map<string, { groupId: string | null; groupName: string | null }>();
  if (hasInternalDB() && filtered.length > 0) {
    const ids = filtered.map((c) => c.id);
    const rows = await internalQuery<{ install_id: string; group_id: string | null }>(
      `SELECT wp.install_id, wp.config->>'group_id' AS group_id
         FROM workspace_plugins wp
        WHERE wp.workspace_id = $1
          AND wp.pillar = 'datasource'
          AND wp.install_id = ANY($2::text[])`,
      [orgId, ids],
    );
    groupInfoByConnection = new Map(
      rows.map((r) => [
        r.install_id,
        {
          groupId: r.group_id,
          // Wire-shape preservation: groupName mirrors groupId per the
          // locked decision; the `connection_groups.name` join is gone.
          groupName: r.group_id,
        },
      ]),
    );
  }

  const decorated = filtered.map((c) => {
    const info = groupInfoByConnection.get(c.id);
    return {
      ...c,
      groupId: info?.groupId ?? null,
      groupName: info?.groupName ?? null,
      billable: groupInfoByConnection.has(c.id),
    };
  });

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

  // Enforce plan connection limit before proceeding. Post-#2744 the
  // counter scans `workspace_plugins WHERE pillar = 'datasource' AND
  // status != 'archived'` — exclude archived rows so a workspace
  // hiding the demo doesn't lose a billable slot for it.
  const connCountRows = await internalQuery<{ count: number }>(
    `SELECT COUNT(*)::int as count
       FROM workspace_plugins
      WHERE workspace_id = $1
        AND pillar = 'datasource'
        AND status != 'archived'`,
    [orgId],
  );
  const connCount = connCountRows[0]?.count ?? 0;
  const resourceCheck = await checkResourceLimit(orgId, "connections", connCount);
  if (!resourceCheck.allowed) {
    // ResourceLimitResult error-arm contract (#3433): `check_failed` means
    // the count couldn't be verified (infra fault) — still fail-closed, but
    // surface 503 "try again", never a misleading 429 "upgrade your plan".
    if (resourceCheck.reason === "check_failed") {
      return c.json({ error: "billing_check_failed", message: resourceCheck.errorMessage, requestId }, 503);
    }
    return c.json({ error: "plan_limit_exceeded", message: resourceCheck.errorMessage, requestId }, 429);
  }

  const body = await c.req.json().catch((err: unknown) => {
    log.warn({ err: errorMessage(err), requestId }, "Failed to parse JSON body in create connection request");
    return null;
  });

  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_request", message: "Request body is required.", requestId }, 400);
  }

  const { id, url, description, schema, connectionGroupId, newGroupName } = body as Record<string, unknown>;

  // installId / dbType / url shape validation. The installer also
  // validates installId, but we pre-check so we can return the legacy
  // copy. `default` is intercepted here for the same reason — the
  // installer's reserved-error message is generic ("pick a different
  // name"); the legacy 400 explicitly points the admin at ATLAS_DATASOURCE_URL.
  if (!id || typeof id !== "string" || !/^[a-z][a-z0-9_-]*$/.test(id)) {
    return c.json({ error: "invalid_request", message: "Connection ID must be lowercase alphanumeric with hyphens/underscores (e.g. 'warehouse').", requestId }, 400);
  }
  if (id === "default") {
    return c.json({ error: "invalid_request", message: "Cannot create a connection with ID 'default'. The default connection is managed via ATLAS_DATASOURCE_URL.", requestId }, 400);
  }
  if (!url || typeof url !== "string") {
    return c.json({ error: "invalid_request", message: "Connection URL is required.", requestId }, 400);
  }

  // Both group fields together is invalid_request — the dialog enforces
  // exclusivity client-side but a direct API caller could send both.
  // `newGroupName` is accepted verbatim into `config.group_id` per the
  // locked decision (#2744) — the `connection_groups` table is gone, so
  // a "name" and an "id" are the same string now. We still pattern-validate
  // newGroupName so admin clients see a 400 instead of an opaque
  // ConfigSchemaError when they pass control characters.
  if (connectionGroupId !== undefined && newGroupName !== undefined) {
    return c.json(
      {
        error: "invalid_request",
        message: "Pass either connectionGroupId (attach existing) or newGroupName (create inline), not both.",
        requestId,
      },
      400,
    );
  }
  if (connectionGroupId !== undefined && typeof connectionGroupId !== "string") {
    return c.json({ error: "invalid_request", message: "connectionGroupId must be a string when provided.", requestId }, 400);
  }
  let resolvedGroupId: string | null = null;
  if (typeof connectionGroupId === "string") {
    resolvedGroupId = connectionGroupId;
  } else if (newGroupName !== undefined) {
    if (typeof newGroupName !== "string" || !GROUP_NAME_PATTERN.test(newGroupName.trim())) {
      return c.json(
        {
          error: "invalid_request",
          message: "newGroupName must start with a letter or digit and may contain letters, digits, spaces, hyphens, or underscores (max 64 chars).",
          requestId,
        },
        400,
      );
    }
    resolvedGroupId = newGroupName.trim();
  }

  // Cross-org connectionGroupId validation: scan workspace_plugins for
  // any row in this workspace whose config.group_id matches. The
  // `connection_groups` archived check is gone — a group is now just a
  // string referenced by N install rows, so "the group exists" means
  // "at least one install in this workspace claims that group_id".
  // Skipped on newGroupName (which is allowed to introduce a new group).
  if (typeof connectionGroupId === "string") {
    const groupRows = await internalQuery<{ install_id: string }>(
      `SELECT install_id FROM workspace_plugins
        WHERE workspace_id = $1 AND pillar = 'datasource'
          AND config->>'group_id' = $2
        LIMIT 1`,
      [orgId, connectionGroupId],
    );
    if (groupRows.length === 0) {
      return c.json({ error: "not_found", message: `Environment "${connectionGroupId}" not found.`, requestId }, 404);
    }
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

  // Archive-aware conflict check: an admin who soft-deleted a connection
  // can re-create it under the same install_id and we revive in place to
  // preserve audit history. Any other status (published/draft) is a real
  // conflict.
  const existingRow = await internalQuery<{ status: string }>(
    `SELECT status FROM workspace_plugins
      WHERE workspace_id = $1 AND pillar = 'datasource' AND install_id = $2
      LIMIT 1`,
    [orgId, id],
  );
  if (existingRow.length > 0 && existingRow[0].status !== "archived") {
    return c.json({ error: "conflict", message: `Connection "${id}" already exists.`, requestId }, 409);
  }
  const revivingArchived = existingRow.length > 0;

  // Test-connect dance is route-owned per ADR-0007 (installer trusts
  // the caller has validated reachability). Register then healthCheck
  // produces a clear `connection_failed` 400 with the upstream error,
  // and rollback unregisters so a failed test never leaves a phantom
  // pool behind.
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

  // `encryptSecretFields` will encrypt the `url` field at the installer
  // boundary per the catalog's config_schema (where `secret: true`).
  const formData: Record<string, unknown> = {
    url,
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof schema === "string" && schema.length > 0 ? { schema } : {}),
  };

  // Admin POSTs always land on the bare `dbType` catalog row; the
  // `demo-postgres` slug is reserved for the migration backfill.
  const catalogSlug = dbType;

  try {
    if (revivingArchived) {
      // Reviving an archived row: route through updateDatasourceConfig
      // (the installer rejects installDatasource on existing row with
      // 409). atlasMode='draft' so the revived row carries status='draft'
      // matching legacy behaviour (#2177).
      const result = await runInstaller(
        c,
        (installer) =>
          installer.updateDatasourceConfig(
            orgId as WorkspaceId,
            catalogSlug,
            id,
            {
              partialConfig: formData,
              groupId: resolvedGroupId,
              status: "draft",
              atlasMode: "draft",
            },
          ),
      );
      if (result.kind === "error") {
        // Reviving an archived row: the pool already existed from the
        // pre-archive era; the test-connect dance above re-registered it
        // against the same URL the user just supplied. Leave it in place
        // so the next list/agent query sees a live pool matching the
        // (still-archived) DB row.
        return c.json({ ...result.body, requestId }, result.status);
      }
    } else {
      const result = await runInstaller(
        c,
        (installer) =>
          installer.installDatasource(
            orgId as WorkspaceId,
            catalogSlug,
            {
              installId: id,
              formData,
              groupId: resolvedGroupId,
              // All new connections always stamp `status = 'draft'`
              // regardless of the caller's atlasMode (#2177). The
              // pending-changes pill surfaces the draft count and the
              // admin publishes atomically.
              atlasMode: "draft",
            },
          ),
      );
      if (result.kind === "error") {
        // Installer returned a typed error (e.g. ConfigSchemaError,
        // CatalogNotFoundError, AlreadyInstalledError from a race). The
        // pre-install test-connect dance above already registered a live
        // pool against the user-supplied URL — leaving it would produce
        // a phantom 409 on retry from `connections.has(id)` and would
        // also hand future code paths a pool with no DB row. Tear it
        // down before returning.
        try {
          connections.unregister(id);
        } catch (cleanupErr) {
          log.error(
            { err: errorMessage(cleanupErr), connectionId: id, requestId },
            "Failed to unregister pre-registered pool after installer error — pool may need a server restart to clear",
          );
        }
        return c.json({ ...result.body, requestId }, result.status);
      }
    }
  } catch (err) {
    connections.unregister(id);
    log.error({ err: errorMessage(err), connectionId: id, requestId }, "Failed to persist connection via WorkspaceInstaller");
    return c.json({ error: "internal_error", message: "Failed to save connection.", requestId }, 500);
  }

  try {
    _resetWhitelists();
  } catch (err) {
    log.warn({ err: errorMessage(err), requestId }, "Failed to reset whitelists after connection create");
  }

  log.info({ requestId, connectionId: id, dbType, orgId, groupId: resolvedGroupId, actorId: authResult.user?.id }, "Connection created");

  // Audit metadata stays in lockstep with wizard.ts to preserve the
  // F-34 #1789 parity invariant (admin-wizard-save-audit.test.ts is the
  // gate). Compliance queries filter on this exact key set regardless
  // of entry path. groupId rides on the structured log + response, not
  // on the audit row.
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
    groupId: resolvedGroupId,
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

  // Load the existing row from workspace_plugins. Need the catalog slug
  // (for the installer call), the JOIN to plugin_catalog for config_schema
  // (for in-place decrypt), and the current config (for legacy
  // url-changed detection). Excludes archived rows so soft-deleted
  // installs read as "not found" rather than blank-decrypt 500s.
  const existing = await internalQuery<{
    catalog_slug: string;
    config: Record<string, unknown> | null;
    config_schema: unknown;
    group_id: string | null;
  }>(
    `SELECT pc.slug AS catalog_slug,
            wp.config,
            pc.config_schema,
            wp.config->>'group_id' AS group_id
       FROM workspace_plugins wp
       JOIN plugin_catalog pc ON pc.id = wp.catalog_id
      WHERE wp.workspace_id = $1
        AND wp.install_id = $2
        AND wp.pillar = 'datasource'
        AND wp.status != 'archived'
      LIMIT 1`,
    [orgId, id],
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

  const { url, description, schema, connectionGroupId, newGroupName } = body as Record<string, unknown>;
  const current = existing[0];

  // Symmetric to POST: connectionGroupId string attaches, null clears
  // the group binding, newGroupName creates inline (now just a string
  // written into config.group_id per the locked decision). Both fields = 400.
  if (connectionGroupId !== undefined && newGroupName !== undefined) {
    return c.json(
      {
        error: "invalid_request",
        message: "Pass either connectionGroupId (attach existing) or newGroupName (create inline), not both.",
        requestId,
      },
      400,
    );
  }
  if (connectionGroupId !== undefined && connectionGroupId !== null && typeof connectionGroupId !== "string") {
    return c.json({ error: "invalid_request", message: "connectionGroupId must be a string or null when provided.", requestId }, 400);
  }
  // groupIdPatch carries the desired group_id for the installer:
  //   - undefined: no change
  //   - null: clear group_id (DELETE the JSONB key)
  //   - string: set group_id verbatim
  let groupIdPatch: string | null | undefined = undefined;
  if (typeof connectionGroupId === "string") {
    groupIdPatch = connectionGroupId;
  } else if (connectionGroupId === null) {
    groupIdPatch = null;
  } else if (newGroupName !== undefined) {
    if (typeof newGroupName !== "string" || !GROUP_NAME_PATTERN.test(newGroupName.trim())) {
      return c.json(
        {
          error: "invalid_request",
          message: "newGroupName must start with a letter or digit and may contain letters, digits, spaces, hyphens, or underscores (max 64 chars).",
          requestId,
        },
        400,
      );
    }
    groupIdPatch = newGroupName.trim();
  }

  // Cross-org connectionGroupId validation: at least one other
  // workspace_plugins row in this workspace must claim that group_id.
  // The legacy "archived group rejects attach" check is gone (no
  // separate group state to be archived).
  if (typeof connectionGroupId === "string") {
    const groupRows = await internalQuery<{ install_id: string }>(
      `SELECT install_id FROM workspace_plugins
        WHERE workspace_id = $1 AND pillar = 'datasource'
          AND config->>'group_id' = $2
        LIMIT 1`,
      [orgId, connectionGroupId],
    );
    if (groupRows.length === 0) {
      return c.json({ error: "not_found", message: `Environment "${connectionGroupId}" not found.`, requestId }, 404);
    }
  }

  // Decrypt the stored URL so we can detect URL changes and roll the
  // pool back on test-connect failure. `decryptSecretFields` walks the
  // catalog's `config_schema` to find `secret: true` keys (i.e. `url`)
  // and unwraps each — the rest of config passes through.
  let currentUrl: string;
  let currentDescription: string | null;
  let currentSchema: string | null;
  try {
    const schemaSpec = parseConfigSchema(current.config_schema);
    const decrypted = decryptSecretFields(current.config ?? {}, schemaSpec);
    currentUrl = typeof decrypted.url === "string" ? decrypted.url : "";
    currentDescription =
      typeof decrypted.description === "string" && decrypted.description.length > 0
        ? decrypted.description
        : null;
    currentSchema =
      typeof decrypted.schema === "string" && decrypted.schema.length > 0
        ? decrypted.schema
        : null;
    if (!currentUrl) {
      throw new Error("workspace_plugins.config.url missing or empty");
    }
  } catch (err) {
    log.error({ connectionId: id, requestId, err: errorMessage(err) }, "Failed to decrypt stored connection URL");
    return c.json({ error: "decryption_failed", message: "Stored connection URL could not be decrypted. The encryption key may have changed.", requestId }, 500);
  }

  const newUrl = typeof url === "string" ? url : currentUrl;
  const newDescription = typeof description === "string" ? description : currentDescription;
  const newSchema = typeof schema === "string" ? (schema || null) : currentSchema;
  const urlChanged = typeof url === "string" && url !== currentUrl;

  // dbType for the response — derived from the catalog slug since that's
  // the source of truth post-cutover. For URL changes we re-detect to
  // validate the new URL's shape before the test-connect dance.
  let dbType = current.catalog_slug;
  if (urlChanged) {
    try {
      dbType = detectDBType(newUrl);
    } catch (err) {
      return c.json({ error: "invalid_request", message: errorMessage(err), requestId }, 400);
    }
  }

  // Re-test if URL changed. Test-connect dance is route-owned per
  // ADR-0007 — the installer trusts the caller's reachability check.
  if (urlChanged) {
    try {
      connections.register(id, { url: newUrl, description: newDescription ?? undefined, schema: newSchema ?? undefined });
      await connections.healthCheck(id);
    } catch (err) {
      let rollbackFailed = false;
      try {
        connections.register(id, { url: currentUrl, description: currentDescription ?? undefined, schema: currentSchema ?? undefined });
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

  // Build the partial config for the installer. Only include fields the
  // caller actually patched — the installer merges onto the existing
  // decrypted config so omitted fields stay put.
  const partialConfig: Record<string, unknown> = {};
  if (typeof url === "string") partialConfig.url = url;
  if (typeof description === "string") partialConfig.description = description;
  if (typeof schema === "string") {
    // Empty string clears the schema; non-empty sets it.
    partialConfig.schema = schema || null;
  }

  // Resolved group_id for the response — derive from patch intent vs
  // existing value so the wire shape is accurate without a re-fetch.
  const resolvedGroupId =
    groupIdPatch === undefined
      ? current.group_id
      : groupIdPatch;

  const result = await runInstaller(
    c,
    (installer) =>
      installer.updateDatasourceConfig(
        orgId as WorkspaceId,
        current.catalog_slug,
        id,
        {
          ...(Object.keys(partialConfig).length > 0 ? { partialConfig } : {}),
          ...(groupIdPatch !== undefined ? { groupId: groupIdPatch } : {}),
          // atlasMode='draft' so any config change downgrades status to
          // draft, matching the pre-cutover "every edit drafts" rule
          // documented in #2177.
          atlasMode: "draft",
        },
      ),
  );
  if (result.kind === "error") {
    // Rollback the registry to the pre-update URL — the DB write didn't
    // land so the live pool shouldn't reflect the attempted change.
    let rollbackFailed = false;
    try {
      connections.register(id, { url: currentUrl, description: currentDescription ?? undefined, schema: currentSchema ?? undefined });
    } catch (restoreErr) {
      rollbackFailed = true;
      log.error({ connectionId: id, requestId, err: errorMessage(restoreErr) }, "Failed to restore previous connection after installer error — connection unregistered");
      connections.unregister(id);
    }
    if (rollbackFailed) {
      // Rollback failed AND the installer rejected the change: the in-memory
      // registry is now empty for this id, agent queries will fail until
      // restart. Escalate to 500 so the caller knows the state is degraded
      // — surfacing the original 4xx alone would let the admin think they
      // just need to fix their input.
      log.error({ connectionId: id, requestId }, "Installer error + rollback failure — registry is empty, surface as 500 to caller");
      return c.json(
        {
          error: "internal_error",
          message: `${result.body.message ?? "Connection update failed"} — the previous connection could not be restored either. The connection may need a server restart.`,
          requestId,
        },
        500,
      );
    }
    return c.json({ ...result.body, requestId }, result.status);
  }

  try {
    _resetWhitelists();
  } catch (err) {
    log.warn({ err: errorMessage(err), requestId }, "Failed to reset whitelists after connection update");
  }

  const groupChanged = resolvedGroupId !== current.group_id;
  log.info({ requestId, connectionId: id, urlChanged, groupChanged, groupId: resolvedGroupId, actorId: authResult.user?.id }, "Connection updated");

  // Audit metadata keeps the pre-#2484 `{ name, urlChanged }` shape —
  // env reassignment surfaces in the structured log + response, not on
  // the audit row, so the existing compliance-query schema stays
  // stable. A future PR can add an `env_reassign` action type if env
  // attestation needs its own audit signal.
  logAdminAction({
    actionType: ADMIN_ACTIONS.connection.update,
    targetType: "connection",
    targetId: id,
    ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    metadata: { name: id, urlChanged },
  });

  return c.json({ id, dbType, description: newDescription, maskedUrl: maskConnectionUrl(newUrl), groupId: resolvedGroupId }, 200);
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

  // Look up the install row and resolve its catalog slug so the
  // installer can route the uninstall. Post-#2744 every workspace owns
  // its own demo row — there's no `__global__` shared install to shadow
  // anymore, so the legacy global/own branching collapses into one
  // simple lookup.
  const existing = await internalQuery<{ catalog_slug: string }>(
    `SELECT pc.slug AS catalog_slug
       FROM workspace_plugins wp
       JOIN plugin_catalog pc ON pc.id = wp.catalog_id
      WHERE wp.workspace_id = $1
        AND wp.install_id = $2
        AND wp.pillar = 'datasource'
      LIMIT 1`,
    [orgId, id],
  );

  if (existing.length === 0) {
    return c.json({ error: "not_found", message: `Connection "${id}" not found or is not admin-managed.`, requestId }, 404);
  }

  // Scheduled-task reference check: refuse delete when any scheduled_task
  // points at a group_id this install belongs to. The catch below carves
  // out PostgreSQL SQLSTATE 42P01 (relation does not exist) — see comment
  // at the catch site.
  try {
    const groupRefs = await internalQuery<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM scheduled_tasks st
        WHERE st.org_id = $1
          AND st.connection_group_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM workspace_plugins wp
             WHERE wp.workspace_id = $1
               AND wp.install_id = $2
               AND wp.pillar = 'datasource'
               AND wp.config->>'group_id' = st.connection_group_id
          )`,
      [orgId, id],
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

  // Soft archive via the installer — the pool is unregistered as part of
  // the operation so live queries against the archived install
  // fail-closed immediately.
  const result = await runInstaller(
    c,
    (installer) =>
      installer.uninstallDatasource(
        orgId as WorkspaceId,
        existing[0].catalog_slug,
        id,
      ),
  );
  if (result.kind === "error") return c.json({ ...result.body, requestId }, result.status);

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

  // If admin-managed, include masked URL and schema from DB. Post-#2744
  // the row lives in workspace_plugins with the URL inside `config`
  // JSONB (selective-field encrypted per the catalog's config_schema).
  // groupName mirrors groupId per the locked decision — connection_groups
  // is gone.
  let maskedUrl: string | null = null;
  let schema: string | null = null;
  let managed = false;
  let groupId: string | null = null;
  let groupName: string | null = null;
  if (hasInternalDB()) {
    try {
      const rows = await internalQuery<{
        config: Record<string, unknown> | null;
        config_schema: unknown;
        group_id: string | null;
      }>(
        `SELECT wp.config, pc.config_schema, wp.config->>'group_id' AS group_id
           FROM workspace_plugins wp
           JOIN plugin_catalog pc ON pc.id = wp.catalog_id
          WHERE wp.workspace_id = $1
            AND wp.install_id = $2
            AND wp.pillar = 'datasource'
            AND wp.status != 'archived'
          LIMIT 1`,
        [orgId, id],
      );
      if (rows.length > 0) {
        managed = true;
        groupId = rows[0].group_id;
        groupName = rows[0].group_id;
        try {
          const schemaSpec = parseConfigSchema(rows[0].config_schema);
          const decrypted = decryptSecretFields(rows[0].config ?? {}, schemaSpec);
          schema =
            typeof decrypted.schema === "string" && decrypted.schema.length > 0
              ? decrypted.schema
              : null;
          maskedUrl =
            typeof decrypted.url === "string" && decrypted.url.length > 0
              ? maskConnectionUrl(decrypted.url)
              : null;
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
    groupId,
    groupName,
  }, 200);
}));

export { adminConnections };
