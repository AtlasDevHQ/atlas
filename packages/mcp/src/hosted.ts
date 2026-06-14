/**
 * Hosted MCP endpoint — Hono router that mounts on the per-region API server.
 *
 * Self-hosted users connect via stdio (the bunx installer in @useatlas/mcp).
 * SaaS / remote users connect via this hosted endpoint:
 *
 *   POST   /mcp/{workspace_id}/sse   — JSON-RPC frames
 *   GET    /mcp/{workspace_id}/sse   — SSE notifications
 *   DELETE /mcp/{workspace_id}/sse   — explicit session termination
 *
 * ── Authentication (#2024 PR C) ────────────────────────────────────
 *
 * Authentication is OAuth 2.1 — the bearer is a JWT-signed access token
 * issued by the Better Auth `@better-auth/oauth-provider` plugin against
 * the `mcp:read` (and optionally `mcp:write`) scopes. Verification:
 *
 *   1. `Authorization: Bearer <jwt>` header is required.
 *   2. `verifyAccessToken` validates the signature against the JWKS
 *      published at `/.well-known/jwks.json`, plus issuer + audience.
 *   3. Audience MUST match the per-region MCP resource URI
 *      (`https://<api-host>/mcp` — see `resourceAudience()` below).
 *   4. The custom claim `https://atlas.useatlas.dev/workspace_id`
 *      MUST match the `{workspace_id}` path segment. Mismatch → 403.
 *
 * The legacy `mcp_tokens` admin-bearer path that PR A shipped is gone.
 * MCP clients (Claude Desktop, ChatGPT, Cursor) bootstrap via Dynamic
 * Client Registration at `/api/auth/oauth2/register` and complete the
 * authorization-code-with-PKCE flow against `/api/auth/oauth2/authorize`.
 *
 * ── Residency (fail-closed) ────────────────────────────────────────
 *
 * Distinct from the data path's `detectMisrouting` which is graceful
 * by default. The MCP surface cannot tolerate a region-lookup miss —
 * a single MCP request fans out to many tool calls. If `getWorkspaceRegion`
 * throws, this surface returns 503 rather than serving traffic that
 * might cross residency. Audience verification (above) is a second
 * guarantee: per-region instances configure distinct `validAudiences`,
 * so a token issued against api-eu won't even verify at api-us.
 *
 * ── Session ownership ──────────────────────────────────────────────
 *
 * Each new session creates a fresh `McpServer` bound to the bearer's
 * verified identity. The server lives for the duration of the session;
 * the per-session transport handles JSON-RPC dispatch internally. A
 * session never crosses identities even if the same bearer is reused
 * across sessions.
 *
 * ── Audit ──────────────────────────────────────────────────────────
 *
 * `mcp_session.start` fires on session-init — sampled, not per JSON-RPC
 * frame. Metadata carries `sessionId`, `orgId`, `clientId` (the OAuth
 * `azp` / authorized-party claim — i.e. which DCR-registered client is
 * connecting), and `region` so forensic queries pivot on any axis.
 */

import { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// `better-auth/oauth2` exposes the `verifyAccessToken` helper that this
// route's bearer middleware relies on. Static import (rather than the
// dynamic import other Better-Auth-touching modules use) is fine here —
// the hosted MCP path is SaaS-only, and the only deployment shape that
// loads `@atlas/mcp/hosted` already has Better Auth in its module graph
// via `@atlas/api`. Keeping the import static gives us proper type
// resolution at the call site below.
import { verifyAccessToken } from "better-auth/oauth2";
import { getApiRegion } from "@atlas/api/lib/residency/misrouting";
import { getWorkspaceRegion } from "@atlas/api/lib/db/internal";
import { getConfig } from "@atlas/api/lib/config";
import { withRequestContext, createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { createAtlasUser, type AtlasUser } from "@atlas/api/lib/auth/types";
import { isPasswordChangeRequired } from "@atlas/api/lib/auth/password-gate";
import { ATLAS_OAUTH_WORKSPACE_CLAIM } from "@atlas/api/lib/auth/oauth-claims";
import {
  getOAuthClientScope,
  hasWorkspaceGrant,
  userIsWorkspaceMember,
} from "@atlas/api/lib/auth/oauth-workspace-grants";
import { createAtlasMcpServer } from "./server.js";
import { withLiveActor } from "./live-actor-store.js";
import { resolveMcpActorRole } from "./bind-actor.js";
import {
  McpSessionStore,
  resolveMaxSessions,
  sessionIdleTimeoutMs,
  _setIdleTimeoutForTests,
} from "./session-store.js";

// Re-exported unchanged so the production guard's test seam keeps its import
// path (`@atlas/mcp/hosted`). The override is module-scoped in
// `session-store.ts` (it tunes env-driven timeout resolution, not the store).
export { _setIdleTimeoutForTests };

const log = createLogger("mcp-hosted");

// ── Module-scoped session store (#3600) ────────────────────────────
//
// The hosted transport owns a SINGLE module-scoped store: every per-region
// request shares one cap / session map. (sse.ts, by contrast, constructs one
// store PER `startSseServer` call — its intentional shape difference.) The
// store owns the session lifecycle — register, dispatch, sweep, cap-check,
// reservation, GET/POST stream liveness — and is shared verbatim with sse.ts;
// see `session-store.ts`. The cap resolver passed here is env-only (hosted has
// no caller-pinned cap analogous to sse's `opts.maxSessions`).

const sessions = new McpSessionStore(() => resolveMaxSessions());

export function _hostedSessionCount(): number {
  return sessions.size;
}

export async function _resetHostedSessions(): Promise<void> {
  await sessions.reset();
}

/**
 * @internal — test-only. Drive the sweep deterministically with a pinned
 * clock and optional overrides for both the idle timeout and the max
 * held-stream age. Passing `Infinity` for `heldStreamMaxAgeMs` disables
 * stream-age reclaim (useful for tests that only want to exercise the
 * idle-timeout path without triggering stream-age logic).
 */
export function _sweepIdleSessionsForTests(
  now?: number,
  idleTimeoutMs?: number,
  heldStreamMaxAgeMs?: number,
): number {
  return sessions.sweep(
    now ?? Date.now(),
    idleTimeoutMs ?? sessionIdleTimeoutMs(),
    heldStreamMaxAgeMs,
  );
}

// ── OAuth 2.1 verification ─────────────────────────────────────────
//
// `ATLAS_OAUTH_WORKSPACE_CLAIM` is the URN-shaped custom claim key
// stamped onto every workspace-bound access token by
// `customAccessTokenClaims` in server.ts. Imported from the shared
// `oauth-claims.ts` module so production issuance, MCP verification,
// and the test fixture all read one literal — drift would silently
// break every token. See the module's docstring for the rationale.

/**
 * Required scopes for any MCP request. Today every shipping MCP tool
 * is read-only (executeSQL is read-only by validation, semantic-layer
 * tools are reads). When write tools land, gate them at the tool layer
 * on `mcp:write` and keep the connection-level requirement at
 * `mcp:read` so existing clients keep working.
 */
const REQUIRED_SCOPES = ["mcp:read"] as const;

/**
 * Build the resource-server audience(s) accepted by this API instance.
 * Tokens issued for this MCP region must have `aud` matching one of
 * these exactly. We resolve from the env in the same order as
 * well-known.ts so the audience advertised in the protected-resource
 * metadata is one of the audiences accepted here.
 *
 * #2068 — when the resolved base is one of the canonical SaaS regional
 * `api*.useatlas.dev` hosts, the brand-mirror `mcp*.useatlas.dev/mcp`
 * audience is also accepted. Tokens minted post-cutover (advertised
 * via the brand surface) verify here, AND tokens minted pre-cutover
 * (bound to the regional host) keep verifying. Self-hosted operators
 * on arbitrary hostnames are unaffected — the mirror only synthesises
 * for `*.useatlas.dev`.
 *
 * The return is always an array; `verifyAccessToken` forwards directly
 * to `jose.jwtVerify` whose `audience` option accepts `string[]`. A
 * one-element array on self-hosted is harmless and keeps the call
 * site uniform.
 */
function resourceAudience(req: Request): string[] {
  const base =
    process.env.ATLAS_PUBLIC_API_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    new URL(req.url).origin;
  const trimmed = base.replace(/\/+$/, "");
  const audiences = [`${trimmed}/mcp`];
  const mirror = mirrorUseatlasHost(trimmed);
  if (mirror) audiences.push(`${mirror}/mcp`);
  return audiences;
}

/**
 * Symmetric mirror between regional `api*.useatlas.dev` and brand
 * `mcp*.useatlas.dev` hosts. `api.useatlas.dev` ↔ `mcp.useatlas.dev`,
 * `api-eu.useatlas.dev` ↔ `mcp-eu.useatlas.dev`, etc. Returns null for
 * anything outside the documented regional surfaces — self-hosted,
 * dev, custom-domain SaaS — so those bases pass through unchanged.
 *
 * Used by the audience-accept-list helper above so the verifier
 * accepts BOTH the brand and regional audience regardless of which
 * the operator chose for `ATLAS_PUBLIC_API_URL`. Pre-cutover tokens
 * bound to the regional surface and post-cutover tokens bound to the
 * brand both verify here. Mirrors `server.ts:brandMcpAudience` —
 * keep the regex in lockstep.
 */
function mirrorUseatlasHost(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    // intentionally ignored: a non-URL base falls back to a single-
    // audience accept list (the trimmed base + /mcp) which still
    // covers self-hosted operators on arbitrary hostnames.
    return null;
  }
  const matched = url.hostname.match(/^(api|mcp)(-[a-z0-9]+)?\.useatlas\.dev$/);
  if (!matched) return null;
  const flipped = matched[1] === "api" ? "mcp" : "api";
  const regionSuffix = matched[2] ?? "";
  return `https://${flipped}${regionSuffix}.useatlas.dev`;
}

/**
 * Map a SaaS regional API base (`api*.useatlas.dev`) to its
 * `mcp*.useatlas.dev` brand counterpart. Returns null for any host
 * outside the regional pattern — including brand hosts, which the
 * caller falls back to as-is. Asymmetric: this is the "always emit
 * the brand surface" helper used by `wwwAuthenticateHeader` and the
 * 421 misrouting body so a redirected client never picks up the
 * underlying regional infra.
 *
 * Mirrors `well-known.ts:brandedMcpHost`. Keep the regex in lockstep.
 */
function brandedMcpHost(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    // intentionally ignored: caller falls back to the trimmed base.
    return null;
  }
  const matched = url.hostname.match(/^api(-[a-z0-9]+)?\.useatlas\.dev$/);
  if (!matched) return null;
  const regionSuffix = matched[1] ?? "";
  return `https://mcp${regionSuffix}.useatlas.dev`;
}

/**
 * Build the token issuer URL. `verifyAccessToken` requires `issuer` to
 * be set so a leaked token from a different OAuth server can't replay
 * against us — the issuer claim has to match exactly.
 */
function tokenIssuer(req: Request): string {
  const base =
    process.env.ATLAS_PUBLIC_API_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    new URL(req.url).origin;
  return `${base.replace(/\/+$/, "")}/api/auth`;
}

/** JWKS endpoint — Better Auth's `jwt()` plugin publishes here. */
function jwksUrl(req: Request): string {
  return `${tokenIssuer(req)}/jwks`;
}

export interface VerifiedBearer {
  readonly kind: "ok";
  readonly user: AtlasUser;
  readonly orgId: string;
  readonly clientId: string;
  readonly tokenJti: string | null;
  readonly scopes: ReadonlyArray<string>;
}

