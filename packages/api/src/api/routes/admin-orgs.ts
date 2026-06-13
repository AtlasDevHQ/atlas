/**
 * Admin organization management routes.
 *
 * Mounted under /api/v1/admin/organizations. Platform-admin only (see
 * createPlatformRouter). Provides cross-tenant workspace lifecycle CRUD —
 * list, get, stats, status, suspend/activate, plan tier, soft-delete.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { createLogger } from "@atlas/api/lib/logger";
import {
  hasInternalDB,
  internalQuery,
  queryEffect,
  getWorkspaceDetails,
  updateWorkspaceStatus,
  updateWorkspacePlanTier,
  setWorkspaceTrialEndsAt,
  cascadeWorkspaceDelete,
  getWorkspaceHealthSummary,
  type PlanTier,
} from "@atlas/api/lib/db/internal";
import { connections } from "@atlas/api/lib/db/connection";
import { flushCache } from "@atlas/api/lib/cache/index";
import { invalidatePlanCache } from "@atlas/api/lib/billing/enforcement";
import { PLAN_OVERRIDE_DAYS } from "@atlas/api/lib/billing/plans";
import {
  cancelStripeSubscriptionsForWorkspace,
  pauseStripeCollectionForWorkspace,
  resumeStripeCollectionForWorkspace,
  stripeAuditMetadata,
  withWarnings,
} from "@atlas/api/lib/billing/workspace-teardown";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { checkAbuseStatus } from "@atlas/api/lib/security/abuse";
import { ABUSE_LEVELS, PLAN_TIERS } from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema, createIdParamSchema } from "./shared-schemas";
import { createPlatformRouter } from "./admin-router";

const log = createLogger("admin-orgs");


// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------


const OrgIdParamSchema = createIdParamSchema("org_abc123");

// In-memory abuse-detector verdict from `checkAbuseStatus`. Independent
// of `workspaceStatus` (DB column flipped by admin actions) — that
// divergence is the bug this field exists to surface (#2269). Default
// `"none"` consolidates the missing-field coercion at the Zod boundary
// so consumers don't each re-derive "missing == none."
const AbuseLevelEnum = z.enum(ABUSE_LEVELS).default("none");

const OrgSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  logo: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  memberCount: z.number(),
  workspaceStatus: z.string(),
  planTier: z.string(),
  suspendedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  abuseLevel: AbuseLevelEnum,
});

const OrgDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  logo: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  workspaceStatus: z.string(),
  planTier: z.string(),
  suspendedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  abuseLevel: AbuseLevelEnum,
});

const MemberSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  role: z.string(),
  createdAt: z.string(),
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
  }),
});

const InvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string(),
  status: z.string(),
  inviterId: z.string(),
  expiresAt: z.string(),
  createdAt: z.string(),
});

const OrgStatsSchema = z.object({
  members: z.number(),
  conversations: z.number(),
  queries: z.number(),
});

const WorkspaceActionResponseSchema = z.object({
  message: z.string(),
  organization: z.unknown(),
  // Stripe teardown failures surface to the operator for manual follow-up
  // in the Stripe dashboard (#3459) — never stranded silently.
  warnings: z.array(z.string()).optional(),
});

const DeleteCascadeSchema = z.object({
  message: z.string(),
  cascade: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()).optional(),
});

const WorkspaceHealthSchema = z.object({
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    workspaceStatus: z.string(),
    planTier: z.string(),
    suspendedAt: z.unknown().nullable(),
    deletedAt: z.unknown().nullable(),
    createdAt: z.string(),
  }),
  health: z.object({
    members: z.unknown(),
    conversations: z.unknown(),
    queriesLast24h: z.unknown(),
    connections: z.unknown(),
    scheduledTasks: z.unknown(),
    poolMetrics: z.array(z.unknown()),
  }),
});

const ConflictErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});

const UpdatePlanBodySchema = z.object({
  planTier: z.string().openapi({ example: "starter" }),
  // #3427 — an operator plan change overrides Stripe for a bounded window so
  // the next webhook can't clobber the grant. Pass 0 to clear the override.
  overrideDays: z.number().int().min(0).max(365).optional().openapi({
    description:
      "Days the operator grant takes precedence over Stripe before auto-healing. Defaults to 90. Pass 0 to clear the override.",
    example: 90,
  }),
  // #3427 — setting `trial` requires an explicit future end date (a stale
  // trial_ends_at expires instantly). Also the trial-extension surface.
  trialEndsAt: z.string().datetime().optional().openapi({
    description: "Required when planTier is 'trial' — new trial end date (ISO 8601). Ignored otherwise.",
    example: "2026-08-01T00:00:00.000Z",
  }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listOrgsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Organizations"],
  summary: "List organizations",
  description:
    "Returns all organizations with member counts, workspace status, and plan tiers. Ordered by creation date descending.",
  responses: {
    200: {
      description: "List of organizations",
      content: {
        "application/json": {
          schema: z.object({
            organizations: z.array(OrgSummarySchema),
            total: z.number(),
          }),
        },
      },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — platform admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getOrgRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin — Organizations"],
  summary: "Get organization details",
  description:
    "Returns full organization details including members and pending invitations.",
  request: {
    params: OrgIdParamSchema,
  },
  responses: {
    200: {
      description: "Organization details with members and invitations",
      content: {
        "application/json": {
          schema: z.object({
            organization: OrgDetailSchema,
            members: z.array(MemberSchema),
            invitations: z.array(InvitationSchema),
          }),
        },
      },
    },
    400: {
      description: "Invalid organization ID",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — platform admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Organization not found or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getOrgStatsRoute = createRoute({
  method: "get",
  path: "/{id}/stats",
  tags: ["Admin — Organizations"],
  summary: "Get organization stats",
  description:
    "Returns aggregate stats for an organization: member count, conversation count, and audit query count.",
  request: {
    params: OrgIdParamSchema,
  },
  responses: {
    200: {
      description: "Organization statistics",
      content: { "application/json": { schema: OrgStatsSchema } },
    },
    400: {
      description: "Invalid organization ID",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — platform admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const suspendOrgRoute = createRoute({
  method: "patch",
  path: "/{id}/suspend",
  tags: ["Admin — Organizations"],
  summary: "Suspend organization",
  description:
    "Suspends a workspace, blocking all queries until reactivation. Drains connection pools for the organization.",
  request: {
    params: OrgIdParamSchema,
  },
  responses: {
    200: {
      description: "Workspace suspended",
      content: { "application/json": { schema: WorkspaceActionResponseSchema } },
    },
    400: {
      description: "Invalid organization ID",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — platform admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Organization not found or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Conflict — workspace already suspended or deleted",
      content: { "application/json": { schema: ConflictErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const activateOrgRoute = createRoute({
  method: "patch",
  path: "/{id}/activate",
  tags: ["Admin — Organizations"],
  summary: "Activate organization",
  description:
    "Reactivates a suspended workspace, resuming normal operations.",
  request: {
    params: OrgIdParamSchema,
  },
  responses: {
    200: {
      description: "Workspace activated",
      content: { "application/json": { schema: WorkspaceActionResponseSchema } },
    },
    400: {
      description: "Invalid organization ID",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — platform admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Organization not found or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Conflict — workspace already active or deleted",
      content: { "application/json": { schema: ConflictErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const deleteOrgRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — Organizations"],
  summary: "Delete organization",
  description:
    "Soft-deletes a workspace with cascading cleanup: drains connection pools, flushes cache, removes associated data, and marks the workspace as deleted.",
  request: {
    params: OrgIdParamSchema,
  },
  responses: {
    200: {
      description: "Workspace deleted with cascade summary",
      content: { "application/json": { schema: DeleteCascadeSchema } },
    },
    400: {
      description: "Invalid organization ID",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — platform admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Organization not found or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Conflict — workspace already deleted",
      content: { "application/json": { schema: ConflictErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getOrgStatusRoute = createRoute({
  method: "get",
  path: "/{id}/status",
  tags: ["Admin — Organizations"],
  summary: "Workspace health summary",
  description:
    "Returns a health summary for a workspace including member count, conversation count, recent queries, connection status, scheduled tasks, and pool metrics.",
  request: {
    params: OrgIdParamSchema,
  },
  responses: {
    200: {
      description: "Workspace health summary",
      content: { "application/json": { schema: WorkspaceHealthSchema } },
    },
    400: {
      description: "Invalid organization ID",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — platform admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Organization not found or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const updatePlanRoute = createRoute({
  method: "patch",
  path: "/{id}/plan",
  tags: ["Admin — Organizations"],
  summary: "Update organization plan",
  description:
    "Updates the plan tier for a workspace. Valid tiers: free, trial, starter, pro, business (plus the internal 'locked' tier for a lapsed subscription).",
  request: {
    params: OrgIdParamSchema,
    body: {
      content: {
        "application/json": {
          schema: UpdatePlanBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Plan tier updated",
      content: { "application/json": { schema: WorkspaceActionResponseSchema } },
    },
    400: {
      description: "Invalid organization ID or invalid plan tier",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — platform admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Organization not found or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Conflict — workspace is deleted",
      content: { "application/json": { schema: ConflictErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Extract the client IP the same way platform-admin.ts does so both
 * surfaces stamp `admin_action_log.ip_address` identically — required
 * for F-31 parity (#1786).
 */
