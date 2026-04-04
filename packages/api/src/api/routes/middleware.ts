/**
 * Hono middleware for auth and request context.
 *
 * Replaces inline `adminAuthPreamble()` / `authPreamble()` calls and
 * `withRequestContext()` wrapping. Each middleware sets typed context
 * variables so route handlers can access them via `c.get()`.
 *
 * Usage:
 * ```ts
 * const app = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });
 * app.use(adminAuth);      // or standardAuth
 * app.use(requestContext);
 * ```
 */

import type { Env } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  authenticateRequest,
  checkRateLimit,
  getClientIP,
} from "@atlas/api/lib/auth/middleware";
import {
  detectMisrouting,
  isStrictRoutingEnabled,
} from "@atlas/api/lib/residency/misrouting";
import { isWorkspaceMigrating } from "@atlas/api/lib/residency/readonly";

const log = createLogger("middleware");

// ---------------------------------------------------------------------------
// Auth error classification (shared with admin-auth.ts)
// ---------------------------------------------------------------------------

const EXPIRED_AUTH_ERRORS = new Set([
  "Session expired",
  "Session expired (idle timeout)",
  "Invalid or expired token",
  "Session data is invalid",
]);

function authErrorCode(error: string): "session_expired" | "auth_error" {
  return EXPIRED_AUTH_ERRORS.has(error) ? "session_expired" : "auth_error";
}

// ---------------------------------------------------------------------------
// Env type — declares context variables set by middleware
// ---------------------------------------------------------------------------

export type AuthEnv = Env & {
  Variables: {
    authResult: AuthResult & { authenticated: true };
    requestId: string;
  };
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function authenticate(
  req: Request,
  requestId: string,
): Promise<
  | { ok: true; authResult: AuthResult & { authenticated: true } }
  | { ok: false; body: Record<string, unknown>; status: number; headers?: Record<string, string> }
> {
  let authResult: AuthResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), requestId },
      "Auth dispatch failed",
    );
    return { ok: false, body: { error: "auth_error", message: "Authentication system error", requestId }, status: 500 };
  }

  if (!authResult.authenticated) {
    log.warn({ requestId, status: authResult.status }, "Authentication failed");
    const body: Record<string, unknown> = {
      error: authErrorCode(authResult.error),
      message: authResult.error,
      requestId,
    };
    if (authResult.ssoRedirectUrl) {
      body.ssoRedirectUrl = authResult.ssoRedirectUrl;
    }
    return { ok: false, body, status: authResult.status };
  }

  return { ok: true, authResult };
}

