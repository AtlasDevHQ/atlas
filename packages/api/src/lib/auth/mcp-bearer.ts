/**
 * Bearer-token authentication for the hosted MCP endpoint (#2024).
 *
 * Pure `Request → AuthResult` validator — same shape as
 * `validateApiKey` in `simple-key.ts`. The Hono middleware that
 * publishes the result onto `c.set("authResult")` lives in the route
 * layer (`packages/api/src/api/routes/mcp-middleware.ts`) to honour
 * the `lib/ → api/routes/` direction enforced by CLAUDE.md.
 *
 * Reads `Authorization: Bearer atl_mcp_*` from the request, resolves
 * the token via `lookupMcpTokenByBearer` in `mcp-token.ts`, and
 * returns an `AuthResult` ready to be dropped into the existing
 * `runHandler` Effect bridge.
 *
 * Error wording is deliberately uniform across every 401 branch
 * (missing header, wrong scheme, unknown token, revoked token,
 * expired token). Distinguishing them would form an enumeration
 * oracle: a probing attacker could distinguish "header shape wrong"
 * from "token doesn't exist" from "token was revoked" via
 * differences in error strings.
 *
 * Issue: #2024
 */

import type { AuthResult } from "@atlas/api/lib/auth/types";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { createLogger } from "@atlas/api/lib/logger";
import {
  lookupMcpTokenByBearer,
  type ResolvedMcpIdentity,
} from "./mcp-token";

const log = createLogger("mcp-bearer");

// ── Header extraction ───────────────────────────────────────────────

/**
 * Pull the bearer token from the request. Accepts only
 * `Authorization: Bearer <token>` — the X-API-Key fallback exists for
 * the legacy simple-key surface (env-configured key) and would
 * encourage clients to invent yet another header for MCP if we
 * mirrored it here.
 */
function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// ── Identity → AtlasUser ────────────────────────────────────────────

/**
 * Build the `AtlasUser` published into `AuthContext` for an
 * MCP-bearer-authenticated request.
 *
 * `mode: "managed"` is the closest existing fit: the bearer is bound
 * to a specific workspace user record from the SaaS tenant DB, exactly
 * like a managed-mode session cookie. We do NOT introduce a new
 * `AuthMode` value because that ripples through the @useatlas/types
 * union and the auth-result switches in every consumer.
 *
 * `role: "member"` is intentional. MCP tokens authorize data reads
 * against the workspace; admin actions (create connection, change
 * roles, etc.) require an interactive admin session by design. A
 * future "admin MCP token" surface would gate on a token scope rather
 * than role inheritance.
 */
function identityToUser(identity: ResolvedMcpIdentity) {
  // `id` must be non-empty (createAtlasUser asserts this). When the
  // token isn't bound to a specific user (device-code flow, RFC 8628),
  // fall back to a stable id derived from the token row so audit logs
  // can still pivot on actor.
  const id = identity.userId ?? `mcp:${identity.tokenId}`;
  const label = identity.userId ?? `mcp-${identity.tokenId.slice(0, 12)}`;
  return createAtlasUser(id, "managed", label, {
    role: "member",
    activeOrganizationId: identity.orgId,
    claims: {
      mcpTokenId: identity.tokenId,
      mcpScopes: identity.scopes,
    },
  });
}

// ── Public surface ──────────────────────────────────────────────────

/**
 * Resolve a `Request` to an `AuthResult` using only MCP bearer-token
 * credentials. Mirrors the shape of `validateApiKey` in
 * `simple-key.ts` so this fits naturally into the existing Auth
 * patterns when MCP routes are mounted in a follow-up PR.
 *
 * Every 401 path uses the same generic error string so the failure
 * wording cannot be used as an enumeration oracle (see file header).
 */
const INVALID_MCP_TOKEN = "Invalid MCP token";

export async function validateMcpBearer(req: Request): Promise<AuthResult> {
  const bearer = extractBearer(req);
  if (!bearer) {
    return {
      authenticated: false,
      mode: "managed",
      status: 401,
      error: INVALID_MCP_TOKEN,
    };
  }

  let identity: ResolvedMcpIdentity | null;
  try {
    identity = await lookupMcpTokenByBearer(bearer);
  } catch (err) {
    // Preserve the original error as `cause` so the stack survives
    // through the AuthResult boundary into the middleware's
    // log.error and any downstream observability shim.
    const wrapped =
      err instanceof Error ? err : new Error(String(err), { cause: err });
    log.error(
      { err: wrapped },
      "MCP bearer lookup threw — failing closed with 500",
    );
    return {
      authenticated: false,
      mode: "managed",
      status: 500,
      error: "MCP authentication system error",
    };
  }

  if (!identity) {
    return {
      authenticated: false,
      mode: "managed",
      status: 401,
      error: INVALID_MCP_TOKEN,
    };
  }

  return {
    authenticated: true,
    mode: "managed",
    user: identityToUser(identity),
  };
}