function clientIpFor(c: Context): string | null {
  return c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
}

const adminOrgs = createPlatformRouter();

// GET / — list all organizations
adminOrgs.openapi(listOrgsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    const [orgs, memberCounts] = yield* Effect.promise(() => Promise.all([
      internalQuery<Record<string, unknown>>(
        `SELECT id, name, slug, logo, metadata, "createdAt", workspace_status, plan_tier, suspended_at, deleted_at FROM organization ORDER BY "createdAt" DESC`,
      ),
      internalQuery<{ organization_id: string; count: number }>(
        `SELECT "organizationId" as organization_id, COUNT(*)::int as count FROM member GROUP BY "organizationId"`,
      ),
    ]));
    const countMap = new Map(memberCounts.map((r) => [r.organization_id, r.count]));

    const result = orgs.map((o) => ({
      id: o.id as string, name: o.name as string, slug: o.slug as string,
      logo: (o.logo as string) ?? null, metadata: (o.metadata as Record<string, unknown>) ?? null,
      createdAt: String(o.createdAt), memberCount: countMap.get(o.id as string) ?? 0,
      workspaceStatus: (o.workspace_status as string) ?? "active", planTier: (o.plan_tier as string) ?? "free",
      suspendedAt: o.suspended_at ? String(o.suspended_at) : null, deletedAt: o.deleted_at ? String(o.deleted_at) : null,
      abuseLevel: checkAbuseStatus(o.id as string).level,
    }));

    return c.json({ organizations: result, total: result.length }, 200);
  }), { label: "list organizations" });
});

