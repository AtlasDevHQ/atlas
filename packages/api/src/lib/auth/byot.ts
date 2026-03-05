/**
 * BYOT auth — JWT/JWKS validation for external identity providers.
 *
 * Validates JWTs signed by external IdPs (Auth0, Clerk, Supabase Auth, etc.)
 * using a remote JWKS endpoint. Requires ATLAS_AUTH_JWKS_URL + ATLAS_AUTH_ISSUER.
 */

import { createRemoteJWKSet, jwtVerify, errors } from "jose";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { parseRole } from "@atlas/api/lib/auth/permissions";
import { resolveClaimPath } from "@atlas/api/lib/rls";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("auth:byot");

let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS() {
  if (!_jwks) {
    const url = process.env.ATLAS_AUTH_JWKS_URL;
    if (!url) throw new Error("ATLAS_AUTH_JWKS_URL is required for BYOT mode");
    log.info({ jwksUrl: url }, "Initializing JWKS client");
    _jwks = createRemoteJWKSet(new URL(url));
  }
  return _jwks;
}

/** Reset the cached JWKS instance — for test isolation. */
export function resetJWKSCache(): void {
  _jwks = null;
}

/** @internal — test-only. Inject a JWKS key-set getter (bypasses createRemoteJWKSet). */
export function _setJWKS(jwks: ReturnType<typeof createRemoteJWKSet>): void {
  _jwks = jwks;
}

/**
 * Extract an Atlas role from the JWT payload using the configured claim path.
 * ATLAS_AUTH_ROLE_CLAIM can be a dot-delimited path (e.g. "app_metadata.role").
 * Defaults to checking "role" then "atlas_role" when not configured.
 */
function extractRoleFromPayload(payload: Record<string, unknown>) {
  const claimPath = process.env.ATLAS_AUTH_ROLE_CLAIM;

  if (claimPath) {
    // Single configured claim path — may be nested (e.g. "app_metadata.role")
    const value = resolveClaimPath(payload, claimPath);
    if (typeof value === "string") {
      const role = parseRole(value);
      if (role) return role;
      log.warn({ claimPath, value, validRoles: ["viewer", "analyst", "admin"] }, "JWT role claim value is not a valid Atlas role — ignoring");
    } else if (value !== undefined && value !== null) {
      log.warn({ claimPath, type: typeof value }, "JWT role claim is not a string — ignoring");
    }
    return undefined;
  }

  // Default: check "role" then "atlas_role" at the top level
  for (const claim of ["role", "atlas_role"]) {
    const value = payload[claim];
    if (typeof value === "string") {
      const role = parseRole(value);
      if (role) return role;
      log.warn({ claim, value, validRoles: ["viewer", "analyst", "admin"] }, "JWT role claim value is not a valid Atlas role — ignoring");
    } else if (value !== undefined && value !== null) {
      log.warn({ claim, type: typeof value }, "JWT role claim is not a string — ignoring");
    }
  }

  return undefined;
}

export async function validateBYOT(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      authenticated: false,
      mode: "byot",
      status: 401,
      error: "Missing or malformed Authorization header",
    };
  }

  const token = authHeader.slice(7);
  const jwks = getJWKS();

  const issuer = process.env.ATLAS_AUTH_ISSUER;
  if (!issuer)
    throw new Error("ATLAS_AUTH_ISSUER is required for BYOT mode");

  const rawAudience = process.env.ATLAS_AUTH_AUDIENCE;
  if (rawAudience === "") {
    log.warn("ATLAS_AUTH_AUDIENCE is set to empty string — audience check will be skipped");
  }
  const audience = rawAudience || undefined;

  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience });
    const sub = payload.sub;
    if (!sub) {
      return {
        authenticated: false,
        mode: "byot",
        status: 401,
        error: "JWT missing sub claim",
      };
    }
    const email =
      typeof payload.email === "string" ? payload.email : undefined;

    // Extract role from JWT claim. Configurable via ATLAS_AUTH_ROLE_CLAIM
    // (default: check "role", then "atlas_role").
    const role = extractRoleFromPayload(payload);

    return {
      authenticated: true,
      mode: "byot",
      user: createAtlasUser(sub, "byot", email || sub, role, payload as Record<string, unknown>),
    };
  } catch (err) {
    // Infrastructure errors — JWKS endpoint issues are not client auth failures.
    // Re-throw so middleware.ts catches them as 500.
    if (
      err instanceof errors.JWKSTimeout ||
      err instanceof errors.JWKSInvalid ||
      err instanceof errors.JOSENotSupported
    ) {
      log.error(
        { err, code: err.code },
        "JWKS infrastructure error during BYOT validation",
      );
      throw err;
    }

    // Token validation errors — legitimate 401s
    if (err instanceof errors.JOSEError) {
      log.debug(
        { code: err.code, message: err.message },
        "BYOT token rejected",
      );
      return {
        authenticated: false,
        mode: "byot",
        status: 401,
        error: "Invalid or expired token",
      };
    }

    // Unexpected non-JOSE errors (e.g., network fetch failure) — re-throw
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Unexpected BYOT validation error",
    );
    throw err;
  }
}
