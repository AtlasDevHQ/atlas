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
  // Falls back to default (viewer) when not present — see permissions.ts.
  const sessionUser = session.user as Record<string, unknown>;
  // Better Auth can store multiple roles as comma-separated strings; Atlas uses only the first.
  const rawRoleField = sessionUser?.role;
  const rawRole = typeof rawRoleField === "string" ? rawRoleField.split(",")[0].trim() : rawRoleField;
  let role: ReturnType<typeof parseRole>;
  if (typeof rawRole === "string") {
    role = parseRole(rawRole);
    if (rawRole && !role) {
      log.warn({ value: rawRole, validRoles: ["viewer", "analyst", "admin"] }, "Session user role is not a valid Atlas role — defaulting to 'viewer'");
    }
  } else {
    role = undefined;
    if (rawRole !== undefined && rawRole !== null) {
      log.warn({ type: typeof rawRole }, "Session user role is not a string — ignoring");
    }
  }

  // Carry session user fields as claims for RLS policy evaluation
  const claims: Record<string, unknown> = { ...sessionUser, sub: userId };

  return {
    authenticated: true,
    mode: "managed",
    user: createAtlasUser(userId, "managed", email || userId, role, claims),
  };
}