interface BearerFailure {
  readonly kind: "fail";
  readonly status: 401 | 403 | 503;
  readonly body: {
    error: string;
    message: string;
    requestId: string;
    /** RFC 6750 `scope` parameter for `WWW-Authenticate` on insufficient_scope. */
    scope?: string;
  };
  /**
   * Whether to advertise the protected-resource metadata pointer in
   * the response. We only emit it on auth-challenge failures (401 from
   * a missing or invalid bearer) — RFC 9728 §3.3. Suppressing on:
   *   - insufficient_scope (403 — the client has a valid bearer, just
   *     not enough scope; pointing at metadata invites a useless retry)
   *   - structurally-malformed claim cases (`missing_workspace_claim`,
   *     `missing_subject`, `missing_client_id` — the token verified but
   *     was mis-issued; sending discovery would mislead a client into
   *     re-running DCR for a server config bug)
   *   - 503 JWKS / auth-server outages (the server's auth machinery is
   *     down; the resource-metadata document is also down)
   */
  readonly emitChallengeHeader: boolean;
}

type BearerOutcome = VerifiedBearer | BearerFailure;

/**
 * Type guard for `better-call`'s `APIError` (the class `verifyAccessToken`
 * throws for spec-defined failures). We don't `import { APIError }` to
 * avoid pinning a transitive dependency at our static-import surface;
 * the runtime shape (`name === "APIError"` + numeric `statusCode`) is
 * stable across `better-call` versions and is what we need to branch on.
 */
function isApiError(
  err: unknown,
): err is Error & { statusCode: number; status: string; body?: { message?: string } } {
  return (
    err instanceof Error &&
    err.name === "APIError" &&
    typeof (err as { statusCode?: unknown }).statusCode === "number"
  );
}

/**
 * Detect the JWKS-infrastructure error class. `better-auth/oauth2` throws
 * a plain `Error` with one of these prefixes when the JWKS endpoint is
 * unreachable, returns malformed JSON, or doesn't have the `kid` we
 * need. These are server-side outages, not client errors — they must
 * surface as 503 so a JWKS hiccup doesn't look like a flood of bad
 * tokens (which would otherwise drown the audit log and confuse
 * support-tier triage).
 */
function isJwksError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.startsWith("Jwks failed:") ||
    err.message === "No jwks found" ||
    err.message === "Missing jwt kid"
  );
}

/**
 * Extract + verify the bearer. Returns either a verified identity
 * envelope (`kind: "ok"`) or a structured failure (`kind: "fail"`). The
 * `kind` discriminator is load-bearing at this security boundary —
 * structural narrowing via `"status" in verified` would silently break
 * if `VerifiedBearer` ever grew a `status` field, so we tag explicitly.
 *
 * Failure classes:
 *   - **401** — bearer absent/empty (`missing_bearer`), JWT signature
 *     or expiry invalid (`invalid_bearer`), token verified but missing
 *     a required claim (`missing_workspace_claim`, `missing_subject`,
 *     `missing_client_id`). The first two emit a `WWW-Authenticate`
 *     resource-metadata pointer per RFC 9728; the structural-claim
 *     failures suppress it (the bearer was issued, just incorrectly —
 *     re-running DCR won't help).
 *   - **403** — token verified but missing `mcp:read` scope
 *     (`insufficient_scope`). RFC 6750 §3.1: 403 with
 *     `WWW-Authenticate: Bearer scope="mcp:read"`.
 *   - **503** — JWKS endpoint outage or auth-server-side
 *     misconfiguration (`auth_unavailable`). The token MIGHT be valid;
 *     we can't tell. Surfacing as 503 lets clients retry rather than
 *     re-running DCR, and pages operators on Sentry for what is
 *     genuinely a server outage.
 */