async function rateLimitAndIPCheck(
  req: Request,
  authResult: AuthResult & { authenticated: true },
  requestId: string,
): Promise<{ body: Record<string, unknown>; status: number; headers?: Record<string, string> } | null> {
  const ip = getClientIP(req);
  const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
    return {
      body: { error: "rate_limited", message: "Too many requests. Please wait before trying again.", retryAfterSeconds, requestId },
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    };
  }

  // IP allowlist — enterprise feature
  const orgId = authResult.user?.activeOrganizationId;
  if (orgId) {
    try {
      const [{ checkIPAllowlist }, { Effect: E }] = await Promise.all([
        import("@atlas/ee/auth/ip-allowlist"),
        import("effect"),
      ]);
      const ipCheck = await E.runPromise(checkIPAllowlist(orgId, ip));
      if (!ipCheck.allowed) {
        log.warn({ requestId, orgId, ip }, "IP not in workspace allowlist");
        return {
          body: { error: "ip_not_allowed", message: "Your IP address is not in the workspace's allowlist.", requestId },
          status: 403,
        };
      }
    } catch (err) {
      // ee module not installed — IP allowlist feature unavailable, skip
      if (err instanceof Error && !err.message.includes("Cannot find module") && !err.message.includes("Cannot find package")) {
        throw err;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Misrouting detection — checks if the request reached the correct regional API
// ---------------------------------------------------------------------------

async function checkMisrouting(
  c: Context,
  authResult: AuthResult & { authenticated: true },
  requestId: string,
): Promise<{ body: Record<string, unknown>; status: number } | null> {
  const orgId = authResult.user?.activeOrganizationId;
  const result = await detectMisrouting(orgId, requestId);
  if (!result) return null;

  if (isStrictRoutingEnabled()) {
    return {
      body: {
        error: "misdirected_request",
        message: `This request should be directed to the ${result.expectedRegion} region API.`,
        correctApiUrl: result.correctApiUrl,
        expectedRegion: result.expectedRegion,
        actualRegion: result.actualRegion,
        requestId,
      },
      status: 421,
    };
  }

  // Graceful mode — log already happened in detectMisrouting, serve normally
  return null;
}

// ---------------------------------------------------------------------------
// Migration write-lock — reject writes during active region migration
// ---------------------------------------------------------------------------

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function checkMigrationWriteLock(
  method: string,
  authResult: AuthResult & { authenticated: true },
  requestId: string,
): Promise<{ body: Record<string, unknown>; status: number } | null> {
  if (!WRITE_METHODS.has(method)) return null;

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) return null;

  try {
    const migrating = await isWorkspaceMigrating(orgId);
    if (migrating) {
      log.warn({ requestId, orgId, method }, "Write rejected — workspace is migrating");
      return {
        body: {
          error: "workspace_migrating",
          message: "This workspace is currently being migrated to a new region. Write operations are temporarily disabled.",
          requestId,
        },
        status: 409,
      };
    }
  } catch (err) {
    // Fail closed — if we can't verify migration status, block writes to prevent data loss
    log.error(
      { err: err instanceof Error ? err.message : String(err), requestId, orgId },
      "Migration write-lock check failed — rejecting write as a precaution",
    );
    return {
      body: {
        error: "migration_check_failed",
        message: "Unable to verify workspace migration status. Write operations are temporarily unavailable.",
        requestId,
      },
      status: 503,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// adminAuth — authenticate + enforce admin role + rate limit + IP allowlist
// ---------------------------------------------------------------------------

export const adminAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);

  const auth = await authenticate(c.req.raw, requestId);
  if (!auth.ok) {
    return c.json(auth.body, auth.status as 401, auth.headers);
  }
  const { authResult } = auth;

  // Enforce admin role — auth mode "none" (local dev) is an implicit admin
  if (
    authResult.mode !== "none" &&
    (!authResult.user ||
      (authResult.user.role !== "admin" &&
        authResult.user.role !== "owner" &&
        authResult.user.role !== "platform_admin"))
  ) {
    log.warn({ requestId, userId: authResult.user?.id, role: authResult.user?.role }, "Non-admin access attempt");
    return c.json({ error: "forbidden_role", message: "Admin role required.", requestId }, 403);
  }

  const blocked = await rateLimitAndIPCheck(c.req.raw, authResult, requestId);
  if (blocked) {
    return c.json(blocked.body, blocked.status as 429, blocked.headers);
  }

  const misrouted = await checkMisrouting(c, authResult, requestId);
  if (misrouted) {
    return c.json(misrouted.body, misrouted.status as 421);
  }

  // No migration write-lock for admin routes — admins need to manage
  // the workspace during migration (retry, cancel, configure).

  c.set("authResult", authResult);
  await next();
});

// ---------------------------------------------------------------------------
// platformAdminAuth — authenticate + enforce platform_admin role + rate limit + IP allowlist
// ---------------------------------------------------------------------------

export const platformAdminAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);

  const auth = await authenticate(c.req.raw, requestId);
  if (!auth.ok) {
    return c.json(auth.body, auth.status as 401, auth.headers);
  }
  const { authResult } = auth;

  // Enforce platform_admin role — auth mode "none" (local dev) is an implicit admin
  if (authResult.mode !== "none" && (!authResult.user || authResult.user.role !== "platform_admin")) {
    log.warn({ requestId, userId: authResult.user?.id, role: authResult.user?.role }, "Non-platform-admin access attempt");
    return c.json({ error: "forbidden_role", message: "Platform admin role required.", requestId }, 403);
  }

  const blocked = await rateLimitAndIPCheck(c.req.raw, authResult, requestId);
  if (blocked) {
    return c.json(blocked.body, blocked.status as 429, blocked.headers);
  }

  const misrouted = await checkMisrouting(c, authResult, requestId);
  if (misrouted) {
    return c.json(misrouted.body, misrouted.status as 421);
  }

  c.set("authResult", authResult);
  await next();
});

// ---------------------------------------------------------------------------
// standardAuth — authenticate + rate limit + IP allowlist (no admin check)
// ---------------------------------------------------------------------------

export const standardAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);

  const auth = await authenticate(c.req.raw, requestId);
  if (!auth.ok) {
    return c.json(auth.body, auth.status as 401, auth.headers);
  }
  const { authResult } = auth;

  const blocked = await rateLimitAndIPCheck(c.req.raw, authResult, requestId);
  if (blocked) {
    return c.json(blocked.body, blocked.status as 429, blocked.headers);
  }

  const misrouted = await checkMisrouting(c, authResult, requestId);
  if (misrouted) {
    return c.json(misrouted.body, misrouted.status as 421);
  }

  c.set("authResult", authResult);
  await next();
});

// ---------------------------------------------------------------------------
// migrationWriteLock — rejects writes during active region migration
// ---------------------------------------------------------------------------

/**
 * Opt-in middleware that rejects write operations (POST, PUT, PATCH, DELETE)
 * when the workspace is actively being migrated between regions.
 *
 * Apply to routes where writes would cause data loss during migration
 * (chat, conversations). Don't apply to admin routes — admins need to
 * manage the workspace during migration (retry, cancel, configure).
 */
export const migrationWriteLock = createMiddleware<AuthEnv>(async (c, next) => {
  const authResult = c.get("authResult");
  const requestId = c.get("requestId");

  const locked = await checkMigrationWriteLock(c.req.method, authResult, requestId);
  if (locked) {
    return c.json(locked.body, locked.status as 409);
  }

  await next();
});

// ---------------------------------------------------------------------------
// requestContext — wraps downstream handlers in withRequestContext
// ---------------------------------------------------------------------------

/** Requires adminAuth/standardAuth to run first (reads authResult + requestId). */
export const requestContext = createMiddleware<AuthEnv>(async (c, next) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");
  await withRequestContext({ requestId, user: authResult.user }, () => next());
});

// ---------------------------------------------------------------------------
// withRequestId — lightweight: generates requestId + wraps in withRequestContext
// ---------------------------------------------------------------------------

/**
 * Generates a requestId and wraps downstream in withRequestContext.
 * Does NOT run auth — use when auth is handled inline in the handler
 * (e.g. admin.ts which mixes admin and non-admin routes).
 */
export const withRequestId = createMiddleware<AuthEnv>(async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  await withRequestContext({ requestId }, () => next());
});
