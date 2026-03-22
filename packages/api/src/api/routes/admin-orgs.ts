/**
 * Admin organization management routes.
 *
 * Mounted under /api/v1/admin/organizations. All routes require admin role.
 * Provides CRUD for organizations and their members (platform admin view).
 */

import { Hono } from "hono";
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

function isValidOrgId(id: string | undefined): id is string {
  return !!id && id.length > 0 && id.length <= MAX_ID_LENGTH;
}

const adminOrgs = new Hono();

// ---------------------------------------------------------------------------
// GET / — list all organizations (platform admin view)
// ---------------------------------------------------------------------------

adminOrgs.get("/", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
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

      return c.json({ organizations: result, total: result.length });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to list organizations");
      return c.json({ error: "internal_error", message: "Failed to list organizations." }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:id — get organization details with members
// ---------------------------------------------------------------------------

adminOrgs.get("/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const orgId = c.req.param("id");

  if (!isValidOrgId(orgId)) {
    return c.json({ error: "bad_request", message: "Invalid organization ID." }, 400);
  }

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
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
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to get organization");
      return c.json({ error: "internal_error", message: "Failed to get organization." }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:id/stats — org stats (conversations, members, queries)
// ---------------------------------------------------------------------------

adminOrgs.get("/:id/stats", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const orgId = c.req.param("id");

  if (!isValidOrgId(orgId)) {
    return c.json({ error: "bad_request", message: "Invalid organization ID." }, 400);
  }

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
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
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to get org stats");
      return c.json({ error: "internal_error", message: "Failed to get organization stats." }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// PATCH /:id/suspend — suspend a workspace
// ---------------------------------------------------------------------------

adminOrgs.patch("/:id/suspend", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const orgId = c.req.param("id");

  if (!isValidOrgId(orgId)) {
    return c.json({ error: "bad_request", message: "Invalid organization ID." }, 400);
  }

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
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
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to suspend workspace");
      return c.json({ error: "internal_error", message: "Failed to suspend workspace.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// PATCH /:id/activate — reactivate a suspended workspace
// ---------------------------------------------------------------------------

adminOrgs.patch("/:id/activate", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const orgId = c.req.param("id");

  if (!isValidOrgId(orgId)) {
    return c.json({ error: "bad_request", message: "Invalid organization ID." }, 400);
  }

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
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
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to activate workspace");
      return c.json({ error: "internal_error", message: "Failed to activate workspace.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id — soft-delete a workspace with cascading cleanup
// ---------------------------------------------------------------------------

adminOrgs.delete("/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const orgId = c.req.param("id");

  if (!isValidOrgId(orgId)) {
    return c.json({ error: "bad_request", message: "Invalid organization ID." }, 400);
  }

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
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
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to delete workspace");
      return c.json({ error: "internal_error", message: "Failed to delete workspace.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:id/status — workspace health summary
// ---------------------------------------------------------------------------

adminOrgs.get("/:id/status", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const orgId = c.req.param("id");

  if (!isValidOrgId(orgId)) {
    return c.json({ error: "bad_request", message: "Invalid organization ID." }, 400);
  }

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
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
      });
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

adminOrgs.patch("/:id/plan", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();
  const orgId = c.req.param("id");

  if (!isValidOrgId(orgId)) {
    return c.json({ error: "bad_request", message: "Invalid organization ID." }, 400);
  }

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    let body: { planTier?: string };
    try {
      body = await c.req.json();
    } catch (err) {
      log.debug({ err: err instanceof Error ? err.message : String(err) }, "Invalid JSON in plan tier update");
      return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
    }

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
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to update plan tier");
      return c.json({ error: "internal_error", message: "Failed to update plan tier.", requestId }, 500);
    }
  });
});

export { adminOrgs };
