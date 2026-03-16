/**
 * Admin organization management routes.
 *
 * Mounted under /api/v1/admin/organizations. All routes require admin role.
 * Provides CRUD for organizations and their members (platform admin view).
 */

import { Hono } from "hono";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  authenticateRequest,
  checkRateLimit,
  getClientIP,
} from "@atlas/api/lib/auth/middleware";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";

const log = createLogger("admin-orgs");

const MAX_ID_LENGTH = 128;

function isValidOrgId(id: string | undefined): id is string {
  return !!id && id.length > 0 && id.length <= MAX_ID_LENGTH;
}

const adminOrgs = new Hono();

// ---------------------------------------------------------------------------
// Admin auth preamble — reuses existing auth then enforces admin role.
// ---------------------------------------------------------------------------

async function adminAuthPreamble(req: Request, requestId: string) {
  let authResult: AuthResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), requestId },
      "Auth dispatch failed",
    );
    return { error: { error: "auth_error", message: "Authentication system error" }, status: 500 as const };
  }
  if (!authResult.authenticated) {
    return { error: { error: "auth_error", message: authResult.error }, status: authResult.status as 401 | 403 | 500 };
  }

  if (authResult.mode !== "none" && (!authResult.user || (authResult.user.role !== "admin" && authResult.user.role !== "owner"))) {
    return { error: { error: "forbidden", message: "Admin role required." }, status: 403 as const };
  }

  const ip = getClientIP(req);
  const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
    return {
      error: { error: "rate_limited", message: "Too many requests.", retryAfterSeconds },
      status: 429 as const,
      headers: { "Retry-After": String(retryAfterSeconds) },
    };
  }

  return { authResult };
}

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
          `SELECT id, name, slug, logo, metadata, "createdAt"
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
        `SELECT id, name, slug, logo, metadata, "createdAt"
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

export { adminOrgs };
