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
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
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
import { createAtlasMcpServer } from "./server.js";

const log = createLogger("mcp-hosted");

// ── Module-scoped session store ────────────────────────────────────

interface SessionEntry {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly server: McpServer;
}

const sessions = new Map<string, SessionEntry>();

// Reservation counter prevents the TOCTOU between the cap check and
// the async `createAtlasMcpServer` call. `sessions.size` only reflects
// post-`onsessioninitialized` state; with N concurrent inits, all N
// would pass a naïve `sessions.size >= max` check before any registers.
// We bump this counter at the gate and decrement on failure or after
// the session is registered.
let pendingReservations = 0;

const DEFAULT_MAX_SESSIONS = 100;

function maxSessions(): number {
  const raw = process.env.ATLAS_MCP_MAX_SESSIONS;
  if (!raw) return DEFAULT_MAX_SESSIONS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    log.warn(
      { raw },
      "ATLAS_MCP_MAX_SESSIONS is not a positive integer — falling back to default",
    );
    return DEFAULT_MAX_SESSIONS;
  }
  return parsed;
}

export function _hostedSessionCount(): number {
  return sessions.size;
}

export async function _resetHostedSessions(): Promise<void> {
  const entries = [...sessions.entries()];
  sessions.clear();
  pendingReservations = 0;
  for (const [, entry] of entries) {
    // intentionally ignored: best-effort teardown — the test reset
    // path runs in afterEach, so a hanging close should not fail the
    // suite. Real shutdown emits warnings via onsessionclosed.
    await entry.transport.close().catch(() => {});
    await entry.server.close().catch(() => {});
  }
}

// ── OAuth 2.1 verification ─────────────────────────────────────────
//
// Custom-claim key for the authenticated workspace. Set on every issued
// access token by `customAccessTokenClaims` in server.ts. Stored as a
// URN-shaped string so it cannot collide with future standard JWT claims
// — Atlas-namespaced custom claims should always look like this.
const WORKSPACE_CLAIM = "https://atlas.useatlas.dev/workspace_id";

/**
 * Required scopes for any MCP request. Today every shipping MCP tool
 * is read-only (executeSQL is read-only by validation, semantic-layer
 * tools are reads). When write tools land, gate them at the tool layer
 * on `mcp:write` and keep the connection-level requirement at
 * `mcp:read` so existing clients keep working.
 */
const REQUIRED_SCOPES = ["mcp:read"] as const;

/**
 * Build the resource-server audience for this API instance. Tokens
 * issued for this MCP region must have `aud` matching this exactly. We
 * resolve from the env in the same order as well-known.ts so the
 * audience advertised in the protected-resource metadata equals the
 * audience accepted here.
 */