async function verifyMcpBearer(
  req: Request,
  requestId: string,
): Promise<BearerOutcome> {
  const auth = req.headers.get("authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) {
    return {
      kind: "fail",
      status: 401,
      emitChallengeHeader: true,
      body: {
        error: "missing_bearer",
        message:
          "Authorization header must carry a Bearer access token. See the MCP authorization spec for client setup.",
        requestId,
      },
    };
  }
  const token = auth.slice("bearer ".length).trim();
  if (!token) {
    return {
      kind: "fail",
      status: 401,
      emitChallengeHeader: true,
      body: {
        error: "missing_bearer",
        message: "Bearer token is empty.",
        requestId,
      },
    };
  }

  let payload: Awaited<ReturnType<typeof verifyAccessToken>>;
  try {
    payload = await verifyAccessToken(token, {
      verifyOptions: {
        audience: resourceAudience(req),
        issuer: tokenIssuer(req),
      },
      scopes: [...REQUIRED_SCOPES],
      jwksUrl: jwksUrl(req),
    });
  } catch (err) {
    // JWKS infrastructure failures → 503. Logging at error so the
    // operator paging path fires; this is genuinely "auth server side
    // is unavailable", not client error.
    if (isJwksError(err)) {
      log.error(
        { requestId, err: err instanceof Error ? err.message : String(err) },
        "MCP bearer verification failed: JWKS infrastructure unavailable",
      );
      return {
        kind: "fail",
        status: 503,
        emitChallengeHeader: false,
        body: {
          error: "auth_unavailable",
          message:
            "Authentication service is temporarily unavailable. Retry shortly.",
          requestId,
        },
      };
    }
    // Insufficient scope is structurally a 403 (RFC 6750 §3.1) — the
    // client authenticated successfully, they just don't have the
    // capability. Returning 401 here would tell the client to refresh
    // their token, which won't fix the missing scope. Returning 403
    // with the scope hint lets them re-prompt the user for consent.
    if (isApiError(err) && err.statusCode === 403) {
      log.warn(
        { requestId, err: err.body?.message ?? err.message },
        "MCP bearer verification failed: insufficient scope",
      );
      return {
        kind: "fail",
        status: 403,
        emitChallengeHeader: false,
        body: {
          error: "insufficient_scope",
          message:
            "Access token does not carry the required mcp:read scope.",
          scope: REQUIRED_SCOPES.join(" "),
          requestId,
        },
      };
    }
    // Everything else (UNAUTHORIZED — expired / invalid signature /
    // bad audience / bad issuer / no payload, plus any unexpected
    // throw) collapses to 401 invalid_bearer. The 401 is a genuine
    // auth challenge; the resource_metadata pointer helps the client
    // re-discover the auth server.
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { requestId, err: message },
      "MCP bearer verification failed: returning 401 invalid_bearer",
    );
    return {
      kind: "fail",
      status: 401,
      emitChallengeHeader: true,
      body: {
        error: "invalid_bearer",
        message:
          "Access token did not verify. Check audience, issuer, and expiry.",
        requestId,
      },
    };
  }

  // verifyAccessToken returned a payload — perform the structural
  // claim checks. Failures here suppress the WWW-Authenticate header:
  // the bearer was issued, just incorrectly. Re-running DCR / refresh
  // wouldn't help; this is an issuer-side bug.
  const orgIdRaw = (payload as Record<string, unknown>)[ATLAS_OAUTH_WORKSPACE_CLAIM];
  if (typeof orgIdRaw !== "string" || orgIdRaw.length === 0) {
    log.warn(
      { requestId, sub: typeof payload.sub === "string" ? payload.sub : null },
      "MCP bearer is valid but carries no workspace claim — token issued without an active organization",
    );
    return {
      kind: "fail",
      status: 401,
      emitChallengeHeader: false,
      body: {
        error: "missing_workspace_claim",
        message:
          "Access token does not carry a workspace claim. Re-authenticate after selecting a workspace.",
        requestId,
      },
    };
  }

  const sub = typeof payload.sub === "string" ? payload.sub : null;
  if (!sub) {
    // A JWT without `sub` cannot be tied to an actor. Refuse — every
    // audit row and every per-tool authorization check downstream
    // needs an actor id.
    return {
      kind: "fail",
      status: 401,
      emitChallengeHeader: false,
      body: {
        error: "missing_subject",
        message: "Access token does not carry a subject claim.",
        requestId,
      },
    };
  }

  // `azp` (authorized party / client_id) is set by `oauthProvider` on
  // every issued token. A missing `azp` means either a bypass or an
  // issuer config drift; refuse rather than poison the audit log with
  // a literal `"unknown_client"` string a future forensic query
  // (`WHERE client_id = ?`) couldn't tell apart from a deliberate
  // value. Logging at warn so a single bad token surfaces, but
  // operators paging happens via the issuer-side missing-claim
  // monitor, not this 401.
  const azp = (payload as { azp?: unknown }).azp;
  if (typeof azp !== "string" || azp.length === 0) {
    log.warn(
      { requestId, sub },
      "MCP bearer verified but missing azp claim — token issued without a client identity",
    );
    return {
      kind: "fail",
      status: 401,
      emitChallengeHeader: false,
      body: {
        error: "missing_client_id",
        message: "Access token does not carry an authorized-party claim.",
        requestId,
      },
    };
  }
  const clientId = azp;

  // Forced-password-change gate (#3345). The OAuth authorize flow accepts a
  // managed session created with a temp password, so without this check a
  // flagged user could mint an MCP bearer and keep using the temp credential
  // indefinitely — the web UI's redirect was the only enforcement point.
  // Mirrors the REST/agent gate in `authenticateRequest`.
  try {
    if (await isPasswordChangeRequired(sub)) {
      log.warn(
        { requestId, sub },
        "MCP request blocked — password change required for the bearer's subject",
      );
      return {
        kind: "fail",
        status: 403,
        emitChallengeHeader: false,
        body: {
          error: "password_change_required",
          message:
            "Your password must be changed before MCP access is allowed. Change it in the Atlas web app, then reconnect.",
          requestId,
        },
      };
    }
  } catch (err) {
    log.error(
      { requestId, sub, err: err instanceof Error ? err.message : String(err) },
      "password_change_required lookup failed at the MCP edge — refusing to dispatch (fail-closed)",
    );
    return {
      kind: "fail",
      status: 503,
      emitChallengeHeader: false,
      body: {
        error: "auth_unavailable",
        message: "Could not verify account status. Retry shortly.",
        requestId,
      },
    };
  }

  const user = createAtlasUser(sub, "managed", sub, {
    activeOrganizationId: orgIdRaw,
    claims: { ...payload, [ATLAS_OAUTH_WORKSPACE_CLAIM]: orgIdRaw },
  });

  const scopeRaw = (payload as { scope?: unknown }).scope;
  const scopes =
    typeof scopeRaw === "string" ? scopeRaw.split(/\s+/).filter(Boolean) : [];

  return {
    kind: "ok",
    user,
    orgId: orgIdRaw,
    clientId,
    tokenJti: typeof payload.jti === "string" ? payload.jti : null,
    scopes,
  };
}

// ── Residency check (fail-closed) ──────────────────────────────────

interface ResidencyCheckResult {
  readonly kind: "ok";
}
interface MisroutedResult {
  readonly kind: "misrouted";
  readonly status: 421;
  readonly body: {
    error: "misdirected_request";
    message: string;
    correctApiUrl?: string;
    expectedRegion: string;
    actualRegion: string;
    requestId: string;
  };
}
interface RegionUnavailableResult {
  readonly kind: "unavailable";
  readonly status: 503;
  readonly body: {
    error: "region_unavailable";
    message: string;
    requestId: string;
  };
}
type ResidencyOutcome =
  | ResidencyCheckResult
  | MisroutedResult
  | RegionUnavailableResult;