// GET /:id — get organization details with members
adminOrgs.openapi(getOrgRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { id: orgId } = c.req.valid("param");
    if (!hasInternalDB()) return c.json({ error: "not_available", message: "No internal database configured." }, 404);

    const orgs = yield* queryEffect<Record<string, unknown>>(
      `SELECT id, name, slug, logo, metadata, "createdAt", workspace_status, plan_tier, suspended_at, deleted_at FROM organization WHERE id = $1`, [orgId],
    );
    if (orgs.length === 0) return c.json({ error: "not_found", message: "Organization not found." }, 404);
    const org = orgs[0];

    const [members, invitations] = yield* Effect.promise(() => Promise.all([
      internalQuery<Record<string, unknown>>(`SELECT m.id, m."organizationId", m."userId", m.role, m."createdAt", u.name as user_name, u.email as user_email, u.image as user_image FROM member m LEFT JOIN "user" u ON m."userId" = u.id WHERE m."organizationId" = $1 ORDER BY m."createdAt" ASC`, [orgId]),
      internalQuery<Record<string, unknown>>(`SELECT id, email, role, status, "inviterId", "expiresAt", "createdAt" FROM invitation WHERE "organizationId" = $1 ORDER BY "createdAt" DESC`, [orgId]),
    ]));

    return c.json({
      organization: { id: org.id as string, name: org.name as string, slug: org.slug as string, logo: (org.logo as string) ?? null, metadata: (org.metadata as Record<string, unknown>) ?? null, createdAt: String(org.createdAt), workspaceStatus: (org.workspace_status as string) ?? "active", planTier: (org.plan_tier as string) ?? "free", suspendedAt: org.suspended_at ? String(org.suspended_at) : null, deletedAt: org.deleted_at ? String(org.deleted_at) : null, abuseLevel: checkAbuseStatus(org.id as string).level },
      members: members.map((m) => ({ id: m.id as string, organizationId: m.organizationId as string, userId: m.userId as string, role: m.role as string, createdAt: String(m.createdAt), user: { id: m.userId as string, name: (m.user_name as string) ?? "", email: (m.user_email as string) ?? "", image: (m.user_image as string) ?? null } })),
      invitations: invitations.map((i) => ({ id: i.id as string, email: i.email as string, role: i.role as string, status: i.status as string, inviterId: i.inviterId as string, expiresAt: String(i.expiresAt), createdAt: String(i.createdAt) })),
    }, 200);
  }), { label: "get organization" });
});

