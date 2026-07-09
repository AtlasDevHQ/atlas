/**
 * Streamable HTTP server for the Atlas MCP server.
 *
 * Uses the MCP SDK's WebStandardStreamableHTTPServerTransport which works
 * natively with Bun's Web Standard APIs (Request/Response/ReadableStream).
 *
 * The SDK's transport handles HTTP method dispatch internally: POST for
 * JSON-RPC, GET to open a notification stream, DELETE for session termination.
 * (GET, and request-bearing POST, responses are `text/event-stream`-encoded —
 * that SSE framing is Streamable HTTP's streaming wire format, NOT the
 * deprecated HTTP+SSE transport, which used a dedicated long-lived GET stream +
 * a separate POST message endpoint. Notification-only POSTs return 202.)
 *
 * Endpoints:
 * - /mcp     — All MCP traffic (POST, GET, DELETE) delegated to the SDK transport
 * - /health  — Health check
 *
 * ── Session hardening (#3492, #3600) ───────────────────────────────
 *
 * The session lifecycle — idle-session sweep, `pendingReservations` TOCTOU
 * cap guard, `ATLAS_MCP_MAX_SESSIONS` resolution, and GET/POST stream
 * liveness — is owned by the shared `McpSessionStore` (`session-store.ts`),
 * the SAME unit `hosted.ts` uses. Before #3600 this logic was duplicated
 * here and kept "in lockstep" with `hosted.ts` by hand; a future
 * transport/session-policy change now lands once.
 *
 * The one intentional shape difference from hosted: `streamable-http.ts` is a
 * multi-instance factory — each `startStreamableHttpServer` call constructs its OWN
 * `McpSessionStore`, so the session map and reservation counter are
 * per-server (closure-scoped), and the per-instance test seams hang off the
 * returned handle (`_sessionCount`, `_sweepIdleSessionsForTests`). hosted, by
 * contrast, owns a single module-scoped store. The env-driven idle-timeout
 * override (`_setIdleTimeoutForTests`) is module-scoped in the store and
 * re-exported here unchanged.
 *
 * @example
 * ```typescript
 * import { createAtlasMcpServer } from "./server.js";
 * import { startStreamableHttpServer } from "./streamable-http.js";
 *
 * const handle = await startStreamableHttpServer(
 *   () => createAtlasMcpServer(),
 *   { port: 8080 },
 * );
 * ```
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLogger } from "@atlas/api/lib/logger";
import {
  McpSessionStore,
  resolveMaxSessions,
  sessionIdleTimeoutMs,
  _setIdleTimeoutForTests,
} from "./session-store.js";

// Re-exported unchanged so the test seam keeps its import path (`../streamable-http.js`).
// The override is module-scoped in `session-store.ts` (it tunes env-driven
// timeout resolution, not any one server instance's store).
export { _setIdleTimeoutForTests };

const log = createLogger("mcp-streamable-http");

const DEFAULT_PORT = 8080;

interface StreamableHttpServerOptions {
  /** Port to listen on. 0 for OS-assigned ephemeral port. Default: 8080. */
  port?: number;
  /** Hostname to bind to. Default: "0.0.0.0". */
  hostname?: string;
  /** CORS allowed origin. Default: "*". */
  corsOrigin?: string;
  /**
   * Maximum concurrent sessions. When omitted, the cap resolves through
   * the env-profile via `resolveMcpMaxSessions` (the `ATLAS_MCP_MAX_SESSIONS`
   * override wins when a positive integer, otherwise the deploy-env profile
   * default — 100). An explicit value here always wins over the env so a
   * caller can pin the cap regardless of the ambient environment.
   */
  maxSessions?: number;
}

interface StreamableHttpServerHandle {
  /** Read-only info about the running server. */
  readonly server: {
    readonly port: number;
    readonly hostname: string;
    readonly url: string;
  };
  /** Gracefully stop the server, close all transports and per-session MCP servers. */
  close(): Promise<void>;
  /**
   * @internal — test-only. Current live session count for this instance.
   * Mirrors `hosted.ts:_hostedSessionCount`, but bound to this server's
   * own `McpSessionStore` rather than the module-scoped one hosted owns.
   */
  _sessionCount(): number;
  /**
   * @internal — test-only. Drive the idle sweep deterministically with a
   * pinned clock against this instance's store. Mirrors
   * `hosted.ts:_sweepIdleSessionsForTests`; returns the number evicted.
   * `heldStreamMaxAgeMs` overrides the max-held-stream-age for the sweep
   * (#3576); pass `Infinity` to disable stream-age reclaim.
   */
  _sweepIdleSessionsForTests(now?: number, idleTimeoutMs?: number, heldStreamMaxAgeMs?: number): number;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, mcp-protocol-version",
    "Access-Control-Expose-Headers": "mcp-session-id",
  };
}

