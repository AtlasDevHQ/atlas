/**
 * Hosted MCP endpoint — Hono router that mounts on the existing per-region
 * API server.
 *
 * Self-hosted users connect via stdio (the bunx installer in @useatlas/mcp).
 * SaaS users connect via this hosted endpoint:
 *
 *   POST   /mcp/{workspace_id}/sse   — JSON-RPC frames
 *   GET    /mcp/{workspace_id}/sse   — SSE notifications
 *   DELETE /mcp/{workspace_id}/sse   — explicit session termination
 *
 * Why a route on the existing api server (not a separate service):
 *   - The work MCP does (semantic-layer reads, executeSQL) already runs on
 *     the api/api-eu/api-apac instances. Mounting MCP as a route colocates
 *     it with the data path and inherits the existing per-region residency
 *     guarantees.
 *   - Per-region routing fails closed: if the workspace's region cannot
 *     be resolved (DB lookup throws), this surface returns 503, never
 *     serves traffic from a region that may be the wrong one. The shared
 *     `detectMisrouting` helper used by the data path is graceful by
 *     default — that's the wrong contract for the agent path, where a
 *     single request can fan out into many tool calls.
 *
 * Why path-scoped by workspace ID:
 *   - The bearer already names the workspace (the token store resolves
 *     `org_id`). The path param exists so an attacker who steals a token
 *     from workspace A cannot point the same bearer at workspace B's URL
 *     and probe for inconsistent behavior — mismatch is 403, not 404,
 *     and never leaks whether the workspace exists.
 *
 * Session ownership:
 *   - Each new session creates a fresh `McpServer` bound to the bearer's
 *     identity (`createAtlasMcpServer({ actor: bearerUser })`). The
 *     server lives for the duration of the session; the per-session
 *     transport handles JSON-RPC dispatch internally.
 *   - The bearer's identity is captured at session-init and reused for
 *     every JSON-RPC frame in that session. A session never crosses
 *     identities even if the same bearer is reused across sessions.
 *
 * Audit emission:
 *   - `mcp_token.use` fires on session-init notification — sampled, not
 *     per JSON-RPC frame. A single agent connection can issue thousands
 *     of frames per session; per-frame emission would drown the audit
 *     log without adding signal.
 */

import { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { mcpBearerAuth } from "@atlas/api/api/routes/mcp-middleware";
import type { AuthEnv } from "@atlas/api/api/routes/middleware";
import { getApiRegion } from "@atlas/api/lib/residency/misrouting";
import { getWorkspaceRegion } from "@atlas/api/lib/db/internal";
import { getConfig } from "@atlas/api/lib/config";
import { withRequestContext, createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { getMcpTokenId } from "@atlas/api/lib/auth/mcp-bearer";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
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

// ── Residency check (fail-closed) ──────────────────────────────────
//
// Distinct from the data path's `detectMisrouting` which is graceful
// by default: a DB lookup throw there logs a warning and serves the
// request as in-region. The MCP surface cannot tolerate that failure
// mode — a region-lookup miss could route an EU workspace through US.

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

function emitTokenUseAudit(
  tokenId: string,
  orgId: string,
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
  // module itself throws synchronously (e.g. malformed systemActor).
  try {
    logAdminAction({
      actionType: ADMIN_ACTIONS.mcp_token.use,
      targetType: "mcp_token",
      targetId: tokenId,
      metadata: {
        sessionId,
        orgId,
        ...(region !== null ? { region } : {}),
      },
    });
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        sessionId,
        tokenId,
      },
      "mcp_token.use audit emission threw — session continues",
    );
  }
}

// ── Per-session bind helpers ────────────────────────────────────────
//
// `bindFactoryContext` is the only constructor for `InitialFactoryContext`.
// It derives every field from the verified `AtlasUser` so a future caller
// cannot mix path-param and bearer-derived workspaceIds. The runtime
// guard for missing claims is also captured here, in one place.

interface InitialFactoryContext {
  readonly user: AtlasUser;
  readonly orgId: string;
  readonly tokenId: string;
}

function bindFactoryContext(
  user: AtlasUser | undefined,
): InitialFactoryContext | null {
  if (!user) return null;
  const orgId = user.activeOrganizationId;
  const tokenId = getMcpTokenId(user);
  if (!orgId || !tokenId) return null;
  return { user, orgId, tokenId };
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
        emitTokenUseAudit(ctx.tokenId, ctx.orgId, id, region);
        log.info(
          { sessionId: id, orgId: ctx.orgId, tokenId: ctx.tokenId, region },
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

export function createHostedMcpRouter(): Hono<AuthEnv> {
  const router = new Hono<AuthEnv>();

  router.use("*", mcpBearerAuth);

  router.on(HANDLED_METHODS, "/:workspaceId/sse", async (c) => {
    const requestId = c.get("requestId");
    const authResult = c.get("authResult");
    const factoryCtx = bindFactoryContext(authResult.user);

    // mcpBearerAuth guarantees both fields are set; this guard
    // protects against a future refactor that loosens the contract.
    if (!factoryCtx) {
      log.error(
        { requestId },
        "MCP bearer authenticated without orgId/tokenId — refusing to dispatch",
      );
      return c.json(
        {
          error: "auth_error",
          message: "MCP authentication system error",
          requestId,
        },
        500,
      );
    }

    const pathWorkspaceId = c.req.param("workspaceId");

    // Path/bearer mismatch is opaque 403 — 404 would leak whether the
    // path workspace exists, 401 would say the bearer is invalid (it
    // isn't, just not for this URL).
    if (pathWorkspaceId !== factoryCtx.orgId) {
      log.warn(
        {
          requestId,
          bearerOrgId: factoryCtx.orgId,
          pathWorkspaceId,
          tokenId: factoryCtx.tokenId,
        },
        "MCP path/bearer workspace mismatch — refusing dispatch",
      );
      return c.json(
        {
          error: "forbidden",
          message: "MCP token not authorized for this workspace.",
          requestId,
        },
        403,
      );
    }

    const residency = await checkResidency(factoryCtx.orgId, requestId);
    if (residency.kind === "misrouted") {
      return c.json(residency.body, residency.status);
    }
    if (residency.kind === "unavailable") {
      return c.json(residency.body, residency.status);
    }

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