// GET /:id/stats
adminOrgs.openapi(getOrgStatsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { id: orgId } = c.req.valid("param");
    if (!hasInternalDB()) return c.json({ error: "not_available", message: "No internal database configured." }, 404);

    const [memberRows, convRows, queryRows] = yield* Effect.promise(() => Promise.all([
      internalQuery<{ count: number }>(`SELECT COUNT(*)::int as count FROM member WHERE "organizationId" = $1`, [orgId]),
      internalQuery<{ count: number }>(`SELECT COUNT(*)::int as count FROM conversations WHERE org_id = $1`, [orgId]),
      internalQuery<{ count: number }>(`SELECT COUNT(*)::int as count FROM audit_log WHERE org_id = $1`, [orgId]),
    ]));

    return c.json({ members: memberRows[0]?.count ?? 0, conversations: convRows[0]?.count ?? 0, queries: queryRows[0]?.count ?? 0 }, 200);
  }), { label: "get org stats" });
});

// PATCH /:id/suspend
adminOrgs.openapi(suspendOrgRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;
    const { id: orgId } = c.req.valid("param");
    if (!hasInternalDB()) return c.json({ error: "not_available", message: "No internal database configured." }, 404);

    const workspace = yield* Effect.promise(() => getWorkspaceDetails(orgId));
    if (!workspace) return c.json({ error: "not_found", message: "Organization not found." }, 404);
    if (workspace.workspace_status === "deleted") return c.json({ error: "conflict", message: "Cannot suspend a deleted workspace." }, 409);
    if (workspace.workspace_status === "suspended") return c.json({ error: "conflict", message: "Workspace is already suspended." }, 409);

    // Operator/manual suspension (#3424): a billing recovery must NOT clear
    // this — only suspensions sourced 'billing' are auto-recovered.
    yield* Effect.promise(() => updateWorkspaceStatus(orgId, "suspended", "operator"));
    // Drop the cached `getCachedWorkspace` entry so the next user-side
    // request sees the new status within its TTL window (#2165).
    invalidatePlanCache(orgId);
    // Suspension billing policy (#3425, wired here by #3459): pause Stripe
    // payment collection — a suspended workspace can't use the product, so
    // it must not keep being invoiced/dunned. The subscription stays alive
    // so activating restores billing. Stripe failures surface as operator
    // warnings; the suspend stands.
    const billing = yield* Effect.promise(() => pauseStripeCollectionForWorkspace(orgId));
    // Audit the mutation commit BEFORE the pool drain — a transient
    // `drainOrg` rejection must not silently drop the audit row after
    // the DB already flipped to suspended. Drain failure still fails
    // the response (the caller retries); the audit trail persists.
    logAdminAction({
      actionType: ADMIN_ACTIONS.workspace.suspend,
      targetType: "workspace",
      targetId: orgId,
      scope: "platform",
      metadata: stripeAuditMetadata(billing),
      ipAddress: clientIpFor(c),
    });
    if (connections.isOrgPoolingEnabled()) yield* Effect.promise(() => connections.drainOrg(orgId));

    log.info({ orgId, requestId, admin: user?.id, stripe: billing }, "Workspace suspended");
    const updated = yield* Effect.promise(() => getWorkspaceDetails(orgId));
    return c.json({ message: "Workspace suspended. All queries are blocked until reactivation.", organization: updated, ...withWarnings(billing) }, 200);
  }), { label: "suspend workspace" });
});

