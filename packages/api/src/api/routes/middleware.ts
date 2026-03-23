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
import { createMiddleware } from "hono/factory";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  authenticateRequest,
  checkRateLimit,
  getClientIP,
} from "@atlas/api/lib/auth/middleware";

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
    let checkIPAllowlist: ((orgId: string, clientIP: string | null) => Promise<{ allowed: boolean }>) | undefined;
    try {
      ({ checkIPAllowlist } = await import("@atlas/ee/auth/ip-allowlist"));
    } catch {
      // ee module not installed — IP allowlist feature unavailable, skip
    }
    if (checkIPAllowlist) {
      const ipCheck = await checkIPAllowlist(orgId, ip);
      if (!ipCheck.allowed) {
        log.warn({ requestId, orgId, ip }, "IP not in workspace allowlist");
        return {
          body: { error: "ip_not_allowed", message: "Your IP address is not in the workspace's allowlist.", requestId },
          status: 403,
        };
      }
    }
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

  c.set("authResult", authResult);
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