async function checkResidency(
  orgId: string,
  requestId: string,
): Promise<ResidencyOutcome> {
  const apiRegion = getApiRegion();
  // No region configured on this api instance — self-hosted compat.
  if (!apiRegion) return { kind: "ok" };

  let workspaceRegion: string | null;
  try {
    workspaceRegion = await getWorkspaceRegion(orgId);
  } catch (err) {
    log.error(
      {
        requestId,
        orgId,
        err: err instanceof Error ? err.message : String(err),
      },
      "MCP residency lookup failed — refusing to dispatch (fail-closed)",
    );
    return {
      kind: "unavailable",
      status: 503,
      body: {
        error: "region_unavailable",
        message:
          "Could not verify workspace region. Try again shortly; if this persists, check status.useatlas.dev.",
        requestId,
      },
    };
  }

  // Workspace not yet region-assigned (new account) — let it through.
  if (!workspaceRegion) return { kind: "ok" };
  if (workspaceRegion === apiRegion) return { kind: "ok" };

  // #2068 — `residency.regions[X].apiUrl` is the canonical public API
  // URL for region X (data path). For the MCP misrouting body we
  // surface the brand-mirror `mcp*.useatlas.dev` so a client redirected
  // here points its next session at the same surface its config
  // already advertises. The mapping is a no-op for self-hosted operators
  // whose `apiUrl` doesn't match the SaaS regional pattern.
  const regionApiUrl =
    getConfig()?.residency?.regions[workspaceRegion]?.apiUrl;
  const correctApiUrl =
    regionApiUrl !== undefined
      ? (brandedMcpHost(regionApiUrl) ?? regionApiUrl)
      : undefined;

  return {
    kind: "misrouted",
    status: 421,
    body: {
      error: "misdirected_request",
      message: `MCP requests for this workspace must be directed to the ${workspaceRegion} region.`,
      ...(correctApiUrl !== undefined ? { correctApiUrl } : {}),
      expectedRegion: workspaceRegion,
      actualRegion: apiRegion,
      requestId,
    },
  };
}

// ── Cross-workspace agent identity (#2073) ────────────────────────

/**
 * Header carrying a per-request workspace override. The MCP edge
 * resolves the runtime workspace via this priority chain (highest first):
 *
 *   1. `X-Atlas-Workspace`         — explicit per-request override
 *   2. `X-Atlas-Default-Workspace` — bridged from the agent's
 *      `ATLAS_DEFAULT_WORKSPACE` env at the framework boundary
 *      (forward-compat: today no MCP client framework auto-bridges
 *      the env, but the header is honored when an operator's wrapper
 *      sets it)
 *   3. Path workspace              — the URL pin (= JWT singular claim
 *      for legacy clients; an arbitrary granted workspace for
 *      multi-scope clients)
 *
 * Single-scope clients ignore (1) + (2) — only the path is consulted,
 * and it must equal the JWT singular claim. The priority chain only
 * fires for `multi`-scope clients.
 */
const WORKSPACE_OVERRIDE_HEADER = "x-atlas-workspace";
const WORKSPACE_DEFAULT_HEADER = "x-atlas-default-workspace";

interface WorkspaceResolution {
  /**
   * Non-empty workspace id. The resolver guards each branch with a
   * `length > 0` check, so an empty `X-Atlas-Workspace` header (or a
   * blank path segment) falls through to the next priority — never
   * surfaces here. The type doesn't enforce non-empty (TS has no
   * built-in `NonEmptyString`), but the resolver does, and downstream
   * consumers (`hasWorkspaceGrant`, `userIsWorkspaceMember`) treat it
   * as a workspace id without re-checking.
   */
  readonly resolved: string;
  readonly source: "header" | "default-header" | "path";
}

/**
 * Pick the runtime workspace for a multi-scope request. Returns the
 * source so the audit log can pivot on "which mechanism resolved this
 * request" — useful for debugging "why did my X-Atlas-Workspace get
 * ignored" (typo in the header name → falls through to default → looks
 * like the override never fired).
 */
function resolveMultiScopeWorkspace(
  req: Request,
  pathWorkspaceId: string,
): WorkspaceResolution {
  const override = req.headers.get(WORKSPACE_OVERRIDE_HEADER);
  if (override && override.length > 0) {
    return { resolved: override, source: "header" };
  }
  const defaultHeader = req.headers.get(WORKSPACE_DEFAULT_HEADER);
  if (defaultHeader && defaultHeader.length > 0) {
    return { resolved: defaultHeader, source: "default-header" };
  }
  return { resolved: pathWorkspaceId, source: "path" };
}

interface WorkspaceAdmissionResult {
  readonly kind: "ok";
  readonly resolvedOrgId: string;
}
interface WorkspaceAdmissionDenied {
  readonly kind: "denied";
  readonly status: 403;
  readonly body: {
    error: "cross_workspace_denied";
    message: string;
    hint: string;
    requestId: string;
  };
}
type WorkspaceAdmission = WorkspaceAdmissionResult | WorkspaceAdmissionDenied;

/**
 * Authorize the request against the (clientId, resolvedWorkspace) pair.
 *
 * Three checks for `multi`-scope clients:
 *   1. A grant row exists for (clientId, resolvedWorkspace) — admin
 *      policy (the user explicitly opted into this workspace at install
 *      time or via Settings).
 *   2. The user is a current member of `resolvedWorkspace` — org
 *      policy (membership can be revoked at any time, must take effect
 *      immediately).
 *   3. (Implicit) Both DB lookups must succeed — a Postgres outage
 *      surfaces upstream as `internal_error` from the catch in the
 *      router, never as a silent admit.
 *
 * `single`-scope clients short-circuit to the legacy path:
 * `pathWorkspaceId === verified.orgId`, no grant lookup, no membership
 * lookup. Existing single-workspace clients continue to work unchanged.
 */