// PATCH /:id/activate
adminOrgs.openapi(activateOrgRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;
    const { id: orgId } = c.req.valid("param");
    if (!hasInternalDB()) return c.json({ error: "not_available", message: "No internal database configured." }, 404);

    const workspace = yield* Effect.promise(() => getWorkspaceDetails(orgId));
    if (!workspace) return c.json({ error: "not_found", message: "Organization not found." }, 404);
    if (workspace.workspace_status === "deleted") return c.json({ error: "conflict", message: "Cannot activate a deleted workspace." }, 409);
    if (workspace.workspace_status === "active") return c.json({ error: "conflict", message: "Workspace is already active." }, 409);

    yield* Effect.promise(() => updateWorkspaceStatus(orgId, "active"));
    invalidatePlanCache(orgId); // #2165 — see suspend handler above
    // Resume Stripe payment collection paused at suspension time (#3459) —
    // see the suspend handler above for the pause-collection policy.
    const billing = yield* Effect.promise(() => resumeStripeCollectionForWorkspace(orgId));
    log.info({ orgId, requestId, admin: user?.id, stripe: billing }, "Workspace activated");
    // Canonical action_type is `workspace.unsuspend` (not
    // `workspace.activate`) — the endpoint path deliberately differs
    // from the audit event so compliance queries filtering on a single
    // action_type catch both the platform-admin and admin-orgs paths.
    logAdminAction({
      actionType: ADMIN_ACTIONS.workspace.unsuspend,
      targetType: "workspace",
      targetId: orgId,
      scope: "platform",
      metadata: stripeAuditMetadata(billing),
      ipAddress: clientIpFor(c),
    });
    const updated = yield* Effect.promise(() => getWorkspaceDetails(orgId));
    return c.json({ message: "Workspace activated. Normal operations resumed.", organization: updated, ...withWarnings(billing) }, 200);
  }), { label: "activate workspace" });
});

