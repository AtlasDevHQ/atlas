/**
 * Shared admin authentication preamble.
 *
 * Extracted from admin.ts to avoid duplication across sub-routers
 * (admin-orgs.ts, admin-learned-patterns.ts, etc.).
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  authenticateRequest,
  checkRateLimit,
  getClientIP,
} from "@atlas/api/lib/auth/middleware";

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
    return { error: { error: code, message: authResult.error }, status: authResult.status as 401 | 403 | 500 };
  }

  // Enforce admin role — when auth mode is "none" (no auth configured, e.g.
  // local dev), treat the request as an implicit admin since there is no
  // identity boundary to enforce.
  if (authResult.mode !== "none" && (!authResult.user || (authResult.user.role !== "admin" && authResult.user.role !== "owner"))) {
    log.warn({ requestId, userId: authResult.user?.id, role: authResult.user?.role }, "Non-admin access attempt");
    return { error: { error: "forbidden_role", message: "Admin role required." }, status: 403 as const };
  }

  const ip = getClientIP(req);
  const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
    return {
      error: { error: "rate_limited", message: "Too many requests. Please wait before trying again.", retryAfterSeconds },
      status: 429 as const,
      headers: { "Retry-After": String(retryAfterSeconds) },
    };
  }

  return { authResult };
}