async function authorizeWorkspaceAccess(
  req: Request,
  bearer: VerifiedBearer,
  pathWorkspaceId: string,
  requestId: string,
): Promise<WorkspaceAdmission> {
  const scope = await getOAuthClientScope(bearer.clientId);

  if (scope === "single") {
    if (pathWorkspaceId !== bearer.orgId) {
      log.warn(
        {
          requestId,
          claimWorkspaceId: bearer.orgId,
          pathWorkspaceId,
          clientId: bearer.clientId,
        },
        "MCP single-scope path/bearer mismatch — refusing dispatch",
      );
      emitWorkspaceDenialAudit({
        bearer,
        pathWorkspaceId,
        resolvedWorkspaceId: bearer.orgId,
        reason: "single_scope_mismatch",
      });
      return {
        kind: "denied",
        status: 403,
        body: {
          error: "cross_workspace_denied",
          message: "Access token not authorized for this workspace.",
          hint:
            "This OAuth client is bound to a single workspace. Re-run `bunx @useatlas/mcp init --hosted --write` from the target workspace, or upgrade the client to multi-workspace mode in Settings → AI Agents.",
          requestId,
        },
      };
    }
    return { kind: "ok", resolvedOrgId: bearer.orgId };
  }

  // multi-scope — run the priority chain.
  const resolution = resolveMultiScopeWorkspace(req, pathWorkspaceId);
  const resolvedOrgId = resolution.resolved;

  const [granted, member] = await Promise.all([
    hasWorkspaceGrant(bearer.clientId, resolvedOrgId),
    userIsWorkspaceMember(bearer.user.id, resolvedOrgId),
  ]);

  if (!granted || !member) {
    log.warn(
      {
        requestId,
        clientId: bearer.clientId,
        userId: bearer.user.id,
        resolvedOrgId,
        resolutionSource: resolution.source,
        granted,
        member,
      },
      "MCP cross-workspace request denied — missing grant or membership",
    );
    emitWorkspaceDenialAudit({
      bearer,
      pathWorkspaceId,
      resolvedWorkspaceId: resolvedOrgId,
      reason: granted ? "membership_revoked" : "missing_grant",
    });
    return {
      kind: "denied",
      status: 403,
      body: {
        error: "cross_workspace_denied",
        message: "Access token not authorized for this workspace.",
        hint: granted
          ? "Workspace membership has changed — confirm you are still a member of the requested workspace."
          : "This OAuth client has no grant for the requested workspace. Open Settings → AI Agents to manage which workspaces this agent can access.",
        requestId,
      },
    };
  }

  return { kind: "ok", resolvedOrgId };
}

/**
 * Audit hook for cross-workspace denial (#2073). Fires for every
 * `cross_workspace_denied` response AND for the 500-class branch where
 * the admission lookup itself threw — without this row, an attacker
 * probing during a Postgres incident produces no audit trail at all
 * and forensic queries asking "show me every denied cross-workspace
 * request today" miss the DB-outage class entirely.
 *
 * Wrapped in try/catch with the same discipline as
 * `emitSessionStartAudit` — audit emission must never break the
 * user-visible 403/500 response shape.
 */
type WorkspaceDenialReason =
  | "single_scope_mismatch"
  | "missing_grant"
  | "membership_revoked"
  | "admission_lookup_failed";

function emitWorkspaceDenialAudit(args: {
  readonly bearer: VerifiedBearer;
  readonly pathWorkspaceId: string;
  readonly resolvedWorkspaceId: string | null;
  readonly reason: WorkspaceDenialReason;
}): void {
  try {
    logAdminAction({
      actionType: ADMIN_ACTIONS.mcp_session.denied,
      targetType: "mcp_session",
      targetId: args.bearer.clientId,
      status: "failure",
      metadata: {
        clientId: args.bearer.clientId,
        userId: args.bearer.user.id,
        pathWorkspaceId: args.pathWorkspaceId,
        ...(args.resolvedWorkspaceId !== null
          ? { resolvedWorkspaceId: args.resolvedWorkspaceId }
          : {}),
        claimOrgId: args.bearer.orgId,
        reason: args.reason,
      },
    });
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        clientId: args.bearer.clientId,
        reason: args.reason,
      },
      "mcp_session.denied audit emission threw — denial response unaffected",
    );
  }
}

// ── Audit emission on session-init ──────────────────────────────────

function emitSessionStartAudit(
  bearer: VerifiedBearer,
  sessionId: string,
  region: string | null,
  resolvedOrgId: string,
): void {
  // The SDK invokes `onsessioninitialized` from inside its session-init
  // dispatch — a synchronous throw here propagates out and the SDK
  // returns a JSON-RPC parse error to the client, breaking the session.
  // Audit emission must never have that effect: a broken audit DB
  // should not block a legitimate MCP connection. The audit module
  // already swallows its own internal failures and writes pino lines;
  // we add this outer guard to also catch the rare case where the
  // module itself throws synchronously.
  //
  // #2073 — `orgId` is the RESOLVED workspace (post priority-chain),
  // not the JWT singular claim. Forensic queries that ask "rows from
  // workspace X" surface the workspace the request actually touched,
  // not the workspace the OAuth client was registered against.
  // `claimOrgId` is recorded separately so cross-workspace requests
  // remain reconstructable in the audit trail.
  try {
    logAdminAction({
      actionType: ADMIN_ACTIONS.mcp_session.start,
      targetType: "mcp_session",
      targetId: sessionId,
      metadata: {
        sessionId,
        orgId: resolvedOrgId,
        ...(bearer.orgId !== resolvedOrgId
          ? { claimOrgId: bearer.orgId }
          : {}),
        clientId: bearer.clientId,
        ...(bearer.tokenJti !== null ? { tokenJti: bearer.tokenJti } : {}),
        ...(region !== null ? { region } : {}),
        scopes: [...bearer.scopes],
      },
    });
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        sessionId,
        resolvedOrgId,
      },
      "mcp_session.start audit emission threw — session continues",
    );
  }
}

// ── Per-session bind helpers ────────────────────────────────────────