// DELETE /:id
adminOrgs.openapi(deleteOrgRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;
    const { id: orgId } = c.req.valid("param");
    if (!hasInternalDB()) return c.json({ error: "not_available", message: "No internal database configured." }, 404);

    const workspace = yield* Effect.promise(() => getWorkspaceDetails(orgId));
    if (!workspace) return c.json({ error: "not_found", message: "Organization not found." }, 404);
    if (workspace.workspace_status === "deleted") return c.json({ error: "conflict", message: "Workspace is already deleted." }, 409);

    // Asymmetry with PATCH /:id/suspend (fail-closed on drain) is intentional:
    // delete is a one-shot destructive cascade; failing the entire operation
    // on a transient drain error would leave the workspace in an unclear
    // half-dirty state. Instead we surface the failure on the response and
    // log at `error` so it's visible in Sentry rather than buried in `warn`.
    const warnings: string[] = [];
    let poolsDrained = 0;
    if (connections.isOrgPoolingEnabled()) {
      const drainResult = yield* Effect.tryPromise({
        try: () => connections.drainOrg(orgId),
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(Effect.either);
      if (drainResult._tag === "Right") {
        poolsDrained = drainResult.right.drained;
      } else {
        log.error({ orgId, requestId, err: drainResult.left.message }, "Failed to drain org pools during delete — continuing with cascade");
        warnings.push(`pool_drain_failed: ${drainResult.left.message}`);
      }
    }
    flushCache();

    // Cancel Stripe billing BEFORE the cascade (#3425, wired here by
    // #3459): a deleted org must stop invoicing even if the cascade below
    // fails, and the @better-auth/stripe plugin's own guard blocks
    // user-initiated org deletion while subscriptions exist — this
    // direct-DB path honors the same ordering rather than bypassing it.
    // Stripe failures join the existing `warnings` array; delete proceeds.
    const billing = yield* Effect.promise(() => cancelStripeSubscriptionsForWorkspace(orgId));
    warnings.push(...billing.warnings);

    const cascade = yield* Effect.tryPromise({
      try: () => cascadeWorkspaceDelete(orgId),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });
    yield* Effect.tryPromise({
      try: () => updateWorkspaceStatus(orgId, "deleted"),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });
    invalidatePlanCache(orgId); // #2165 — see suspend handler above

    log.info({ orgId, requestId, admin: user?.id, cascade, poolsDrained, warnings, stripe: billing }, "Workspace soft-deleted with cascading cleanup");
    // `cleanup` mirrors platform-admin.ts. `poolsDrained`/`warnings`
    // are additive — admin-orgs drains pools, platform-admin doesn't.
    logAdminAction({
      actionType: ADMIN_ACTIONS.workspace.delete,
      targetType: "workspace",
      targetId: orgId,
      scope: "platform",
      metadata: {
        cleanup: cascade,
        poolsDrained,
        ...stripeAuditMetadata(billing),
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      ipAddress: clientIpFor(c),
    });
    return c.json({
      message: warnings.length > 0
        ? "Workspace deleted, but cleanup was partial — see warnings."
        : "Workspace deleted. All associated data has been cleaned up.",
      cascade: { poolsDrained, ...cascade },
      ...(warnings.length > 0 ? { warnings } : {}),
    }, 200);
  }), { label: "delete workspace" });
});

// GET /:id/status
adminOrgs.openapi(getOrgStatusRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { id: orgId } = c.req.valid("param");
    if (!hasInternalDB()) return c.json({ error: "not_available", message: "No internal database configured." }, 404);

    const summary = yield* Effect.promise(() => getWorkspaceHealthSummary(orgId));
    if (!summary) return c.json({ error: "not_found", message: "Organization not found." }, 404);

    const poolMetrics = connections.isOrgPoolingEnabled() ? connections.getOrgPoolMetrics(orgId) : [];
    return c.json({
      workspace: { id: summary.workspace.id, name: summary.workspace.name, slug: summary.workspace.slug, workspaceStatus: summary.workspace.workspace_status, planTier: summary.workspace.plan_tier, suspendedAt: summary.workspace.suspended_at, deletedAt: summary.workspace.deleted_at, createdAt: String(summary.workspace.createdAt) },
      health: { members: summary.members, conversations: summary.conversations, queriesLast24h: summary.queriesLast24h, connections: summary.connections, scheduledTasks: summary.scheduledTasks, poolMetrics },
    }, 200);
  }), { label: "get workspace status" });
});

// PATCH /:id/plan
// Derived from the shared tuple so a new tier in @useatlas/types is
// accepted here without another hand-copied list to drift. The platform
// override deliberately accepts EVERY tier including "locked" — operators
// use it to manually lock/unlock workspaces.
const VALID_PLAN_TIERS = new Set<PlanTier>(PLAN_TIERS);

