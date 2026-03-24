/**
 * Platform admin routes — cross-tenant management for operators.
 *
 * Mounted at /api/v1/platform. All routes require `platform_admin` user role
 * (via Better Auth's admin plugin). This is separate from workspace-scoped
 * admin routes in admin.ts.
 *
 * Provides:
 * - GET    /workspaces          — list all workspaces with health/usage
 * - GET    /workspaces/:id      — detailed workspace view
 * - POST   /workspaces/:id/suspend   — suspend a workspace
 * - POST   /workspaces/:id/unsuspend — reactivate a workspace
 * - DELETE /workspaces/:id      — delete with cascading cleanup
 * - PATCH  /workspaces/:id/plan — change plan tier
 * - GET    /stats               — aggregate platform stats
 * - GET    /noisy-neighbors     — workspaces consuming disproportionate resources
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import { createLogger } from "@atlas/api/lib/logger";
import {
  hasInternalDB,
  internalQuery,
  getWorkspaceDetails,
  updateWorkspaceStatus,
  updateWorkspacePlanTier,
  cascadeWorkspaceDelete,
  type WorkspaceRow,
  type PlanTier,
  type WorkspaceStatus,
} from "@atlas/api/lib/db/internal";
import {
  WORKSPACE_STATUSES,
  PLAN_TIERS,
  NOISY_NEIGHBOR_METRICS,
  type PlatformWorkspace,
} from "@useatlas/types";
import { ATLAS_ROLES, type AtlasRole } from "@atlas/api/lib/auth/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { platformAdminAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("platform-admin");

const VALID_PLAN_TIERS = new Set<string>(PLAN_TIERS);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PlatformWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.enum(WORKSPACE_STATUSES),
  planTier: z.enum(PLAN_TIERS),
  byot: z.boolean(),
  members: z.number(),
  conversations: z.number(),
  queriesLast24h: z.number(),
  connections: z.number(),
  scheduledTasks: z.number(),
  stripeCustomerId: z.string().nullable(),
  trialEndsAt: z.string().nullable(),
  suspendedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  region: z.string().nullable(),
  regionAssignedAt: z.string().nullable(),
  createdAt: z.string(),
});

const PlatformWorkspaceUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(ATLAS_ROLES),
  createdAt: z.string(),
});

const PlatformStatsSchema = z.object({
  totalWorkspaces: z.number(),
  activeWorkspaces: z.number(),
  suspendedWorkspaces: z.number(),
  totalUsers: z.number(),
  totalQueries24h: z.number(),
  mrr: z.number(),
});

const NoisyNeighborSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  planTier: z.enum(PLAN_TIERS),
  metric: z.enum(NOISY_NEIGHBOR_METRICS),
  value: z.number(),
  median: z.number(),
  ratio: z.number(),
});

const ChangePlanBodySchema = z.object({
  planTier: z.enum(PLAN_TIERS).openapi({
    description: "The new plan tier for the workspace.",
    example: "team",
  }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listWorkspacesRoute = createRoute({
  method: "get",
  path: "/workspaces",
  tags: ["Platform Admin"],
  summary: "List all workspaces",
  description: "SaaS only. Returns all workspaces across the platform with health metrics, usage data, plan info, and status.",
  responses: {
    200: {
      description: "Workspaces list",
      content: { "application/json": { schema: z.object({ workspaces: z.array(PlatformWorkspaceSchema) }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getWorkspaceRoute = createRoute({
  method: "get",
  path: "/workspaces/:id",
  tags: ["Platform Admin"],
  summary: "Get workspace details",
  description: "SaaS only. Returns detailed workspace information including resource breakdown and user list.",
  responses: {
    200: {
      description: "Workspace detail",
      content: {
        "application/json": {
          schema: z.object({
            workspace: PlatformWorkspaceSchema,
            users: z.array(PlatformWorkspaceUserSchema),
          }),
        },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Workspace not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const suspendWorkspaceRoute = createRoute({
  method: "post",
  path: "/workspaces/:id/suspend",
  tags: ["Platform Admin"],
  summary: "Suspend a workspace",
  description: "SaaS only. Suspends a workspace, preventing all user access until reactivated.",
  responses: {
    200: {
      description: "Workspace suspended",
      content: { "application/json": { schema: z.object({ message: z.string(), workspaceId: z.string() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Workspace not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Workspace already suspended", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const unsuspendWorkspaceRoute = createRoute({
  method: "post",
  path: "/workspaces/:id/unsuspend",
  tags: ["Platform Admin"],
  summary: "Unsuspend a workspace",
  description: "SaaS only. Reactivates a suspended workspace, restoring user access.",
  responses: {
    200: {
      description: "Workspace reactivated",
      content: { "application/json": { schema: z.object({ message: z.string(), workspaceId: z.string() }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Workspace not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Workspace not suspended", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteWorkspaceRoute = createRoute({
  method: "delete",
  path: "/workspaces/:id",
  tags: ["Platform Admin"],
  summary: "Delete a workspace",
  description: "SaaS only. Soft-deletes a workspace with cascading cleanup (conversations, semantic entities, learned patterns, suggestions, scheduled tasks).",
  responses: {
    200: {
      description: "Workspace deleted",
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
            workspaceId: z.string(),
            cleanup: z.object({
              conversations: z.number(),
              semanticEntities: z.number(),
              learnedPatterns: z.number(),
              suggestions: z.number(),
              scheduledTasks: z.number(),
            }),
          }),
        },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Workspace not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Workspace already deleted", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const changePlanRoute = createRoute({
  method: "patch",
  path: "/workspaces/:id/plan",
  tags: ["Platform Admin"],
  summary: "Change workspace plan tier",
  description: "SaaS only. Updates the plan tier for a workspace (free, trial, team, enterprise).",
  request: { body: { required: true, content: { "application/json": { schema: ChangePlanBodySchema } } } },
  responses: {
    200: {
      description: "Plan updated",
      content: { "application/json": { schema: z.object({ message: z.string(), workspaceId: z.string(), planTier: z.string() }) } },
    },
    400: { description: "Invalid plan tier", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Workspace not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const platformStatsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Platform Admin"],
  summary: "Aggregate platform stats",
  description: "SaaS only. Returns aggregate platform statistics: total workspaces, active users, total queries, MRR.",
  responses: {
    200: {
      description: "Platform statistics",
      content: { "application/json": { schema: PlatformStatsSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const noisyNeighborsRoute = createRoute({
  method: "get",
  path: "/noisy-neighbors",
  tags: ["Platform Admin"],
  summary: "Detect noisy neighbors",
  description: "SaaS only. Identifies workspaces consuming disproportionate resources (>3x median queries, tokens, or storage).",
  responses: {
    200: {
      description: "Noisy neighbors list",
      content: { "application/json": { schema: z.object({ neighbors: z.array(NoisyNeighborSchema), medians: z.object({ queries: z.number(), tokens: z.number(), storage: z.number() }) }) } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a PlatformWorkspace from a WorkspaceRow + health counts. */
