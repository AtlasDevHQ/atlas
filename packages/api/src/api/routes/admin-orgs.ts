/**
 * Admin organization management routes.
 *
 * Mounted under /api/v1/admin/organizations. All routes require admin role.
 * Provides CRUD for organizations and their members (platform admin view).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import {
  hasInternalDB,
  internalQuery,
  getWorkspaceDetails,
  updateWorkspaceStatus,
  updateWorkspacePlanTier,
  cascadeWorkspaceDelete,
  getWorkspaceHealthSummary,
  type PlanTier,
} from "@atlas/api/lib/db/internal";
import { connections } from "@atlas/api/lib/db/connection";
import { flushCache } from "@atlas/api/lib/cache/index";
import { adminAuthPreamble } from "./admin-auth";
import { invalidatePlanCache } from "@atlas/api/lib/billing/enforcement";

const log = createLogger("admin-orgs");

const MAX_ID_LENGTH = 128;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
});

const AuthErrorSchema = z.record(z.string(), z.unknown());

const OrgIdParamSchema = z.object({
  id: z.string().min(1).max(MAX_ID_LENGTH).openapi({
    param: { name: "id", in: "path" },
    example: "org_abc123",
  }),
});

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
});

const DeleteCascadeSchema = z.object({
  message: z.string(),
  cascade: z.record(z.string(), z.unknown()),
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
  planTier: z.string().openapi({ example: "team" }),
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
      description: "Forbidden — admin role required",
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
      description: "Forbidden — admin role required",
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
      description: "Forbidden — admin role required",
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
      description: "Forbidden — admin role required",
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
      description: "Forbidden — admin role required",
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
      description: "Forbidden — admin role required",
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
      description: "Forbidden — admin role required",
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
    "Updates the plan tier for a workspace. Valid tiers: free, trial, team, enterprise.",
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
      description: "Forbidden — admin role required",
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

const adminOrgs = new OpenAPIHono();

adminOrgs.onError((err, c) => {
  if (err instanceof HTTPException && err.status === 400) {
    return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
  }
  throw err;
});

// ---------------------------------------------------------------------------
// GET / — list all organizations (platform admin view)
// ---------------------------------------------------------------------------

adminOrgs.openapi(listOrgsRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    try {
      const [orgs, memberCounts] = await Promise.all([
        internalQuery<Record<string, unknown>>(
          `SELECT id, name, slug, logo, metadata, "createdAt",
                  workspace_status, plan_tier, suspended_at, deleted_at
           FROM organization
           ORDER BY "createdAt" DESC`,
        ),
        internalQuery<{ organization_id: string; count: number }>(
          `SELECT "organizationId" as organization_id, COUNT(*)::int as count
           FROM member
           GROUP BY "organizationId"`,
        ),
      ]);
      const countMap = new Map(memberCounts.map((r) => [r.organization_id, r.count]));

      const result = orgs.map((o) => ({
        id: o.id as string,
        name: o.name as string,
        slug: o.slug as string,
        logo: (o.logo as string) ?? null,
        metadata: (o.metadata as Record<string, unknown>) ?? null,
        createdAt: String(o.createdAt),
        memberCount: countMap.get(o.id as string) ?? 0,
        workspaceStatus: (o.workspace_status as string) ?? "active",
        planTier: (o.plan_tier as string) ?? "free",
        suspendedAt: o.suspended_at ? String(o.suspended_at) : null,
        deletedAt: o.deleted_at ? String(o.deleted_at) : null,
      }));

      return c.json({ organizations: result, total: result.length }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to list organizations");
      return c.json({ error: "internal_error", message: "Failed to list organizations.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:id — get organization details with members
// ---------------------------------------------------------------------------

adminOrgs.openapi(getOrgRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const { id: orgId } = c.req.valid("param");

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    try {
      const orgs = await internalQuery<Record<string, unknown>>(
        `SELECT id, name, slug, logo, metadata, "createdAt",
                workspace_status, plan_tier, suspended_at, deleted_at
         FROM organization WHERE id = $1`,
        [orgId],
      );
      if (orgs.length === 0) {
        return c.json({ error: "not_found", message: "Organization not found." }, 404);
      }

      const org = orgs[0];

      // Get members and invitations in parallel
      const [members, invitations] = await Promise.all([
        internalQuery<Record<string, unknown>>(
          `SELECT m.id, m."organizationId", m."userId", m.role, m."createdAt",
                  u.name as user_name, u.email as user_email, u.image as user_image
           FROM member m
           LEFT JOIN "user" u ON m."userId" = u.id
           WHERE m."organizationId" = $1
           ORDER BY m."createdAt" ASC`,
          [orgId],
        ),
        internalQuery<Record<string, unknown>>(
          `SELECT id, email, role, status, "inviterId", "expiresAt", "createdAt"
           FROM invitation
           WHERE "organizationId" = $1
           ORDER BY "createdAt" DESC`,
          [orgId],
        ),
      ]);

      return c.json({
        organization: {
          id: org.id as string,
          name: org.name as string,
          slug: org.slug as string,
          logo: (org.logo as string) ?? null,
          metadata: (org.metadata as Record<string, unknown>) ?? null,
          createdAt: String(org.createdAt),
          workspaceStatus: (org.workspace_status as string) ?? "active",
          planTier: (org.plan_tier as string) ?? "free",
          suspendedAt: org.suspended_at ? String(org.suspended_at) : null,
          deletedAt: org.deleted_at ? String(org.deleted_at) : null,
        },
        members: members.map((m) => ({
          id: m.id as string,
          organizationId: m.organizationId as string,
          userId: m.userId as string,
          role: m.role as string,
          createdAt: String(m.createdAt),
          user: {
            id: m.userId as string,
            name: (m.user_name as string) ?? "",
            email: (m.user_email as string) ?? "",
            image: (m.user_image as string) ?? null,
          },
        })),
        invitations: invitations.map((i) => ({
          id: i.id as string,
          email: i.email as string,
          role: i.role as string,
          status: i.status as string,
          inviterId: i.inviterId as string,
          expiresAt: String(i.expiresAt),
          createdAt: String(i.createdAt),
        })),
      }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to get organization");
      return c.json({ error: "internal_error", message: "Failed to get organization.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:id/stats — org stats (conversations, members, queries)
// ---------------------------------------------------------------------------

adminOrgs.openapi(getOrgStatsRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const { id: orgId } = c.req.valid("param");

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    try {
      const [memberRows, convRows, queryRows] = await Promise.all([
        internalQuery<{ count: number }>(`SELECT COUNT(*)::int as count FROM member WHERE "organizationId" = $1`, [orgId]),
        internalQuery<{ count: number }>(`SELECT COUNT(*)::int as count FROM conversations WHERE org_id = $1`, [orgId]),
        internalQuery<{ count: number }>(`SELECT COUNT(*)::int as count FROM audit_log WHERE org_id = $1`, [orgId]),
      ]);

      return c.json({
        members: memberRows[0]?.count ?? 0,
        conversations: convRows[0]?.count ?? 0,
        queries: queryRows[0]?.count ?? 0,
      }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to get org stats");
      return c.json({ error: "internal_error", message: "Failed to get organization stats.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// PATCH /:id/suspend — suspend a workspace
// ---------------------------------------------------------------------------

adminOrgs.openapi(suspendOrgRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const { id: orgId } = c.req.valid("param");

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    try {
      const workspace = await getWorkspaceDetails(orgId);
      if (!workspace) {
        return c.json({ error: "not_found", message: "Organization not found." }, 404);
      }
      if (workspace.workspace_status === "deleted") {
        return c.json({ error: "conflict", message: "Cannot suspend a deleted workspace." }, 409);
      }
      if (workspace.workspace_status === "suspended") {
        return c.json({ error: "conflict", message: "Workspace is already suspended." }, 409);
      }

      await updateWorkspaceStatus(orgId, "suspended");

      // Drain org connection pools to free resources
      if (connections.isOrgPoolingEnabled()) {
        await connections.drainOrg(orgId);
      }

      log.info({ orgId, requestId, admin: authResult.user?.id }, "Workspace suspended");

      const updated = await getWorkspaceDetails(orgId);
      return c.json({
        message: "Workspace suspended. All queries are blocked until reactivation.",
        organization: updated,
      }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to suspend workspace");
      return c.json({ error: "internal_error", message: "Failed to suspend workspace.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// PATCH /:id/activate — reactivate a suspended workspace
// ---------------------------------------------------------------------------

adminOrgs.openapi(activateOrgRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const { id: orgId } = c.req.valid("param");

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    try {
      const workspace = await getWorkspaceDetails(orgId);
      if (!workspace) {
        return c.json({ error: "not_found", message: "Organization not found." }, 404);
      }
      if (workspace.workspace_status === "deleted") {
        return c.json({ error: "conflict", message: "Cannot activate a deleted workspace." }, 409);
      }
      if (workspace.workspace_status === "active") {
        return c.json({ error: "conflict", message: "Workspace is already active." }, 409);
      }

      await updateWorkspaceStatus(orgId, "active");

      log.info({ orgId, requestId, admin: authResult.user?.id }, "Workspace activated");

      const updated = await getWorkspaceDetails(orgId);
      return c.json({
        message: "Workspace activated. Normal operations resumed.",
        organization: updated,
      }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to activate workspace");
      return c.json({ error: "internal_error", message: "Failed to activate workspace.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id — soft-delete a workspace with cascading cleanup
// ---------------------------------------------------------------------------

adminOrgs.openapi(deleteOrgRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const { id: orgId } = c.req.valid("param");

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    try {
      const workspace = await getWorkspaceDetails(orgId);
      if (!workspace) {
        return c.json({ error: "not_found", message: "Organization not found." }, 404);
      }
      if (workspace.workspace_status === "deleted") {
        return c.json({ error: "conflict", message: "Workspace is already deleted." }, 409);
      }

      // 1. Drain connection pools (best-effort — don't block delete on pool errors)
      let poolsDrained = 0;
      if (connections.isOrgPoolingEnabled()) {
        try {
          const drainResult = await connections.drainOrg(orgId);
          poolsDrained = drainResult.drained;
        } catch (drainErr) {
          log.warn({ orgId, err: drainErr instanceof Error ? drainErr.message : String(drainErr) }, "Failed to drain org pools during delete — continuing with cascade");
        }
      }

      // 2. Flush entire cache (LRU backend doesn't support prefix deletion;
      //    full flush is acceptable since workspace deletes are rare admin operations)
      flushCache();

      // 3. Cascade database cleanup
      const cascade = await cascadeWorkspaceDelete(orgId);

      // 4. Mark workspace as deleted
      await updateWorkspaceStatus(orgId, "deleted");

      log.info(
        { orgId, requestId, admin: authResult.user?.id, cascade, poolsDrained },
        "Workspace soft-deleted with cascading cleanup",
      );

      return c.json({
        message: "Workspace deleted. All associated data has been cleaned up.",
        cascade: {
          poolsDrained,
          ...cascade,
        },
      }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to delete workspace");
      return c.json({ error: "internal_error", message: "Failed to delete workspace.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:id/status — workspace health summary
// ---------------------------------------------------------------------------

adminOrgs.openapi(getOrgStatusRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const { id: orgId } = c.req.valid("param");

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    try {
      const summary = await getWorkspaceHealthSummary(orgId);
      if (!summary) {
        return c.json({ error: "not_found", message: "Organization not found." }, 404);
      }

      // Include pool metrics if org pooling is enabled
      const poolMetrics = connections.isOrgPoolingEnabled()
        ? connections.getOrgPoolMetrics(orgId)
        : [];

      return c.json({
        workspace: {
          id: summary.workspace.id,
          name: summary.workspace.name,
          slug: summary.workspace.slug,
          workspaceStatus: summary.workspace.workspace_status,
          planTier: summary.workspace.plan_tier,
          suspendedAt: summary.workspace.suspended_at,
          deletedAt: summary.workspace.deleted_at,
          createdAt: String(summary.workspace.createdAt),
        },
        health: {
          members: summary.members,
          conversations: summary.conversations,
          queriesLast24h: summary.queriesLast24h,
          connections: summary.connections,
          scheduledTasks: summary.scheduledTasks,
          poolMetrics,
        },
      }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to get workspace status");
      return c.json({ error: "internal_error", message: "Failed to get workspace status.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// PATCH /:id/plan — update workspace plan tier
// ---------------------------------------------------------------------------

const VALID_PLAN_TIERS = new Set<PlanTier>(["free", "trial", "team", "enterprise"]);

adminOrgs.openapi(updatePlanRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const { id: orgId } = c.req.valid("param");

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    const body = c.req.valid("json");

    if (!body.planTier || !VALID_PLAN_TIERS.has(body.planTier as PlanTier)) {
      return c.json({ error: "bad_request", message: `Invalid plan tier. Must be one of: ${[...VALID_PLAN_TIERS].join(", ")}` }, 400);
    }

    try {
      const workspace = await getWorkspaceDetails(orgId);
      if (!workspace) {
        return c.json({ error: "not_found", message: "Organization not found." }, 404);
      }
      if (workspace.workspace_status === "deleted") {
        return c.json({ error: "conflict", message: "Cannot update plan for a deleted workspace." }, 409);
      }

      await updateWorkspacePlanTier(orgId, body.planTier as PlanTier);
      invalidatePlanCache(orgId);

      log.info({ orgId, requestId, admin: authResult.user?.id, planTier: body.planTier }, "Workspace plan tier updated");

      const updated = await getWorkspaceDetails(orgId);
      return c.json({
        message: `Plan tier updated to ${body.planTier}.`,
        organization: updated,
      }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to update plan tier");
      return c.json({ error: "internal_error", message: "Failed to update plan tier.", requestId }, 500);
    }
  });
});

export { adminOrgs };
