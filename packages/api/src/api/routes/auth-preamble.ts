/**
 * Shared auth preamble for public API routes.
 *
 * Standard authentication + rate limiting. Not admin-gated.
 * Used by semantic and tables routes.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  authenticateRequest,
  checkRateLimit,
  getClientIP,
} from "@atlas/api/lib/auth/middleware";

const log = createLogger("auth-preamble");

type AuthPreambleSuccess = { authResult: AuthResult & { authenticated: true } };
type AuthPreambleFailure = {
  error: Record<string, unknown>;
  status: 401 | 403 | 429 | 500;
  headers?: Record<string, string>;
};

/**
 * Authenticate the request and check rate limits. Returns
 * `{ error, status, headers? }` on failure (401/403/429/500)
 * or `{ authResult }` on success.
 */
export async function authPreamble(
  req: Request,
  requestId: string,
): Promise<AuthPreambleSuccess | AuthPreambleFailure> {
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
    return { error: { error: "auth_error", message: authResult.error, requestId }, status: authResult.status as 401 | 403 | 500 };
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

  return { authResult };
}