function toWorkspaceResponse(
  row: WorkspaceRow,
  health: { members: number; conversations: number; queriesLast24h: number; connections: number; scheduledTasks: number },
): PlatformWorkspace {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.workspace_status,
    planTier: row.plan_tier,
    byot: row.byot,
    members: health.members,
    conversations: health.conversations,
    queriesLast24h: health.queriesLast24h,
    connections: health.connections,
    scheduledTasks: health.scheduledTasks,
    stripeCustomerId: row.stripe_customer_id,
    trialEndsAt: row.trial_ends_at,
    suspendedAt: row.suspended_at,
    deletedAt: row.deleted_at,
    region: row.region,
    regionAssignedAt: row.region_assigned_at,
    createdAt: row.createdAt,
  };
}

/**
 * Compute median from a sorted array of numbers.
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// MRR estimates per plan tier (monthly recurring revenue)
const PLAN_MRR: Record<string, number> = {
  free: 0,
  trial: 0,
  team: 99,
  enterprise: 499,
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const platformAdmin = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

platformAdmin.use(platformAdminAuth);
platformAdmin.use(requestContext);

// ── List workspaces ──────────────────────────────────────────────────

platformAdmin.openapi(listWorkspacesRoute, async (c) => {
  const requestId = c.get("requestId");

  if (!hasInternalDB()) {
    return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
  }

  try {
    const rows = await internalQuery<{
      id: string;
      name: string;
      slug: string;
      workspace_status: WorkspaceStatus;
      plan_tier: PlanTier;
      byot: boolean;
      stripe_customer_id: string | null;
      trial_ends_at: string | null;
      suspended_at: string | null;
      deleted_at: string | null;
      region: string | null;
      region_assigned_at: string | null;
      createdAt: string;
      members: number;
      conversations: number;
      queries_last_24h: number;
      connections: number;
      scheduled_tasks: number;
    }>(
      `SELECT
         o.id, o.name, o.slug, o.workspace_status, o.plan_tier, o.byot,
         o.stripe_customer_id, o.trial_ends_at, o.suspended_at, o.deleted_at,
         o.region, o.region_assigned_at, o."createdAt",
         COALESCE(m.cnt, 0)::int AS members,
         COALESCE(cv.cnt, 0)::int AS conversations,
         COALESCE(al.cnt, 0)::int AS queries_last_24h,
         COALESCE(cn.cnt, 0)::int AS connections,
         COALESCE(st.cnt, 0)::int AS scheduled_tasks
       FROM organization o
       LEFT JOIN (SELECT "organizationId", COUNT(*)::int AS cnt FROM member GROUP BY "organizationId") m ON m."organizationId" = o.id
       LEFT JOIN (SELECT org_id, COUNT(*)::int AS cnt FROM conversations GROUP BY org_id) cv ON cv.org_id = o.id
       LEFT JOIN (SELECT org_id, COUNT(*)::int AS cnt FROM audit_log WHERE timestamp > now() - interval '24 hours' GROUP BY org_id) al ON al.org_id = o.id
       LEFT JOIN (SELECT org_id, COUNT(*)::int AS cnt FROM connections GROUP BY org_id) cn ON cn.org_id = o.id
       LEFT JOIN (SELECT org_id, COUNT(*)::int AS cnt FROM scheduled_tasks WHERE enabled = true GROUP BY org_id) st ON st.org_id = o.id
       ORDER BY o."createdAt" DESC`,
    );

    const workspaces = rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.workspace_status,
      planTier: row.plan_tier,
      byot: row.byot,
      members: row.members,
      conversations: row.conversations,
      queriesLast24h: row.queries_last_24h,
      connections: row.connections,
      scheduledTasks: row.scheduled_tasks,
      stripeCustomerId: row.stripe_customer_id,
      trialEndsAt: row.trial_ends_at,
      suspendedAt: row.suspended_at,
      deletedAt: row.deleted_at,
      region: row.region,
      regionAssignedAt: row.region_assigned_at,
      createdAt: row.createdAt,
    }));

    return c.json({ workspaces }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to list workspaces");
    return c.json({ error: "internal_error", message: "Failed to load workspaces.", requestId }, 500);
  }
});

// ── Get workspace detail ─────────────────────────────────────────────

platformAdmin.openapi(getWorkspaceRoute, async (c) => {
  const requestId = c.get("requestId");

  if (!hasInternalDB()) {
    return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
  }

  const workspaceId = c.req.param("id");

  try {
    const workspace = await getWorkspaceDetails(workspaceId);
    if (!workspace) {
      return c.json({ error: "not_found", message: "Workspace not found.", requestId }, 404);
    }

    const [memberRows, convRows, queryRows, connRows, taskRows, userRows] = await Promise.all([
      internalQuery<{ count: number }>(
        `SELECT COUNT(*)::int as count FROM member WHERE "organizationId" = $1`,
        [workspaceId],
      ),
      internalQuery<{ count: number }>(
        `SELECT COUNT(*)::int as count FROM conversations WHERE org_id = $1`,
        [workspaceId],
      ),
      internalQuery<{ count: number }>(
        `SELECT COUNT(*)::int as count FROM audit_log WHERE org_id = $1 AND timestamp > now() - interval '24 hours'`,
        [workspaceId],
      ),
      internalQuery<{ count: number }>(
        `SELECT COUNT(*)::int as count FROM connections WHERE org_id = $1`,
        [workspaceId],
      ),
      internalQuery<{ count: number }>(
        `SELECT COUNT(*)::int as count FROM scheduled_tasks WHERE org_id = $1 AND enabled = true`,
        [workspaceId],
      ),
      internalQuery<{ id: string; name: string; email: string; role: AtlasRole; createdAt: string }>(
        `SELECT u.id, u.name, u.email, m.role, u."createdAt"
         FROM "user" u
         JOIN member m ON m."userId" = u.id
         WHERE m."organizationId" = $1
         ORDER BY u."createdAt" ASC`,
        [workspaceId],
      ),
    ]);

    const ws = toWorkspaceResponse(workspace, {
      members: memberRows[0]?.count ?? 0,
      conversations: convRows[0]?.count ?? 0,
      queriesLast24h: queryRows[0]?.count ?? 0,
      connections: connRows[0]?.count ?? 0,
      scheduledTasks: taskRows[0]?.count ?? 0,
    });

    const users = userRows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt,
    }));

    return c.json({ workspace: ws, users }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, workspaceId }, "Failed to get workspace details");
    return c.json({ error: "internal_error", message: "Failed to load workspace details.", requestId }, 500);
  }
});

// ── Suspend workspace ────────────────────────────────────────────────

platformAdmin.openapi(suspendWorkspaceRoute, async (c) => {
  const requestId = c.get("requestId");

  if (!hasInternalDB()) {
    return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
  }

  const workspaceId = c.req.param("id");

  try {
    const workspace = await getWorkspaceDetails(workspaceId);
    if (!workspace) {
      return c.json({ error: "not_found", message: "Workspace not found.", requestId }, 404);
    }

    if (workspace.workspace_status === "suspended") {
      return c.json({ error: "conflict", message: "Workspace is already suspended.", requestId }, 409);
    }

    if (workspace.workspace_status === "deleted") {
      return c.json({ error: "conflict", message: "Cannot suspend a deleted workspace.", requestId }, 409);
    }

    await updateWorkspaceStatus(workspaceId, "suspended");
    log.info({ workspaceId, requestId }, "Workspace suspended by platform admin");

    return c.json({ message: "Workspace suspended.", workspaceId }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, workspaceId }, "Failed to suspend workspace");
    return c.json({ error: "internal_error", message: "Failed to suspend workspace.", requestId }, 500);
  }
});

// ── Unsuspend workspace ──────────────────────────────────────────────

platformAdmin.openapi(unsuspendWorkspaceRoute, async (c) => {
  const requestId = c.get("requestId");

  if (!hasInternalDB()) {
    return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
  }

  const workspaceId = c.req.param("id");

  try {
    const workspace = await getWorkspaceDetails(workspaceId);
    if (!workspace) {
      return c.json({ error: "not_found", message: "Workspace not found.", requestId }, 404);
    }

    if (workspace.workspace_status !== "suspended") {
      return c.json({ error: "conflict", message: "Workspace is not suspended.", requestId }, 409);
    }

    await updateWorkspaceStatus(workspaceId, "active");
    log.info({ workspaceId, requestId }, "Workspace unsuspended by platform admin");

    return c.json({ message: "Workspace reactivated.", workspaceId }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, workspaceId }, "Failed to unsuspend workspace");
    return c.json({ error: "internal_error", message: "Failed to reactivate workspace.", requestId }, 500);
  }
});

// ── Delete workspace ─────────────────────────────────────────────────

platformAdmin.openapi(deleteWorkspaceRoute, async (c) => {
  const requestId = c.get("requestId");

  if (!hasInternalDB()) {
    return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
  }

  const workspaceId = c.req.param("id");

  try {
    const workspace = await getWorkspaceDetails(workspaceId);
    if (!workspace) {
      return c.json({ error: "not_found", message: "Workspace not found.", requestId }, 404);
    }

    if (workspace.workspace_status === "deleted") {
      return c.json({ error: "conflict", message: "Workspace is already deleted.", requestId }, 409);
    }

    // Cascade cleanup first, then mark as deleted — if cleanup fails,
    // the workspace remains in its current state and can be retried.
    const cleanup = await cascadeWorkspaceDelete(workspaceId);
    await updateWorkspaceStatus(workspaceId, "deleted");

    log.info({ workspaceId, cleanup, requestId }, "Workspace deleted by platform admin");

    return c.json({
      message: "Workspace deleted.",
      workspaceId,
      cleanup,
    }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, workspaceId }, "Failed to delete workspace");
    return c.json({ error: "internal_error", message: "Failed to delete workspace.", requestId }, 500);
  }
});

// ── Change plan ──────────────────────────────────────────────────────

platformAdmin.openapi(changePlanRoute, async (c) => {
  const requestId = c.get("requestId");

  if (!hasInternalDB()) {
    return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
  }

  const workspaceId = c.req.param("id");
  const body = c.req.valid("json");
  const { planTier } = body;

  if (!VALID_PLAN_TIERS.has(planTier)) {
    return c.json({ error: "validation_error", message: `Invalid plan tier: ${planTier}`, requestId }, 400);
  }

  try {
    const workspace = await getWorkspaceDetails(workspaceId);
    if (!workspace) {
      return c.json({ error: "not_found", message: "Workspace not found.", requestId }, 404);
    }

    const updated = await updateWorkspacePlanTier(workspaceId, planTier as PlanTier);
    if (!updated) {
      return c.json({ error: "not_found", message: "Workspace not found.", requestId }, 404);
    }

    // Invalidate the billing enforcement cache for this org
    try {
      const { invalidatePlanCache } = await import("@atlas/api/lib/billing/enforcement");
      invalidatePlanCache(workspaceId);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), workspaceId, requestId },
        "Failed to invalidate plan cache after tier change — stale limits may persist until cache expires",
      );
    }

    log.info({ workspaceId, planTier, previousTier: workspace.plan_tier, requestId }, "Workspace plan changed by platform admin");

    return c.json({ message: "Plan updated.", workspaceId, planTier }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, workspaceId }, "Failed to change workspace plan");
    return c.json({ error: "internal_error", message: "Failed to update plan.", requestId }, 500);
  }
});

// ── Platform stats ───────────────────────────────────────────────────

platformAdmin.openapi(platformStatsRoute, async (c) => {
  const requestId = c.get("requestId");

  if (!hasInternalDB()) {
    return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
  }

  try {
    const [wsRows, userRows, queryRows] = await Promise.all([
      internalQuery<{ total: number; active: number; suspended: number }>(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE workspace_status = 'active')::int AS active,
           COUNT(*) FILTER (WHERE workspace_status = 'suspended')::int AS suspended
         FROM organization`,
      ),
      internalQuery<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "user"`,
      ),
      internalQuery<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM audit_log WHERE timestamp > now() - interval '24 hours'`,
      ),
    ]);

    // MRR: sum of PLAN_MRR for each active workspace's plan tier
    const mrrRows = await internalQuery<{ plan_tier: string; cnt: number }>(
      `SELECT plan_tier, COUNT(*)::int AS cnt FROM organization WHERE workspace_status = 'active' GROUP BY plan_tier`,
    );
    const mrr = mrrRows.reduce((sum, row) => sum + (PLAN_MRR[row.plan_tier] ?? 0) * row.cnt, 0);

    return c.json({
      totalWorkspaces: wsRows[0]?.total ?? 0,
      activeWorkspaces: wsRows[0]?.active ?? 0,
      suspendedWorkspaces: wsRows[0]?.suspended ?? 0,
      totalUsers: userRows[0]?.count ?? 0,
      totalQueries24h: queryRows[0]?.count ?? 0,
      mrr,
    }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to compute platform stats");
    return c.json({ error: "internal_error", message: "Failed to load platform statistics.", requestId }, 500);
  }
});

// ── Noisy neighbors ──────────────────────────────────────────────────

platformAdmin.openapi(noisyNeighborsRoute, async (c) => {
  const requestId = c.get("requestId");

  if (!hasInternalDB()) {
    return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
  }

  try {
    // Get current period usage for each active workspace
    const rows = await internalQuery<{
      id: string;
      name: string;
      plan_tier: PlanTier;
      query_count: number;
      token_count: number;
      storage_bytes: number;
    }>(
      `SELECT
         o.id, o.name, o.plan_tier,
         COALESCE(us.query_count, 0)::int AS query_count,
         COALESCE(us.token_count, 0)::int AS token_count,
         COALESCE(us.storage_bytes, 0)::int AS storage_bytes
       FROM organization o
       LEFT JOIN usage_summaries us
         ON us.workspace_id = o.id
         AND us.period = 'monthly'
         AND us.period_start = date_trunc('month', now())
       WHERE o.workspace_status = 'active'`,
    );

    if (rows.length === 0) {
      return c.json({ neighbors: [], medians: { queries: 0, tokens: 0, storage: 0 } }, 200);
    }

    const queryValues = rows.map((r) => r.query_count);
    const tokenValues = rows.map((r) => r.token_count);
    const storageValues = rows.map((r) => r.storage_bytes);

    const medians = {
      queries: median(queryValues),
      tokens: median(tokenValues),
      storage: median(storageValues),
    };

    const THRESHOLD = 3;
    type NoisyMetric = "queries" | "tokens" | "storage";
    const neighbors: Array<{
      workspaceId: string;
      workspaceName: string;
      planTier: PlanTier;
      metric: NoisyMetric;
      value: number;
      median: number;
      ratio: number;
    }> = [];

    for (const row of rows) {
      const checks: Array<{ metric: NoisyMetric; value: number; med: number }> = [
        { metric: "queries", value: row.query_count, med: medians.queries },
        { metric: "tokens", value: row.token_count, med: medians.tokens },
        { metric: "storage", value: row.storage_bytes, med: medians.storage },
      ];

      for (const check of checks) {
        if (check.med > 0 && check.value > check.med * THRESHOLD) {
          neighbors.push({
            workspaceId: row.id,
            workspaceName: row.name,
            planTier: row.plan_tier,
            metric: check.metric,
            value: check.value,
            median: check.med,
            ratio: Math.round((check.value / check.med) * 100) / 100,
          });
        }
      }
    }

    return c.json({ neighbors, medians }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to detect noisy neighbors");
    return c.json({ error: "internal_error", message: "Failed to detect noisy neighbors.", requestId }, 500);
  }
});

export { platformAdmin };