adminOrgs.openapi(updatePlanRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;
    const { id: orgId } = c.req.valid("param");
    if (!hasInternalDB()) return c.json({ error: "not_available", message: "No internal database configured." }, 404);

    const body = c.req.valid("json");
    if (!body.planTier || !VALID_PLAN_TIERS.has(body.planTier as PlanTier)) {
      return c.json({ error: "bad_request", message: `Invalid plan tier. Must be one of: ${[...VALID_PLAN_TIERS].join(", ")}` }, 400);
    }
    const planTier = body.planTier as PlanTier;

    // #3427 — setting `trial` requires an explicit, future end date (a stale
    // trial_ends_at would expire instantly). Doubles as the trial-extension
    // surface: set planTier="trial" with a future date to extend a trial.
    let parsedTrialEndsAt: Date | null = null;
    if (planTier === "trial") {
      if (!body.trialEndsAt) {
        return c.json({ error: "bad_request", message: "Setting the 'trial' tier requires an explicit trialEndsAt (ISO 8601) — a stale trial_ends_at would expire instantly." }, 400);
      }
      parsedTrialEndsAt = new Date(body.trialEndsAt);
      if (Number.isNaN(parsedTrialEndsAt.getTime())) {
        return c.json({ error: "bad_request", message: `Invalid trialEndsAt: ${body.trialEndsAt}` }, 400);
      }
      if (parsedTrialEndsAt.getTime() <= Date.now()) {
        return c.json({ error: "bad_request", message: "trialEndsAt must be in the future." }, 400);
      }
    }

    const workspace = yield* Effect.promise(() => getWorkspaceDetails(orgId));
    if (!workspace) return c.json({ error: "not_found", message: "Organization not found." }, 404);
    if (workspace.workspace_status === "deleted") return c.json({ error: "conflict", message: "Cannot update plan for a deleted workspace." }, 409);

    const previousPlan = workspace.plan_tier;

    // #3427 — operator plan change OVERRIDES Stripe for a bounded window so the
    // next webhook can't clobber the grant. `overrideDays === 0` clears it.
    // EXCEPTION (#3427 review): a `trial` grant must NOT stamp an override — a
    // trialing org has no competing subscription, so an override would only
    // block the customer's own paid conversion (charged by Stripe, stranded on
    // trial). Trial protection is the trial_ends_at window; clear it for trial.
    const days = planTier === "trial" ? 0 : (body.overrideDays ?? PLAN_OVERRIDE_DAYS);
    const overrideUntil: Date | null = days === 0 ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const override = days === 0 ? ("clear" as const) : { until: overrideUntil as Date };

    yield* Effect.promise(() => updateWorkspacePlanTier(orgId, planTier, override));

    if (parsedTrialEndsAt) {
      const stamped = yield* Effect.promise(() => setWorkspaceTrialEndsAt(orgId, parsedTrialEndsAt));
      if (!stamped) {
        log.warn({ orgId, requestId }, "Plan set to trial but trial_ends_at write matched 0 rows — workspace vanished mid-request?");
      }
    }

    // #3427 — downgrading a paying org to free/locked must STOP Stripe
    // invoicing. Best-effort: Stripe failures surface as operator warnings;
    // the plan change always proceeds (same pattern as suspend/delete teardown).
    let warnings: string[] = [];
    let stripeMeta: Record<string, unknown> = {};
    if (planTier === "free" || planTier === "locked") {
      const billing = yield* Effect.promise(() => cancelStripeSubscriptionsForWorkspace(orgId));
      warnings = withWarnings(billing).warnings ?? [];
      stripeMeta = stripeAuditMetadata(billing);
    }

    invalidatePlanCache(orgId);
    log.info(
      { orgId, requestId, admin: user?.id, planTier, planOverrideUntil: overrideUntil?.toISOString() ?? null },
      "Workspace plan tier updated",
    );
    logAdminAction({
      actionType: ADMIN_ACTIONS.workspace.changePlan,
      targetType: "workspace",
      targetId: orgId,
      scope: "platform",
      metadata: {
        previousPlan,
        newPlan: planTier,
        planOverrideUntil: overrideUntil?.toISOString() ?? null,
        ...(parsedTrialEndsAt ? { trialEndsAt: parsedTrialEndsAt.toISOString() } : {}),
        ...stripeMeta,
      },
      ipAddress: clientIpFor(c),
    });

    const updated = yield* Effect.promise(() => getWorkspaceDetails(orgId));
    return c.json({ message: `Plan tier updated to ${planTier}.`, organization: updated, ...(warnings.length > 0 ? { warnings } : {}) }, 200);
  }), { label: "update plan tier" });
});

export { adminOrgs };
