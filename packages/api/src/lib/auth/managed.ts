/**
 * Managed auth (Better Auth) — session validation.
 *
 * Checks cookies and bearer tokens via auth.api.getSession().
 * Returns AuthResult on success or missing session (never throws for
 * "no session" — returns { authenticated: false } instead).
 * Throws on infrastructure errors (DB unavailable, etc.);
 * callers (middleware.ts) are expected to catch.
 */

import type { AuthResult } from "@atlas/api/lib/auth/types";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { parseRole } from "@atlas/api/lib/auth/permissions";
import { getAuthInstance } from "@atlas/api/lib/auth/server";
import { createLogger } from "@atlas/api/lib/logger";
import { getSetting } from "@atlas/api/lib/settings";

const log = createLogger("auth:managed");

export async function validateManaged(req: Request): Promise<AuthResult> {
  const auth = getAuthInstance();

  // Debug: log whether cookies are present in the request
  const cookieHeader = req.headers.get("cookie");
  const hasSessionToken = cookieHeader?.includes("session_token") ?? false;
  const hasAuthorization = !!req.headers.get("authorization");
  if (!hasSessionToken && !hasAuthorization) {
    log.info({ url: req.url }, "No session_token cookie or Authorization header in request");
  } else {
    log.info({ hasSessionToken, hasAuthorization, url: req.url }, "Auth headers present");
  }

  const session = await auth.api.getSession({ headers: req.headers });

  if (!session) {
    log.info({ hasSessionToken, hasAuthorization }, "getSession returned null");
    return { authenticated: false, mode: "managed", status: 401, error: "Not signed in" };
  }

  const userId = session.user?.id;
  const email = session.user?.email;
  if (!userId) {
    log.error({ sessionExists: true }, "Session found but user.id is missing");
    return { authenticated: false, mode: "managed", status: 500, error: "Session data is incomplete" };
  }

  // Extract role from session user (set by Better Auth admin plugin, stored in the `role` column).
  // Falls back to default (member) when not present — see permissions.ts.
  const sessionUser = session.user as Record<string, unknown>;
  // Better Auth can store multiple roles as comma-separated strings; Atlas uses only the first.
  const rawRoleField = sessionUser?.role;
  const rawRole = typeof rawRoleField === "string" ? rawRoleField.split(",")[0].trim() : rawRoleField;
  let role: ReturnType<typeof parseRole>;
  if (typeof rawRole === "string") {
    role = parseRole(rawRole);
    if (rawRole && !role) {
      log.warn({ value: rawRole, validRoles: ["member", "admin", "owner"] }, "Session user role is not a valid Atlas role — defaulting to 'member'");
    }
  } else {
    role = undefined;
    if (rawRole !== undefined && rawRole !== null) {
      log.warn({ type: typeof rawRole }, "Session user role is not a string — ignoring");
    }
  }

  // Session timeout enforcement (idle + absolute)
  const sessionData = session.session as Record<string, unknown> | undefined;
  if (sessionData) {
    const now = Date.now();

    const idleRaw = parseInt(getSetting("ATLAS_SESSION_IDLE_TIMEOUT") ?? "0", 10);
    const idleTimeout = Number.isFinite(idleRaw) && idleRaw > 0 ? idleRaw : 0;
    if (idleTimeout > 0 && sessionData.updatedAt) {
      const updatedAt = new Date(sessionData.updatedAt as string).getTime();
      if (Number.isNaN(updatedAt)) {
        log.warn({ userId, updatedAt: sessionData.updatedAt }, "Session updatedAt is not a valid date — rejecting session");
        return { authenticated: false, mode: "managed", status: 401, error: "Session data is invalid" };
      }
      if (now - updatedAt > idleTimeout * 1000) {
        log.info({ userId, idleMs: now - updatedAt, idleTimeout }, "Session idle timeout exceeded");
        return { authenticated: false, mode: "managed", status: 401, error: "Session expired (idle timeout)" };
      }
    }

    const absRaw = parseInt(getSetting("ATLAS_SESSION_ABSOLUTE_TIMEOUT") ?? "0", 10);
    const absoluteTimeout = Number.isFinite(absRaw) && absRaw > 0 ? absRaw : 0;
    if (absoluteTimeout > 0 && sessionData.createdAt) {
      const createdAt = new Date(sessionData.createdAt as string).getTime();
      if (Number.isNaN(createdAt)) {
        log.warn({ userId, createdAt: sessionData.createdAt }, "Session createdAt is not a valid date — rejecting session");
        return { authenticated: false, mode: "managed", status: 401, error: "Session data is invalid" };
      }
      if (now - createdAt > absoluteTimeout * 1000) {
        log.info({ userId, ageMs: now - createdAt, absoluteTimeout }, "Session absolute timeout exceeded");
        return { authenticated: false, mode: "managed", status: 401, error: "Session expired" };
      }
    }
  }

  // Extract activeOrganizationId from session — set by Better Auth org plugin
  // via POST /organization/set-active.
  const activeOrganizationId = (sessionData?.activeOrganizationId as string) ?? undefined;

  // Carry session user fields as claims for RLS policy evaluation
  const claims: Record<string, unknown> = { ...sessionUser, sub: userId };
  if (activeOrganizationId) {
    claims.org_id = activeOrganizationId;
  }

  return {
    authenticated: true,
    mode: "managed",
    user: createAtlasUser(userId, "managed", email || userId, role, activeOrganizationId, claims),
  };
}