/**
 * Start a Bun HTTP server that serves the MCP server over Streamable HTTP.
 *
 * Each new initialization request creates a fresh McpServer (via createServer)
 * and a WebStandardStreamableHTTPServerTransport with a unique session ID.
 * Subsequent requests include the session ID header and are routed to the
 * correct transport.
 *
 * Returns a handle with read-only server info and close() for graceful shutdown.
 * Pass port: 0 for an OS-assigned ephemeral port.
 */
export async function startStreamableHttpServer(
  createServer: () => Promise<McpServer>,
  opts?: StreamableHttpServerOptions,
): Promise<StreamableHttpServerHandle> {
  const port = opts?.port ?? DEFAULT_PORT;
  const hostname = opts?.hostname ?? "0.0.0.0";
  const origin = opts?.corsOrigin ?? "*";
  const explicitMaxSessions = opts?.maxSessions;

  if (port !== 0 && (isNaN(port) || port < 1 || port > 65535)) {
    throw new Error(`Invalid port: ${port}. Must be 0 (ephemeral) or 1-65535.`);
  }

  const cors = corsHeaders(origin);

  // Per-instance session store (#3600): each `startStreamableHttpServer` call owns its
  // own cap / session map / reservation counter — the intentional shape
  // difference from hosted's single module-scoped store. An explicit
  // `opts.maxSessions` wins over the env via the cap resolver passed here.
  const store = new McpSessionStore(() => resolveMaxSessions(explicitMaxSessions));

  async function handleMcpRequest(req: Request): Promise<Response> {
    const sessionId = req.headers.get("mcp-session-id");

    if (sessionId) {
      const entry = store.get(sessionId);
      if (entry) {
        return store.dispatchExisting(req, entry);
      }
      return new Response("Session not found", { status: 404 });
    }

    return store.dispatchNew(req, {
      createServer,
      onRegistered: (id) => {
        log.info({ sessionId: id }, "Session created");
      },
      tooManyMessage: "Too many active MCP sessions. Try again later.",
    });
  }

  const bunServer = Bun.serve({
    port,
    hostname,
    idleTimeout: 0, // long-lived notification streams — no idle timeout
    error(err) {
      log.error({ err }, "Unhandled server error");
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
      );
    },
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }

      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            status: "ok",
            // Kept as "sse" deliberately: this label (and the OTel `transport`
            // dimension in metrics.ts / mcp-tools.ts) is a telemetry contract
            // whose dashboard consumers can't be verified from here — renaming
            // it is the deferred Tier 3 of #4169, done in lockstep with those.
            transport: "sse",
            sessions: store.size,
          }),
          { headers: { ...cors, "Content-Type": "application/json" } },
        );
      }

      if (url.pathname === "/mcp") {
        try {
          const response = await handleMcpRequest(req);
          const newHeaders = new Headers(response.headers);
          for (const [key, value] of Object.entries(cors)) {
            newHeaders.set(key, value);
          }
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          log.error({ err: detail }, "Request error");
          return new Response(
            JSON.stringify({ error: "Internal server error" }),
            { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
          );
        }
      }

      return new Response("Not Found", { status: 404, headers: cors });
    },
  });

  return {
    server: {
      port: bunServer.port!,
      hostname: bunServer.hostname!,
      url: bunServer.url.toString(),
    },
    async close() {
      await store.reset();
      await bunServer.stop(true);
    },
    _sessionCount() {
      return store.size;
    },
    _sweepIdleSessionsForTests(now?: number, idleTimeoutMs?: number, heldStreamMaxAgeMs?: number): number {
      return store.sweep(
        now ?? Date.now(),
        idleTimeoutMs ?? sessionIdleTimeoutMs(),
        heldStreamMaxAgeMs,
      );
    },
  };
}
