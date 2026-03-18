/**
 * Streamable HTTP server for the Atlas MCP server.
 *
 * Uses the MCP SDK's WebStandardStreamableHTTPServerTransport which works
 * natively with Bun's Web Standard APIs (Request/Response/ReadableStream).
 *
 * The SDK's transport handles HTTP method dispatch internally:
 * POST for JSON-RPC, GET for SSE notifications, DELETE for session termination.
 *
 * Endpoints:
 * - /mcp     — All MCP traffic (POST, GET, DELETE) delegated to the SDK transport
 * - /health  — Health check
 *
 * @example
 * ```typescript
 * import { createAtlasMcpServer } from "./server.js";
 * import { startSseServer } from "./sse.js";
 *
 * const handle = await startSseServer(
 *   () => createAtlasMcpServer(),
 *   { port: 8080 },
 * );
 * ```
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("mcp-sse");

const DEFAULT_PORT = 8080;
const DEFAULT_MAX_SESSIONS = 100;

interface SseServerOptions {
  /** Port to listen on. 0 for OS-assigned ephemeral port. Default: 8080. */
  port?: number;
  /** Hostname to bind to. Default: "0.0.0.0". */
  hostname?: string;
  /** CORS allowed origin. Default: "*". */
  corsOrigin?: string;
  /** Maximum concurrent sessions. Default: 100. */
  maxSessions?: number;
}

interface SseServerHandle {
  /** Read-only info about the running server. */
  readonly server: {
    readonly port: number;
    readonly hostname: string;
    readonly url: string;
  };
  /** Gracefully stop the server, close all transports and per-session MCP servers. */
  close(): Promise<void>;
}

type SessionEntry = {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
};
type SessionMap = Map<string, SessionEntry>;

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, mcp-protocol-version",
    "Access-Control-Expose-Headers": "mcp-session-id",
  };
}

/**
 * Start a Bun HTTP server that serves the MCP server over Streamable HTTP (SSE).
 *
 * Each new initialization request creates a fresh McpServer (via createServer)
 * and a WebStandardStreamableHTTPServerTransport with a unique session ID.
 * Subsequent requests include the session ID header and are routed to the
 * correct transport.
 *
 * Returns a handle with read-only server info and close() for graceful shutdown.
 * Pass port: 0 for an OS-assigned ephemeral port.
 */
export async function startSseServer(
  createServer: () => Promise<McpServer>,
  opts?: SseServerOptions,
): Promise<SseServerHandle> {
  const port = opts?.port ?? DEFAULT_PORT;
  const hostname = opts?.hostname ?? "0.0.0.0";
  const origin = opts?.corsOrigin ?? "*";
  const maxSessions = opts?.maxSessions ?? DEFAULT_MAX_SESSIONS;

  if (port !== 0 && (isNaN(port) || port < 1 || port > 65535)) {
    throw new Error(`Invalid port: ${port}. Must be 0 (ephemeral) or 1-65535.`);
  }

  const sessions: SessionMap = new Map();
  const cors = corsHeaders(origin);

  async function handleMcpRequest(req: Request): Promise<Response> {
    const sessionId = req.headers.get("mcp-session-id");

    if (sessionId && sessions.has(sessionId)) {
      const entry = sessions.get(sessionId)!;
      return entry.transport.handleRequest(req);
    }

    if (sessionId) {
      return new Response("Session not found", { status: 404 });
    }

    if (sessions.size >= maxSessions) {
      return new Response(
        JSON.stringify({ error: "Too many active sessions. Try again later." }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }

    // New session — create a per-session MCP server and transport
    const mcpServer = await createServer();

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server: mcpServer });
        log.info({ sessionId: id }, "Session created");
      },
      onsessionclosed: (id) => {
        const entry = sessions.get(id);
        if (entry) {
          sessions.delete(id);
          entry.server.close().catch((err) => {
            const detail = err instanceof Error ? err.message : String(err);
            log.warn({ sessionId: id, err: detail }, "Failed to close server");
          });
        }
        log.info({ sessionId: id }, "Session closed");
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && sessions.has(sid)) {
        const entry = sessions.get(sid)!;
        sessions.delete(sid);
        entry.server.close().catch(() => {});
      }
    };

    try {
      await mcpServer.connect(transport);
    } catch (err) {
      await transport.close().catch(() => {});
      await mcpServer.close().catch(() => {});
      throw err;
    }

    return transport.handleRequest(req);
  }

  const bunServer = Bun.serve({
    port,
    hostname,
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
            transport: "sse",
            sessions: sessions.size,
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
      // Take ownership of all entries and clear the map to prevent
      // callback-triggered double-cleanup
      const entries = [...sessions.entries()];
      sessions.clear();

      for (const [sessionId, entry] of entries) {
        await entry.transport.close().catch((err) => {
          const detail = err instanceof Error ? err.message : String(err);
          log.warn({ sessionId, err: detail }, "Failed to close transport");
        });
        await entry.server.close().catch((err) => {
          const detail = err instanceof Error ? err.message : String(err);
          log.warn({ sessionId, err: detail }, "Failed to close server");
        });
      }

      bunServer.stop(true);
    },
  };
}
