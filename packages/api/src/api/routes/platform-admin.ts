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
 * - POST   /workspaces/:id/purge — GDPR hard delete (permanently remove all data)
 * - PATCH  /workspaces/:id/plan — change plan tier
 * - GET    /stats               — aggregate platform stats
 * - GET    /noisy-neighbors     — workspaces consuming disproportionate resources
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createPlatformRouter } from "./admin-router";
import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { runEffect } from "@atlas/api/lib/effect/hono";
import {
  RequestContext,
} from "@atlas/api/lib/effect/services";
import {
  hasInternalDB,
  internalQuery,
  queryEffect,
  getWorkspaceDetails,
  updateWorkspaceStatus,
  updateWorkspacePlanTier,
  setWorkspaceTrialEndsAt,
  cascadeWorkspaceDelete,
  hardDeleteWorkspace,
  type WorkspaceRow,
  type PlanTier,
  type WorkspaceStatus,
} from "@atlas/api/lib/db/internal";
import {
  PLAN_TIERS,
  type PlatformWorkspace,
} from "@useatlas/types";
import { getPlanDefinition, PLAN_OVERRIDE_DAYS } from "@atlas/api/lib/billing/plans";
import { invalidatePlanCache } from "@atlas/api/lib/billing/enforcement";
import {
  cancelStripeSubscriptionsForWorkspace,
  purgeStripeBillingForWorkspace,
  pauseStripeCollectionForWorkspace,
  resumeStripeCollectionForWorkspace,
  stripeAuditMetadata,
  withWarnings,
} from "@atlas/api/lib/billing/workspace-teardown";
import { getLoadTestAllowlist } from "@atlas/api/lib/auth/load-test-allowlist";
import {
  ABUSE_RESTORE_STATUSES,
  checkAbuseStatus,
  getAbuseRestoreStatus,
} from "@atlas/api/lib/security/abuse";
import {
  PlatformStatsSchema,
  PlatformWorkspaceSchema,
  PlatformWorkspaceUserSchema,
  NoisyNeighborSchema,
  PlatformOverviewSchema,
} from "@useatlas/schemas";
import { type AtlasRole } from "@atlas/api/lib/auth/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { connections } from "@atlas/api/lib/db/connection";
import { plugins } from "@atlas/api/lib/plugins/registry";
import {
  getSemanticRoot,
  discoverEntities,
} from "@atlas/api/lib/semantic/files";

const log = createLogger("platform-admin");

const VALID_PLAN_TIERS = new Set<string>(PLAN_TIERS);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
// Platform response schemas come from @useatlas/schemas so the route,
// the web parse, and the generated OpenAPI spec all describe the same shape.
// Request-validation schemas (like ChangePlanBodySchema below) stay local
// because they describe server input, not wire-format output.

const ChangePlanBodySchema = z.object({
  planTier: z.enum(PLAN_TIERS).openapi({
    description: "The new plan tier for the workspace.",
    example: "starter",
  }),
  // #3427 — an operator plan change is an OVERRIDE that takes precedence over
  // Stripe for a bounded window (default PLAN_OVERRIDE_DAYS). The Stripe webhook
  // tier sync skips its write while the window is active. Pass `0` to release
  // control back to Stripe immediately (re-sync to the Stripe-derived tier).
  overrideDays: z.number().int().min(0).max(365).optional().openapi({
    description:
      "Days the operator grant takes precedence over Stripe before auto-healing. Defaults to 90. Pass 0 to clear the override and let Stripe reassert control immediately.",
    example: 90,
  }),
  // #3427 — setting the `trial` tier MUST carry an explicit end date: reusing a
  // stale `trial_ends_at` would stamp an instantly-expired trial. Required when
  // planTier === "trial"; ignored otherwise. Also doubles as the trial-extension
  // surface (set planTier="trial" with a future date to extend).
  trialEndsAt: z.string().datetime().optional().openapi({
    description:
      "Required when planTier is 'trial' — the new trial end date (ISO 8601). Ignored for other tiers.",
    example: "2026-08-01T00:00:00.000Z",
  }),
});