function resourceAudience(req: Request): string {
  const base =
    process.env.ATLAS_PUBLIC_API_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    new URL(req.url).origin;
  return `${base.replace(/\/+$/, "")}/mcp`;
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

interface VerifiedBearer {
  readonly user: AtlasUser;
  readonly orgId: string;
  readonly clientId: string;
  readonly tokenJti: string | null;
  readonly scopes: ReadonlyArray<string>;
}

interface BearerFailure {
  readonly status: 401 | 403;
  readonly body: {
    error: string;
    message: string;
    requestId: string;
  };
}

/**
 * Extract + verify the bearer. Returns either a verified identity
 * envelope or a structured failure for the route to surface.
 *
 * `verifyAccessToken` failures all collapse to 401 here. The route
 * adds 403 separately when the claim's workspace_id mismatches the
 * URL's `{workspace_id}` — that's a different failure ("you have a
 * valid token, just not for this URL") and the wire shape is the
 * MCP spec's `WWW-Authenticate` 401 vs an opaque 403.
 */
async function verifyMcpBearer(
  req: Request,
  requestId: string,
): Promise<VerifiedBearer | BearerFailure> {
  const auth = req.headers.get("authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) {
    return {
      status: 401,
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
      status: 401,
      body: {
        error: "missing_bearer",
        message: "Bearer token is empty.",
        requestId,
      },
    };
  }

  try {
    const payload = await verifyAccessToken(token, {
      verifyOptions: {
        audience: resourceAudience(req),
        issuer: tokenIssuer(req),
      },
      scopes: [...REQUIRED_SCOPES],
      jwksUrl: jwksUrl(req),
    });

    // Extract the workspace claim; the route enforces path/claim
    // match, so a missing claim is unauthenticated (401) rather than
    // forbidden — the token was issued under a session with no active
    // org, which is a misconfiguration on the issuer side.
    const orgIdRaw = (payload as Record<string, unknown>)[WORKSPACE_CLAIM];
    if (typeof orgIdRaw !== "string" || orgIdRaw.length === 0) {
      log.warn(
        { requestId, sub: typeof payload.sub === "string" ? payload.sub : null },
        "MCP bearer is valid but carries no workspace claim — token issued without an active organization",
      );
      return {
        status: 401,
        body: {
          error: "missing_workspace_claim",
          message:
            "Access token does not carry a workspace claim. Re-authenticate after selecting a workspace.",
          requestId,
        },
      };
    }

    const sub = typeof payload.sub === "string" ? payload.sub : null;
    const azp = (payload as { azp?: unknown }).azp;
    const clientId = typeof azp === "string" ? azp : "unknown_client";

    if (!sub) {
      // A JWT without `sub` cannot be tied to an actor. Refuse to
      // proceed — every audit row and every per-tool authorization
      // check downstream needs an actor id.
      return {
        status: 401,
        body: {
          error: "missing_subject",
          message: "Access token does not carry a subject claim.",
          requestId,
        },
      };
    }

    const user = createAtlasUser(sub, "managed", sub, {
      activeOrganizationId: orgIdRaw,
      claims: { ...payload, [WORKSPACE_CLAIM]: orgIdRaw },
    });

    const scopeRaw = (payload as { scope?: unknown }).scope;
    const scopes =
      typeof scopeRaw === "string" ? scopeRaw.split(/\s+/).filter(Boolean) : [];

    return {
      user,
      orgId: orgIdRaw,
      clientId,
      tokenJti: typeof payload.jti === "string" ? payload.jti : null,
      scopes,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { requestId, err: message },
      "MCP bearer verification failed — returning 401",
    );
    return {
      status: 401,
      body: {
        error: "invalid_bearer",
        message:
          "Access token did not verify. Check audience, issuer, scopes, and expiry.",
        requestId,
      },
    };
  }
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

  const correctApiUrl =
    getConfig()?.residency?.regions[workspaceRegion]?.apiUrl;

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

// ── Audit emission on session-init ──────────────────────────────────

function emitSessionStartAudit(
  bearer: VerifiedBearer,
  sessionId: string,
  region: string | null,
): void {
  // The SDK invokes `onsessioninitialized` from inside its session-init
  // dispatch — a synchronous throw here propagates out and the SDK
  // returns a JSON-RPC parse error to the client, breaking the session.
  // Audit emission must never have that effect: a broken audit DB
  // should not block a legitimate MCP connection. The audit module
  // already swallows its own internal failures and writes pino lines;
  // we add this outer guard to also catch the rare case where the
  // module itself throws synchronously.
  try {
    logAdminAction({
      actionType: ADMIN_ACTIONS.mcp_session.start,
      targetType: "mcp_session",
      targetId: sessionId,
      metadata: {
        sessionId,
        orgId: bearer.orgId,
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
        orgId: bearer.orgId,
      },
      "mcp_session.start audit emission threw — session continues",
    );
  }
}

// ── Per-session bind helpers ────────────────────────────────────────

interface InitialFactoryContext {
  readonly user: AtlasUser;
  readonly orgId: string;
  readonly clientId: string;
  readonly tokenJti: string | null;
  readonly scopes: ReadonlyArray<string>;
}

function bindFactoryContext(bearer: VerifiedBearer): InitialFactoryContext {
  return {
    user: bearer.user,
    orgId: bearer.orgId,
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
  });
}

// ── Request dispatch ────────────────────────────────────────────────

async function dispatchExistingSession(
  req: Request,
  sessionId: string,
  requestId: string,
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
  return entry.transport.handleRequest(req);
}

async function dispatchNewSession(
  req: Request,
  ctx: InitialFactoryContext,
): Promise<Response> {
  const cap = maxSessions();
  if (sessions.size + pendingReservations >= cap) {
    return new Response(
      JSON.stringify({
        error: "too_many_sessions",
        message: "Too many active MCP sessions on this region. Try again later.",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  pendingReservations++;
  let registered = false;

  try {
    const mcpServer = await createBoundMcpServer(ctx);
    const region = getApiRegion();

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server: mcpServer });
        registered = true;
        emitSessionStartAudit(
          {
            user: ctx.user,
            orgId: ctx.orgId,
            clientId: ctx.clientId,
            tokenJti: ctx.tokenJti,
            scopes: ctx.scopes,
          },
          id,
          region,
        );
        log.info(
          {
            sessionId: id,
            orgId: ctx.orgId,
            clientId: ctx.clientId,
            region,
          },
          "MCP session created",
        );
      },
      onsessionclosed: (id) => {
        const entry = sessions.get(id);
        if (entry) {
          sessions.delete(id);
          entry.server.close().catch((err) => {
            log.warn(
              {
                sessionId: id,
                err: err instanceof Error ? err.message : String(err),
              },
              "Failed to close per-session MCP server",
            );
          });
        }
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && sessions.has(sid)) {
        const entry = sessions.get(sid)!;
        sessions.delete(sid);
        // intentionally ignored: transport.onclose fires from the
        // SDK's own cleanup path; surfacing a server-close error
        // here would have nowhere to go.
        entry.server.close().catch(() => {});
      }
    };

    try {
      await mcpServer.connect(transport);
    } catch (err) {
      // intentionally ignored: cleanup-and-rethrow — the connect
      // error is the signal; we just want to release the resources
      // before propagating.
      await transport.close().catch(() => {});
      await mcpServer.close().catch(() => {});
      throw err;
    }

    const response = await transport.handleRequest(req);

    // The leak path: a non-initialize first frame (no `mcp-session-id`
    // header) is rejected by the SDK without firing
    // `onsessioninitialized`. The server + transport stay live but
    // unregistered, so nothing ever cleans them up. Detect via the
    // `registered` flag set inside the init callback and tear down
    // here. Without this, every malformed first frame leaks one
    // McpServer per request.
    if (!registered) {
      // intentionally ignored: best-effort teardown of an
      // unregistered session — we already lost the request, no point
      // surfacing close errors that nothing can act on.
      await transport.close().catch(() => {});
      await mcpServer.close().catch(() => {});
    }

    return response;
  } finally {
    pendingReservations--;
  }
}

// ── Router ──────────────────────────────────────────────────────────

const HANDLED_METHODS = ["POST", "GET", "DELETE"];

/**
 * `WWW-Authenticate` header pointer at the protected-resource
 * metadata document. Per RFC 9728 + the MCP authorization spec, a
 * 401 from the resource server SHOULD include this header so the
 * client can discover the auth server without out-of-band config.
 */
function wwwAuthenticateHeader(req: Request, workspaceId: string): string {
  const base =
    process.env.ATLAS_PUBLIC_API_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    new URL(req.url).origin;
  const trimmed = base.replace(/\/+$/, "");
  const resourceMetadata = `${trimmed}/.well-known/oauth-protected-resource/mcp/${workspaceId}`;
  return `Bearer realm="Atlas MCP", resource_metadata="${resourceMetadata}"`;
}

export function createHostedMcpRouter(): Hono {
  const router = new Hono();

  router.on(HANDLED_METHODS, "/:workspaceId/sse", async (c) => {
    const requestId = crypto.randomUUID();
    const pathWorkspaceId = c.req.param("workspaceId");

    const verified = await verifyMcpBearer(c.req.raw, requestId);
    if ("status" in verified) {
      const headers: Record<string, string> = {
        "WWW-Authenticate": wwwAuthenticateHeader(c.req.raw, pathWorkspaceId),
      };
      return c.json(verified.body, verified.status, headers);
    }

    // Path/claim mismatch is opaque 403 — 404 would leak whether the
    // path workspace exists, 401 would say the bearer is invalid (it
    // isn't, just not for this URL).
    if (pathWorkspaceId !== verified.orgId) {
      log.warn(
        {
          requestId,
          claimWorkspaceId: verified.orgId,
          pathWorkspaceId,
          clientId: verified.clientId,
        },
        "MCP path/bearer workspace mismatch — refusing dispatch",
      );
      return c.json(
        {
          error: "forbidden",
          message: "Access token not authorized for this workspace.",
          requestId,
        },
        403,
      );
    }

    const residency = await checkResidency(verified.orgId, requestId);
    if (residency.kind === "misrouted") {
      return c.json(residency.body, residency.status);
    }
    if (residency.kind === "unavailable") {
      return c.json(residency.body, residency.status);
    }

    const factoryCtx = bindFactoryContext(verified);
    const sessionId = c.req.raw.headers.get("mcp-session-id");

    try {
      return await withRequestContext(
        { requestId, user: factoryCtx.user, atlasMode: "published" },
        async () => {
          if (sessionId) {
            return dispatchExistingSession(c.req.raw, sessionId, requestId);
          }
          return dispatchNewSession(c.req.raw, factoryCtx);
        },
      );
    } catch (err) {
      log.error(
        {
          requestId,
          orgId: factoryCtx.orgId,
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
