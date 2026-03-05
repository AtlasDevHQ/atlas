/**
 * Simple API key authentication.
 *
 * Validates requests against ATLAS_API_KEY using constant-time comparison.
 * Extracts key from Authorization: Bearer <key> or X-API-Key: <key> header.
 */

import { createHash, timingSafeEqual } from "crypto";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { parseRole } from "@atlas/api/lib/auth/permissions";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("auth");

/** Extract API key from request headers. Authorization header takes precedence. */
function extractKey(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1];
    log.warn(
      { scheme: authHeader.split(" ")[0] },
      "Authorization header present but not in 'Bearer <key>' format",
    );
  }

  const xApiKey = req.headers.get("x-api-key");
  if (xApiKey) return xApiKey;

  return null;
}

/** SHA-256 hash of a string, returned as hex. */
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Validate a request against ATLAS_API_KEY. */
export function validateApiKey(req: Request): AuthResult {
  const expected = process.env.ATLAS_API_KEY;
  if (!expected) {
    log.warn("ATLAS_API_KEY not configured but simple-key auth attempted");
    return { authenticated: false, mode: "simple-key", status: 401, error: "API key not configured" };
  }

  const key = extractKey(req);
  if (!key) {
    return { authenticated: false, mode: "simple-key", status: 401, error: "API key required" };
  }

  // Hash both to fixed-length digests so timingSafeEqual never leaks key length
  const keyHash = createHash("sha256").update(key).digest();
  const expectedHash = createHash("sha256").update(expected).digest();

  if (!timingSafeEqual(keyHash, expectedHash)) {
    log.warn("API key validation failed");
    return { authenticated: false, mode: "simple-key", status: 401, error: "Invalid API key" };
  }

  const id = `api-key-${sha256(key).slice(0, 8)}`;
  const label = `api-key-${key.slice(0, 4)}`;

  // Role override via ATLAS_API_KEY_ROLE (default: analyst — see permissions.ts)
  const rawRole = process.env.ATLAS_API_KEY_ROLE;
  const role = parseRole(rawRole);
  if (rawRole && !role) {
    log.warn({ value: rawRole, validRoles: ["viewer", "analyst", "admin"] }, "ATLAS_API_KEY_ROLE is set to an invalid value — defaulting to 'analyst'. Valid values: viewer, analyst, admin.");
  }

  // Parse optional claims from env var for RLS policy evaluation
  let claims: Record<string, unknown> | undefined;
  const rawClaims = process.env.ATLAS_RLS_CLAIMS;
  if (rawClaims) {
    try {
      const parsed = JSON.parse(rawClaims);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        claims = parsed;
      } else {
        log.warn("ATLAS_RLS_CLAIMS must be a JSON object — ignoring");
      }
    } catch {
      log.warn({ value: rawClaims.slice(0, 50) }, "ATLAS_RLS_CLAIMS is not valid JSON — ignoring");
    }
  }

  return {
    authenticated: true,
    mode: "simple-key",
    user: createAtlasUser(id, "simple-key", label, role, claims),
  };
}