interface InitialFactoryContext {
  readonly user: AtlasUser;
  /**
   * #2073 — workspace identity for this request. The two fields are
   * grouped under a single sub-record so consumers can't accidentally
   * pluck the wrong one: `workspace.resolved` is what RLS / rate-limit /
   * approval / audit ALWAYS read (the post-priority-chain value);
   * `workspace.fromBearerClaim` is the JWT singular claim, recorded
   * alongside in audit metadata so cross-workspace requests stay
   * reconstructable. The structural separation prevents the previous
   * shape's `orgId` / `claimOrgId` ambiguity, where a refactor that
   * swapped the two looked correct at the type level but silently
   * pivoted the audit trail to the wrong workspace.
   */
  readonly workspace: {
    readonly resolved: string;
    readonly fromBearerClaim: string;
  };
  readonly clientId: string;
  readonly tokenJti: string | null;
  readonly scopes: ReadonlyArray<string>;
}

// Exported for unit testing (#3505) — asserts the live-role-resolution
// wiring without standing up a full hosted session.
export async function bindFactoryContext(
  bearer: VerifiedBearer,
  resolvedOrgId: string,
): Promise<InitialFactoryContext> {
  // #3505 — resolve the actor's effective ORG role LIVE from the `member`
  // table for the RESOLVED workspace, so RBAC gates see the current role
  // and a demoted/revoked member loses elevated tools immediately — no
  // token refresh, no TTL. Mirrors the authoritative-grants pattern used
  // for workspace admission.
  //
  // #3603 — the trusted-vs-hosted trust-boundary fork now lives in ONE place,
  // `resolveMcpActorRole`. The `hosted` arm passes `undefined` for the
  // user-level role (NEVER a token claim — #3505 mandates a live DB lookup),
  // so a cross-tenant `platform_admin` is deliberately NOT applied over a
  // customer-facing hosted OAuth session: it acts with the caller's member
  // role for the admitted workspace, not god-mode. stdio resolves the
  // user-level role too — the intentionally-narrower hosted boundary is
  // recorded in ADR-0016 §platform_admin (decision #3522). The seam fails
  // closed: a member-table read error yields no role → downstream defaults to
  // least privilege (`member`), never escalates.
  const role = await resolveMcpActorRole({
    transport: "hosted",
    userId: bearer.user.id,
    activeOrganizationId: resolvedOrgId,
  });

  // Re-bind the actor so RLS / audit / approval surfaces downstream see
  // the RESOLVED workspace as `activeOrganizationId`. Without this, the
  // per-tool frame would inherit the JWT's singular claim and any code
  // reading `actor.activeOrganizationId` would silently route to the
  // wrong workspace under the cross-workspace path.
  const user = createAtlasUser(bearer.user.id, bearer.user.mode, bearer.user.label, {
    ...(role !== undefined ? { role } : {}),
    activeOrganizationId: resolvedOrgId,
    claims:
      bearer.user.claims !== undefined
        ? { ...bearer.user.claims, [ATLAS_OAUTH_WORKSPACE_CLAIM]: resolvedOrgId }
        : { [ATLAS_OAUTH_WORKSPACE_CLAIM]: resolvedOrgId },
  });
  return {
    user,
    workspace: {
      resolved: resolvedOrgId,
      fromBearerClaim: bearer.orgId,
    },
    clientId: bearer.clientId,
    tokenJti: bearer.tokenJti,
    scopes: bearer.scopes,
  };
}

async function createBoundMcpServer(
  ctx: InitialFactoryContext,
): Promise<McpServer> {
  return createAtlasMcpServer({
    actor: ctx.user,
    transport: "sse",
    skipConfig: true,
    // #3504 — thread the bearer's OAuth scopes so write tools enforce mcp:write.
    scopes: ctx.scopes,
    // #2067 — surface the registered OAuth client_id into
    // `audit_log.client_id` so the admin filter can scope to "rows from
    // claude-desktop" without joining on token tables.
    clientId: ctx.clientId,
  });
}

// ── Request dispatch ────────────────────────────────────────────────

