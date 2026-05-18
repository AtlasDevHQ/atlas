/**
 * Shared admin authentication preamble.
 *
 * Extracted from admin.ts to avoid duplication across sub-routers
 * (admin-orgs.ts, admin-learned-patterns.ts, etc.).
 */

import { HTTPException } from "hono/http-exception";
import { createLogger } from "@atlas/api/lib/logger";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  authenticateRequest,
  checkRateLimit,
  getClientIP,
} from "@atlas/api/lib/auth/middleware";
import { Effect } from "effect";
import { IpAllowlistPolicy } from "@atlas/api/lib/effect/services";
import { EnterpriseLayer } from "@atlas/api/lib/effect/enterprise-layer";

const log = createLogger("admin-auth");

/** Known auth error messages that indicate an expired session or token. */
const EXPIRED_AUTH_ERRORS = new Set([
  "Session expired",
  "Session expired (idle timeout)",
  "Invalid or expired token",
  "Session data is invalid",
]);

export function authErrorCode(error: string): "session_expired" | "auth_error" {
  return EXPIRED_AUTH_ERRORS.has(error) ? "session_expired" : "auth_error";
}

/**
 * Authenticate the request and enforce admin role. Returns either:
 * - `{ error, status, headers? }` on failure (401/403/429/500)
 * - `{ authResult }` on success (authenticated admin user)
 *
 * All error objects include `requestId` for log correlation.
 * The `headers` field is only present for 429 rate-limit responses.
 */
export async function adminAuthPreamble(req: Request, requestId: string) {
  let authResult: AuthResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), requestId },
      "Auth dispatch failed",
    );
    return { error: { error: "auth_error", message: "Authentication system error", requestId }, status: 500 as const };
  }
  if (!authResult.authenticated) {
    log.warn({ requestId, status: authResult.status }, "Authentication failed");
    const code = authErrorCode(authResult.error);
    const errorBody: Record<string, unknown> = { error: code, message: authResult.error, requestId };
    if (authResult.ssoRedirectUrl) {
      errorBody.ssoRedirectUrl = authResult.ssoRedirectUrl;
    }
    return { error: errorBody, status: authResult.status as 401 | 403 | 500 };
  }

  // Enforce admin role — when auth mode is "none" (no auth configured, e.g.
  // local dev), treat the request as an implicit admin since there is no
  // identity boundary to enforce.
  if (authResult.mode !== "none" && (!authResult.user || (authResult.user.role !== "admin" && authResult.user.role !== "owner" && authResult.user.role !== "platform_admin"))) {
    log.warn({ requestId, userId: authResult.user?.id, role: authResult.user?.role }, "Non-admin access attempt");
    return { error: { error: "forbidden_role", message: "Admin role required.", requestId }, status: 403 as const };
  }

  const ip = getClientIP(req);
  const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
    return {
      error: { error: "rate_limited", message: "Too many requests. Please wait before trying again.", retryAfterSeconds, requestId },
      status: 429 as const,
      headers: { "Retry-After": String(retryAfterSeconds) },
    };
  }

  // IP allowlist — via `IpAllowlistPolicy` Tag (#2570). Self-hosted +
  // EE-not-loaded both flow through the no-op default which always allows.
  const orgId = authResult.user?.activeOrganizationId;
  if (orgId) {
    const ipCheck = await Effect.runPromise(
      Effect.gen(function* () {
        const policy = yield* IpAllowlistPolicy;
        return yield* policy.checkIPAllowlist(orgId, ip);
      }).pipe(Effect.provide(EnterpriseLayer)),
    );
    if (!ipCheck.allowed) {
      log.warn({ requestId, orgId, ip }, "IP not in workspace allowlist");
      return {
        error: { error: "ip_not_allowed", message: "Your IP address is not in the workspace's allowlist.", requestId },
        status: 403 as const,
      };
    }
  }

  return { authResult };
}

type AdminPreambleResult = Awaited<ReturnType<typeof adminAuthPreamble>>;

/**
 * Assert that the admin auth preamble succeeded.
 * Throws HTTPException with a JSON response on failure, so the handler
 * can destructure `{ authResult }` directly after calling this.
 */
export function requireAdminAuth(
  preamble: AdminPreambleResult,
): asserts preamble is Extract<AdminPreambleResult, { authResult: unknown }> {
  if ("error" in preamble) {
    throw new HTTPException(preamble.status, {
      res: Response.json(preamble.error, {
        status: preamble.status,
        headers: preamble.headers,
      }),
    });
  }
}