/** Tiers an operator downgrade-to-free/locked must stop Stripe invoicing for (#3427). */
const STRIPE_CANCEL_ON_TIER = new Set<PlanTier>(["free", "locked"]);

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
      content: {
        "application/json": {
          schema: z.object({
            workspaces: z.array(PlatformWorkspaceSchema),
            // Boot-time abuse rehydrate outcome. When `load_failed`, the
            // engine started with empty in-memory state — every
            // workspace's `abuseLevel` will render as `"none"` even
            // though enforcement is effectively off. The web banner
            // reads this and surfaces the divergence loudly.
            abuseRestoreStatus: z.enum(ABUSE_RESTORE_STATUSES),
          }),
        },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getWorkspaceRoute = createRoute({
  method: "get",
  path: "/workspaces/{id}",
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
  path: "/workspaces/{id}/suspend",
  tags: ["Platform Admin"],
  summary: "Suspend a workspace",
  description: "SaaS only. Suspends a workspace, preventing all user access until reactivated.",
  responses: {
    200: {
      description: "Workspace suspended",
      content: { "application/json": { schema: z.object({ message: z.string(), workspaceId: z.string(), warnings: z.array(z.string()).optional() }) } },
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
  path: "/workspaces/{id}/unsuspend",
  tags: ["Platform Admin"],
  summary: "Unsuspend a workspace",
  description: "SaaS only. Reactivates a suspended workspace, restoring user access.",
  responses: {
    200: {
      description: "Workspace reactivated",
      content: { "application/json": { schema: z.object({ message: z.string(), workspaceId: z.string(), warnings: z.array(z.string()).optional() }) } },
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
  path: "/workspaces/{id}",
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
            warnings: z.array(z.string()).optional(),
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

const purgeWorkspaceRoute = createRoute({
  method: "post",
  path: "/workspaces/{id}/purge",
  tags: ["Platform Admin"],
  summary: "Purge workspace (GDPR hard delete)",
  description: "SaaS only. Permanently removes ALL data for a workspace — conversations, messages, audit logs, integrations, members, and orphaned users. The workspace must already be soft-deleted. This action is irreversible.",
  responses: {
    200: {
      description: "Workspace purged",
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
            workspaceId: z.string(),
            purged: z.record(z.string(), z.number()),
            totalRows: z.number(),
            warnings: z.array(z.string()).optional(),
          }),
        },
      },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Workspace not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Workspace must be soft-deleted first", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const changePlanRoute = createRoute({
  method: "patch",
  path: "/workspaces/{id}/plan",
  tags: ["Platform Admin"],
  summary: "Change workspace plan tier",
  description: "SaaS only. Updates the plan tier for a workspace (free, trial, starter, pro, business, locked).",
  request: { body: { required: true, content: { "application/json": { schema: ChangePlanBodySchema } } } },
  responses: {
    200: {
      description: "Plan updated",
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
            workspaceId: z.string(),
            planTier: z.string(),
            // #3427 — when the operator grant takes precedence over Stripe.
            // null when the override was cleared (overrideDays === 0).
            planOverrideUntil: z.string().nullable(),
            trialEndsAt: z.string().nullable().optional(),
            warnings: z.array(z.string()).optional(),
          }),
        },
      },
    },
    400: { description: "Invalid plan tier or missing trialEndsAt", content: { "application/json": { schema: ErrorSchema } } },
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

const platformOverviewRoute = createRoute({
  method: "get",
  path: "/overview",
  tags: ["Platform Admin"],
  summary: "Deployment-wide overview",
  description:
    "Platform admin only. Returns deployment-scaffold counts (entities, " +
    "plugins, plugin health) plus pool warnings. Component Health (the " +
    "datasource pool, internal DB, LLM provider, scheduler, sandbox) is " +
    "served from `/api/health` — kept there so unauthenticated readiness " +
    "probes still have a target. The deployment-scaffold counts live " +
    "here, away from the per-workspace `/admin/overview` (#2489).",
  responses: {
    200: {
      description: "Deployment-wide overview data",
      content: { "application/json": { schema: PlatformOverviewSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
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

/**
 * Build a PlatformWorkspace from a WorkspaceRow + health counts. Shared
 * between the list route (where the SQL row carries health columns
 * inline) and the detail route (where health is loaded as a follow-up
 * Promise.all).
 */
function toWorkspaceResponse(
  row: WorkspaceRow,
  health: { members: number; conversations: number; queriesLast24h: number; connections: number; scheduledTasks: number },
  /**
   * Optional pre-resolved allowlist for batch callers. The list route
   * parses `ATLAS_LOADTEST_ALLOWED_ORGS` once per request and threads
   * the result through every row instead of re-parsing per workspace
   * (#2249). Detail-route callers pass `undefined` and pay the parse.
   */
  allowlist: ReadonlySet<string> | null = getLoadTestAllowlist(),
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
    neverSuspend: allowlist?.has(row.id) ?? false,
    // `status` reflects the `workspace_status` DB column; `abuseLevel`
    // is the in-memory `checkAbuseStatus` verdict. The two diverge when
    // the detector escalates without a corresponding admin mutation —
    // that divergence is what surfacing both here exposes.
    abuseLevel: checkAbuseStatus(row.id).level,
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

// MRR per seat per plan tier. Iterating the canonical `PLAN_TIERS` tuple
// and reading `getPlanDefinition(tier).pricePerSeat` from
// `lib/billing/plans.ts` means pricing stays in lockstep and every tier
// that exists at runtime has a price. Exhaustiveness is enforced one
// layer up: `PLANS: Record<PlanTier, PlanDefinition>` in `plans.ts` would
// fail to compile if a tier were added without a definition. Regression
// for #1680: migrations 0020 + 0027 renamed tiers to starter/pro/business
// and the old hard-coded map silently returned $0 for every paying
// workspace until now.
const PLAN_MRR = Object.fromEntries(
  PLAN_TIERS.map((tier) => [tier, getPlanDefinition(tier).pricePerSeat]),
) as Record<PlanTier, number>;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const platformAdmin = createPlatformRouter();

// ── List workspaces ──────────────────────────────────────────────────

platformAdmin.openapi(listWorkspacesRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
    }

    const rows = yield* queryEffect<{
      id: string;
      name: string;
      slug: string;
      workspace_status: WorkspaceStatus;
      plan_tier: PlanTier;
      byot: boolean;
      stripe_customer_id: string | null;
      trial_ends_at: string | null;
      suspended_at: string | null;
      suspension_source: "billing" | "operator" | null;
      plan_override_until: string | null;
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
         o."stripeCustomerId" AS stripe_customer_id, o.trial_ends_at, o.suspended_at, o.suspension_source, o.plan_override_until, o.deleted_at,
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
       LEFT JOIN (SELECT workspace_id AS org_id, COUNT(*)::int AS cnt FROM workspace_plugins
                  WHERE pillar = 'datasource' AND status != 'archived' GROUP BY workspace_id) cn ON cn.org_id = o.id
       LEFT JOIN (SELECT org_id, COUNT(*)::int AS cnt FROM scheduled_tasks WHERE enabled = true GROUP BY org_id) st ON st.org_id = o.id
       ORDER BY o."createdAt" DESC`,
    );

    // Parse the allowlist once per request and thread it through every
    // row — `toWorkspaceResponse` defaults to calling `getLoadTestAllowlist()`
    // itself for the detail-route single-row case (#2249).
    const allowlist = getLoadTestAllowlist();

    const workspaces = rows.map((row) =>
      toWorkspaceResponse(
        {
          id: row.id,
          name: row.name,
          slug: row.slug,
          workspace_status: row.workspace_status,
          plan_tier: row.plan_tier,
          byot: row.byot,
          stripe_customer_id: row.stripe_customer_id,
          trial_ends_at: row.trial_ends_at,
          suspended_at: row.suspended_at,
          suspension_source: row.suspension_source,
          plan_override_until: row.plan_override_until,
          deleted_at: row.deleted_at,
          region: row.region,
          region_assigned_at: row.region_assigned_at,
          createdAt: row.createdAt,
        },
        {
          members: row.members,
          conversations: row.conversations,
          queriesLast24h: row.queries_last_24h,
          connections: row.connections,
          scheduledTasks: row.scheduled_tasks,
        },
        allowlist,
      ),
    );

    return c.json({ workspaces, abuseRestoreStatus: getAbuseRestoreStatus() }, 200);
  }), { label: "list workspaces" });
});

// ── Get workspace detail ─────────────────────────────────────────────

platformAdmin.openapi(getWorkspaceRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
    }

    const workspaceId = c.req.param("id");

    const workspace = yield* Effect.promise(() => getWorkspaceDetails(workspaceId));
    if (!workspace) {
      return c.json({ error: "not_found", message: "Workspace not found.", requestId }, 404);
    }

    const [memberRows, convRows, queryRows, connRows, taskRows, userRows] = yield* Effect.promise(() => Promise.all([
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
      // Exclude archive tombstones — hidden demo installs shouldn't
      // inflate the platform org-list per-workspace connection count.
      // Datasource installs live in workspace_plugins post-0096 cutover.
      internalQuery<{ count: number }>(
        `SELECT COUNT(*)::int as count FROM workspace_plugins
          WHERE workspace_id = $1 AND pillar = 'datasource' AND status != 'archived'`,
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
    ]));

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
  }), { label: "get workspace details" });
});

// ── Suspend workspace ────────────────────────────────────────────────

platformAdmin.openapi(suspendWorkspaceRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
    }

    const workspaceId = c.req.param("id");

    const workspace = yield* Effect.promise(() => getWorkspaceDetails(workspaceId));
    if (!workspace) {
      return c.json({ error: "not_found", message: "Workspace not found.", requestId }, 404);
    }

    if (workspace.workspace_status === "suspended") {
      return c.json({ error: "conflict", message: "Workspace is already suspended.", requestId }, 409);
    }

    if (workspace.workspace_status === "deleted") {
      return c.json({ error: "conflict", message: "Cannot suspend a deleted workspace.", requestId }, 409);
    }

    // Operator/manual suspension (#3424): a billing recovery must NOT clear
    // this — only suspensions sourced 'billing' are auto-recovered.
    yield* Effect.promise(() => updateWorkspaceStatus(workspaceId, "suspended", "operator"));
    // Drop the cached `getCachedWorkspace` entry so the next user-side
    // request sees the new status within its TTL window (#2165).
    invalidatePlanCache(workspaceId);

    // Suspension billing policy (#3425): pause Stripe payment collection
    // (`pause_collection: { behavior: "void" }`) — a suspended workspace
    // can't use the product, so it must not keep being invoiced/dunned.
    // The subscription stays alive so unsuspending restores billing.
    // Stripe failures surface as operator warnings; the suspend stands.
    const billing = yield* Effect.promise(() => pauseStripeCollectionForWorkspace(workspaceId));

    log.info({ workspaceId, requestId, stripe: billing }, "Workspace suspended by platform admin");

    logAdminAction({
      actionType: ADMIN_ACTIONS.workspace.suspend,
      targetType: "workspace",
      targetId: workspaceId,
      scope: "platform",
      metadata: stripeAuditMetadata(billing),
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    return c.json({ message: "Workspace suspended.", workspaceId, ...withWarnings(billing) }, 200);
  }), { label: "suspend workspace" });
});

// ── Unsuspend workspace ──────────────────────────────────────────────

platformAdmin.openapi(unsuspendWorkspaceRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
    }

    const workspaceId = c.req.param("id");

    const workspace = yield* Effect.promise(() => getWorkspaceDetails(workspaceId));
    if (!workspace) {
      return c.json({ error: "not_found", message: "Workspace not found.", requestId }, 404);
    }

    if (workspace.workspace_status !== "suspended") {
      return c.json({ error: "conflict", message: "Workspace is not suspended.", requestId }, 409);
    }

    yield* Effect.promise(() => updateWorkspaceStatus(workspaceId, "active"));
    invalidatePlanCache(workspaceId); // #2165 — see suspend handler above

    // Resume Stripe payment collection paused at suspension time (#3425) —
    // see the suspend handler above for the pause-collection policy.
    const billing = yield* Effect.promise(() => resumeStripeCollectionForWorkspace(workspaceId));

    log.info({ workspaceId, requestId, stripe: billing }, "Workspace unsuspended by platform admin");

    logAdminAction({
      actionType: ADMIN_ACTIONS.workspace.unsuspend,
      targetType: "workspace",
      targetId: workspaceId,
      scope: "platform",
      metadata: stripeAuditMetadata(billing),
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    return c.json({ message: "Workspace reactivated.", workspaceId, ...withWarnings(billing) }, 200);
  }), { label: "unsuspend workspace" });
});

// ── Delete workspace ─────────────────────────────────────────────────

platformAdmin.openapi(deleteWorkspaceRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
    }

    const workspaceId = c.req.param("id");

    const workspace = yield* Effect.promise(() => getWorkspaceDetails(workspaceId));
    if (!workspace) {
      return c.json({ error: "not_found", message: "Workspace not found.", requestId }, 404);
    }

    if (workspace.workspace_status === "deleted") {
      return c.json({ error: "conflict", message: "Workspace is already deleted.", requestId }, 409);
    }

    // Cancel Stripe billing FIRST, then cascade (#3425): a deleted org
    // must stop invoicing even if the cascade below fails, and the
    // @better-auth/stripe plugin's own guard blocks user-initiated org
    // deletion while subscriptions exist — this direct-DB path honors the
    // same ordering rather than bypassing it. Stripe failures surface as
    // operator warnings on the response; the delete proceeds.
    const billing = yield* Effect.promise(() => cancelStripeSubscriptionsForWorkspace(workspaceId));

    // Cascade cleanup first, then mark as deleted — if cleanup fails,
    // the workspace remains in its current state and can be retried.
    const cleanup = yield* Effect.tryPromise({
      try: () => cascadeWorkspaceDelete(workspaceId),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });
    yield* Effect.tryPromise({
      try: () => updateWorkspaceStatus(workspaceId, "deleted"),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });
    invalidatePlanCache(workspaceId); // #2165 — see suspend handler above

    log.info({ workspaceId, cleanup, stripe: billing, requestId }, "Workspace deleted by platform admin");

    logAdminAction({
      actionType: ADMIN_ACTIONS.workspace.delete,
      targetType: "workspace",
      targetId: workspaceId,
      scope: "platform",
      metadata: { cleanup, ...stripeAuditMetadata(billing) },
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    return c.json({
      message: "Workspace deleted.",
      workspaceId,
      cleanup,
      ...withWarnings(billing),
    }, 200);
  }), { label: "delete workspace" });
});

// ── Purge workspace (GDPR hard delete) ──────────────────────────────

platformAdmin.openapi(purgeWorkspaceRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
    }

    const workspaceId = c.req.param("id");

    const workspace = yield* Effect.promise(() => getWorkspaceDetails(workspaceId));
    if (!workspace) {
      return c.json({ error: "not_found", message: "Workspace not found.", requestId }, 404);
    }

    if (workspace.workspace_status !== "deleted") {
      return c.json({
        error: "conflict",
        message: "Workspace must be soft-deleted before purging. Delete the workspace first, then purge.",
        requestId,
      }, 409);
    }

    // Stripe teardown BEFORE the purge cascade (#3425): the cascade
    // destroys the organization row carrying the plugin-owned
    // stripeCustomerId (#3417), so the customer must be deleted while the
    // linkage still exists — a GDPR purge must leave no billable Stripe
    // linkage behind. Stripe failures surface as operator warnings (with
    // the raw Stripe ids for manual follow-up); the purge proceeds.
    const billing = yield* Effect.promise(() =>
      purgeStripeBillingForWorkspace(workspaceId, workspace.stripe_customer_id),
    );

    const purged = yield* Effect.tryPromise({
      try: () => hardDeleteWorkspace(workspaceId),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    const totalRows = Object.values(purged).reduce((sum, n) => sum + n, 0);

    log.info({ workspaceId, totalRows, stripe: billing, requestId }, "Workspace purged (GDPR hard delete)");

    logAdminAction({
      actionType: ADMIN_ACTIONS.workspace.purge,
      targetType: "workspace",
      targetId: workspaceId,
      scope: "platform",
      metadata: { purged, totalRows, ...stripeAuditMetadata(billing) },
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    return c.json({
      message: "Workspace permanently purged. All data has been irreversibly removed.",
      workspaceId,
      purged: purged as unknown as Record<string, number>,
      totalRows,
      ...withWarnings(billing),
    }, 200);
  }), { label: "purge workspace (GDPR)" });
});

// ── Change plan ──────────────────────────────────────────────────────

platformAdmin.openapi(changePlanRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
    }

    const workspaceId = c.req.param("id");
    const body = c.req.valid("json");
    const { planTier, overrideDays, trialEndsAt } = body;

    if (!VALID_PLAN_TIERS.has(planTier)) {
      return c.json({ error: "validation_error", message: `Invalid plan tier: ${planTier}`, requestId }, 400);
    }

    // #3427 — setting `trial` must carry an explicit, future end date.
    // Without this the org reuses a stale `trial_ends_at` and the trial is
    // instantly expired. This also IS the trial-extension surface: set
    // planTier="trial" with a future date to extend an active/lapsed trial.
    let parsedTrialEndsAt: Date | null = null;
    if (planTier === "trial") {
      if (!trialEndsAt) {
        return c.json({
          error: "validation_error",
          message: "Setting the 'trial' tier requires an explicit trialEndsAt (ISO 8601) — a stale trial_ends_at would expire instantly.",
          requestId,
        }, 400);
      }
      parsedTrialEndsAt = new Date(trialEndsAt);
      if (Number.isNaN(parsedTrialEndsAt.getTime())) {
        return c.json({ error: "validation_error", message: `Invalid trialEndsAt: ${trialEndsAt}`, requestId }, 400);
      }
      if (parsedTrialEndsAt.getTime() <= Date.now()) {
        return c.json({ error: "validation_error", message: "trialEndsAt must be in the future.", requestId }, 400);
      }
    }

    const workspace = yield* Effect.promise(() => getWorkspaceDetails(workspaceId));
    if (!workspace) {
      return c.json({ error: "not_found", message: "Workspace not found.", requestId }, 404);
    }

    // #3427 — an operator plan change OVERRIDES Stripe for a bounded window so
    // the next webhook can't clobber the grant. `overrideDays === 0` clears the
    // override (release control back to Stripe immediately); omit it for the
    // PLAN_OVERRIDE_DAYS default. The directive is passed atomically with the
    // tier write so the row never sits at "new tier, no override".
    //
    // EXCEPTION (#3427 review) — a `trial` grant must NOT stamp an override. A
    // trialing org has no competing active subscription, so the override would
    // only block the customer's OWN paid conversion (checkout →
    // applyWorkspaceTier) for the window's length — Stripe charges them while
    // they stay stranded on the trial tier. Trial protection is the
    // trial_ends_at window, not the override, so we clear it for trial.
    const days = planTier === "trial" ? 0 : (overrideDays ?? PLAN_OVERRIDE_DAYS);
    const overrideUntil: Date | null = days === 0 ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const override = days === 0 ? ("clear" as const) : { until: overrideUntil as Date };

    const updated = yield* Effect.promise(() => updateWorkspacePlanTier(workspaceId, planTier as PlanTier, override));
    if (!updated) {
      return c.json({ error: "not_found", message: "Workspace not found.", requestId }, 404);
    }

    // Trial end date: set AFTER the tier write so the two land for the same
    // row. setWorkspaceTrialEndsAt returning false here would be a
    // get-then-write race (org deleted mid-request) — log, don't fail the op.
    if (parsedTrialEndsAt) {
      const stamped = yield* Effect.promise(() => setWorkspaceTrialEndsAt(workspaceId, parsedTrialEndsAt));
      if (!stamped) {
        log.warn({ workspaceId, requestId }, "Plan set to trial but trial_ends_at write matched 0 rows — workspace vanished mid-request?");
      }
    }

    // #3427 — downgrading a paying org to free/locked must STOP Stripe
    // invoicing; otherwise the customer keeps being charged for entitlements
    // the DB no longer grants. Best-effort: Stripe failures surface as
    // operator warnings (same pattern as the delete/purge teardown), the plan
    // change itself always proceeds.
    let warnings: string[] = [];
    let stripeMeta: Record<string, unknown> = {};
    if (STRIPE_CANCEL_ON_TIER.has(planTier as PlanTier)) {
      const billing = yield* Effect.promise(() => cancelStripeSubscriptionsForWorkspace(workspaceId));
      warnings = withWarnings(billing).warnings ?? [];
      stripeMeta = stripeAuditMetadata(billing);
    }

    invalidatePlanCache(workspaceId); // #2165 — see suspend handler above

    log.info(
      { workspaceId, planTier, previousTier: workspace.plan_tier, planOverrideUntil: overrideUntil?.toISOString() ?? null, requestId },
      "Workspace plan changed by platform admin",
    );

    logAdminAction({
      actionType: ADMIN_ACTIONS.workspace.changePlan,
      targetType: "workspace",
      targetId: workspaceId,
      scope: "platform",
      metadata: {
        previousPlan: workspace.plan_tier,
        newPlan: planTier,
        planOverrideUntil: overrideUntil?.toISOString() ?? null,
        ...(parsedTrialEndsAt ? { trialEndsAt: parsedTrialEndsAt.toISOString() } : {}),
        ...stripeMeta,
      },
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    return c.json({
      message: "Plan updated.",
      workspaceId,
      planTier,
      planOverrideUntil: overrideUntil?.toISOString() ?? null,
      ...(parsedTrialEndsAt ? { trialEndsAt: parsedTrialEndsAt.toISOString() } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    }, 200);
  }), { label: "change workspace plan" });
});

// ── Platform stats ───────────────────────────────────────────────────

platformAdmin.openapi(platformStatsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
    }

    const [wsRows, userRows, queryRows] = yield* Effect.promise(() => Promise.all([
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
    ]));

    // MRR: sum of PLAN_MRR for each active workspace's plan tier
    const mrrRows = yield* queryEffect<{ plan_tier: string; cnt: number }>(
      `SELECT plan_tier, COUNT(*)::int AS cnt FROM organization WHERE workspace_status = 'active' GROUP BY plan_tier`,
    );
    // Unknown tiers fall back to 0 to stay forward-compat during a staged
    // tier rename (code deploys before the migration applies on every
    // region). The reducer still emits a log.warn so the silent $0 trap
    // that let #1680 hide for months leaves a breadcrumb this time. Dedup
    // via a per-call Set so log volume is O(distinct unknown tiers).
    const seenUnknown = new Set<string>();
    const mrr = mrrRows.reduce((sum, row) => {
      const price = PLAN_MRR[row.plan_tier as PlanTier];
      if (price === undefined) {
        if (!seenUnknown.has(row.plan_tier)) {
          seenUnknown.add(row.plan_tier);
          log.warn(
            { planTier: row.plan_tier, cnt: row.cnt, requestId },
            "Unknown plan_tier in MRR calculation — contributing $0",
          );
        }
        return sum;
      }
      return sum + price * row.cnt;
    }, 0);

    return c.json({
      totalWorkspaces: wsRows[0]?.total ?? 0,
      activeWorkspaces: wsRows[0]?.active ?? 0,
      suspendedWorkspaces: wsRows[0]?.suspended ?? 0,
      totalUsers: userRows[0]?.count ?? 0,
      totalQueries24h: queryRows[0]?.count ?? 0,
      mrr,
    }, 200);
  }), { label: "compute platform stats" });
});

// ── Platform overview (deployment-wide scaffold + pool warnings) ───

platformAdmin.openapi(platformOverviewRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    // Deployment-scaffold entity discovery — what the API container ships
    // on disk, NOT what any given workspace has imported. Workspace-scoped
    // counts live on `/api/v1/admin/overview` and read through the
    // admin-source overlay. The `__global__` org-id is intentional: it
    // routes `getSemanticRoot` to the base disk root (no per-org overlay).
    const root = getSemanticRoot();
    const { entities, warnings } = discoverEntities(root);

    // Plugin registry is process-global today (not per-org). Surfaced
    // here so the operator-facing dashboard reflects what's loaded into
    // the running container. `/admin/overview` also surfaces a plugin
    // count for now — but that tile is hidden on SaaS (handled in web).
    const pluginList = plugins.describe();

    const poolWarnings = connections.getPoolWarnings();

    // `types` and `status` come back from the registry as branded enums;
    // widen to plain strings to match `PlatformOverviewSchema`'s wire
    // shape (the schema can't depend on plugin-SDK types — they're not
    // exported through `@useatlas/types`).
    return c.json({
      entities: entities.length,
      plugins: pluginList.length,
      pluginHealth: pluginList.map((p) => ({
        id: p.id,
        name: p.name,
        types: [...p.types] as string[],
        status: p.status as string,
      })),
      ...(warnings.length > 0 && { warnings }),
      ...(poolWarnings.length > 0 && { poolWarnings }),
      requestId,
    }, 200);
  }), { label: "platform overview" });
});

// ── Noisy neighbors ──────────────────────────────────────────────────

platformAdmin.openapi(noisyNeighborsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_configured", message: "Internal database not configured.", requestId }, 404);
    }

    // Get current period usage for each active workspace
    const rows = yield* queryEffect<{
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
  }), { label: "detect noisy neighbors" });
});

export { platformAdmin };