async function dispatchExistingSession(
  req: Request,
  sessionId: string,
  requestId: string,
  // #3569 — freshly-resolved factory context, re-resolved per request by
  // `bindFactoryContext`. Its `user` has a LIVE member-table role so gate-3
  // sees the current role and a demoted actor loses elevated tools on the
  // next tool call — no token refresh, no TTL.
  factoryCtx: InitialFactoryContext,
): Promise<Response> {
  const entry = sessions.get(sessionId);
  if (!entry) {
    return new Response(
      JSON.stringify({
        error: "unknown_session",
        message:
          "Session not found. Reconnect with a fresh initialize request.",
        requestId,
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  // The store owns the liveness wiring (lastSeenAt refresh, GET/POST stream
  // tracking — #3576). The hosted-only bit is the `withLiveActor` wrap:
  //
  // #3569 — set the freshly-resolved actor on the per-request live-actor
  // ALS BEFORE handing the request to the transport. `dispatch-gate.ts`
  // gate-3 reads from this store (not from the session-frozen `ctx.actor`
  // in the tool closure) so a mid-session demotion is revocation-immediate.
  // This ALS is separate from the api-layer `requestStore`, so nested
  // `withRequestContext` calls in tool dispatch bodies do not replace it.
  return sessions.dispatchExisting(req, entry, (run) =>
    withLiveActor(factoryCtx.user, run),
  );
}

async function dispatchNewSession(
  req: Request,
  ctx: InitialFactoryContext,
): Promise<Response> {
  // The store owns the cap-pressure sweep, the `pendingReservations` TOCTOU
  // guard, transport construction + lifecycle callbacks, and the
  // connect-failure / unregistered-leak teardown. The hosted-only bits — the
  // bearer-bound `McpServer` and the `mcp_session.start` audit row — are
  // supplied via the `NewSessionSpec`.
  const region = getApiRegion();
  return sessions.dispatchNew(req, {
    createServer: () => createBoundMcpServer(ctx),
    onRegistered: (id) => {
      emitSessionStartAudit(
        {
          kind: "ok",
          user: ctx.user,
          orgId: ctx.workspace.fromBearerClaim,
          clientId: ctx.clientId,
          tokenJti: ctx.tokenJti,
          scopes: ctx.scopes,
        },
        id,
        region,
        ctx.workspace.resolved,
      );
      log.info(
        {
          sessionId: id,
          orgId: ctx.workspace.resolved,
          clientId: ctx.clientId,
          region,
        },
        "MCP session created",
      );
    },
    tooManyMessage:
      "Too many active MCP sessions on this region. Try again later.",
  });
}

// ── Router ──────────────────────────────────────────────────────────

const HANDLED_METHODS = ["POST", "GET", "DELETE"];

/**
 * `WWW-Authenticate` header pointer at the protected-resource
 * metadata document. Per RFC 9728 + the MCP authorization spec, a
 * 401 from the resource server SHOULD include this header so the
 * client can discover the auth server without out-of-band config.
 *
 * The optional `scope` parameter is appended as RFC 6750 §3 directs
 * for `insufficient_scope` responses (currently a 403 path; the route
 * does not actually emit this header on 403 today, but the parameter
 * keeps the helper composable should the contract change).
 */
function wwwAuthenticateHeader(
  req: Request,
  workspaceId: string,
  scope?: string,
): string {
  const base =
    process.env.ATLAS_PUBLIC_API_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    new URL(req.url).origin;
  const trimmed = base.replace(/\/+$/, "");
  // #2068 — point clients at the brand hostname for SaaS so a client
  // that never sees the regional `api.*` URL can still complete DCR.
  // Self-hosted operators on arbitrary hostnames stay on the resolved
  // base. The well-known route is mounted under either hostname (DNS
  // CNAMEs fan in to the same Railway service), so the brand URL
  // resolves identically to the regional one.
  const metadataBase = brandedMcpHost(trimmed) ?? trimmed;
  const resourceMetadata = `${metadataBase}/.well-known/oauth-protected-resource/mcp/${workspaceId}`;
  const scopeAttr = scope ? `, scope="${scope}"` : "";
  return `Bearer realm="Atlas MCP", resource_metadata="${resourceMetadata}"${scopeAttr}`;
}

export function createHostedMcpRouter(): Hono {
  const router = new Hono();

  router.on(HANDLED_METHODS, "/:workspaceId/sse", async (c) => {
    const requestId = crypto.randomUUID();
    const pathWorkspaceId = c.req.param("workspaceId");

    const verified = await verifyMcpBearer(c.req.raw, requestId);
    if (verified.kind === "fail") {
      // Only emit `WWW-Authenticate` for failures that are genuine
      // auth challenges (RFC 6750 / RFC 9728): missing or invalid
      // bearer. Structural-claim failures and 503s suppress the
      // header — see `BearerFailure.emitChallengeHeader`'s docstring.
      const headers: Record<string, string> = {};
      if (verified.emitChallengeHeader) {
        headers["WWW-Authenticate"] = wwwAuthenticateHeader(
          c.req.raw,
          pathWorkspaceId,
          verified.body.scope,
        );
      }
      return c.json(verified.body, verified.status, headers);
    }

    // #2073 — workspace admission. Single-scope clients keep the legacy
    // `pathWorkspaceId === verified.orgId` check. Multi-scope clients
    // run the priority chain (header / default-header / path) and admit
    // only against grants + live membership. Mismatch → opaque 403 with
    // the structured `cross_workspace_denied` envelope (the hint guides
    // the user toward Settings → AI Agents or the CLI re-init flow).
    let admission: WorkspaceAdmission;
    try {
      admission = await authorizeWorkspaceAccess(
        c.req.raw,
        verified,
        pathWorkspaceId,
        requestId,
      );
    } catch (err) {
      log.error(
        {
          requestId,
          clientId: verified.clientId,
          err: err instanceof Error ? err.message : String(err),
        },
        "MCP workspace admission lookup failed — refusing dispatch",
      );
      // Emit a denial audit so forensic queries asking "show me every
      // cross-workspace request denied today" find this row even when
      // the underlying failure was an internal-DB outage rather than
      // a missing grant. Without this, a Postgres incident produces no
      // audit trail at all for the affected requests.
      emitWorkspaceDenialAudit({
        bearer: verified,
        pathWorkspaceId,
        resolvedWorkspaceId: null,
        reason: "admission_lookup_failed",
      });
      return c.json(
        {
          error: "internal_error",
          message: "Workspace authorization lookup failed.",
          requestId,
        },
        500,
      );
    }
    if (admission.kind === "denied") {
      return c.json(admission.body, admission.status);
    }
    const resolvedOrgId = admission.resolvedOrgId;

    const residency = await checkResidency(resolvedOrgId, requestId);
    if (residency.kind === "misrouted") {
      return c.json(residency.body, residency.status);
    }
    if (residency.kind === "unavailable") {
      return c.json(residency.body, residency.status);
    }

    const factoryCtx = await bindFactoryContext(verified, resolvedOrgId);
    const sessionId = c.req.raw.headers.get("mcp-session-id");

    try {
      return await withRequestContext(
        // #2072 — outermost MCP transport frame stamps the origin so
        // that any code that reads RequestContext before the per-tool
        // frame is entered (e.g. session bootstrap auditing) sees the
        // correct origin.
        { requestId, user: factoryCtx.user, atlasMode: "published", agentOrigin: "mcp" },
        async () => {
          if (sessionId) {
            return dispatchExistingSession(c.req.raw, sessionId, requestId, factoryCtx);
          }
          return dispatchNewSession(c.req.raw, factoryCtx);
        },
      );
    } catch (err) {
      log.error(
        {
          requestId,
          orgId: factoryCtx.workspace.resolved,
          err: err instanceof Error ? err.message : String(err),
        },
        "MCP dispatch failed",
      );
      return c.json(
        {
          error: "internal_error",
          message: "MCP request handling failed.",
          requestId,
        },
        500,
      );
    }
  });

  return router;
}
