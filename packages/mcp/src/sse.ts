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
 * ── Session hardening (#3492) ──────────────────────────────────────
 *
 * This standalone transport mirrors the session-lifecycle hardening that
 * `hosted.ts` carries: an idle-session sweep, a `pendingReservations`
 * TOCTOU cap guard, and `ATLAS_MCP_MAX_SESSIONS` honored via
 * `resolveMcpMaxSessions`. Without these, a self-hosted `--transport sse`
 * deployment permanently exhausts its session pool once enough clients
 * vanish without sending the explicit `DELETE` (Streamable HTTP has no
 * transport-level disconnect event). Patterns/naming are kept in lockstep
 * with `hosted.ts` so the two transports stay legible side-by-side. The
 * one intentional shape difference: `sse.ts` is a multi-instance factory
 * (each `startSseServer` call owns its own session store), so the session
 * map and the `pendingReservations` counter live in the closure rather
 * than at module scope, and the per-instance test seams hang off the
 * returned handle (`_sessionCount`, `_sweepIdleSessionsForTests`) instead
 * of being module exports.
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
import { resolveMcpMaxSessions } from "@atlas/api/lib/env-profile";
import { createLogger } from "@atlas/api/lib/logger";
import { trackResponseStreamLifetime } from "./stream-liveness.js";

const log = createLogger("mcp-sse");

const DEFAULT_PORT = 8080;

interface SseServerOptions {
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

interface SseServerHandle {
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
   * closure-scoped store rather than the module store.
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

interface SessionEntry {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly server: McpServer;
  /**
   * Wall-clock ms of the most recent successful frame against this
   * session. Updated on every dispatch (init AND every subsequent
   * request). The lazy sweep at session-creation reads this to evict
   * idle entries when the cap-check trips — see {@link sweepIdleSessions}.
   *
   * Mutable by design: a `Map` of frozen objects would force a re-set on
   * every dispatch, defeating the cheap on-hot-path activity refresh.
   */
  lastSeenAt: number;
  /**
   * Count of live GET SSE notification streams held open by this session.
   * A session with `activeStreams > 0` has a client actively listening and
   * is never idle, so the sweep skips it even when `lastSeenAt` has aged
   * out — see {@link sweepIdleSessions} and `trackResponseStreamLifetime`.
   *
   * #3576 — a client can hold the GET notification stream open indefinitely
   * to pin a session against the cap. The sweep allows reclaiming sessions
   * whose streams have been held past `maxHeldStreamAgeMs` even when
   * `activeStreams > 0`; see `sweepIdleSessions` and `streamOpenedAt`.
   */
  activeStreams: number;
  /**
   * Wall-clock ms when the FIRST active GET notification stream was opened.
   * Set on the first `onOpen` and cleared when `activeStreams` drops to 0.
   * Used by the sweep (#3576) to detect streams held past `maxHeldStreamAgeMs`.
   * `undefined` when no stream is currently open.
   */
  streamOpenedAt: number | undefined;
}
type SessionMap = Map<string, SessionEntry>;

// ── Concurrent-session cap ──────────────────────────────────────────
//
// The cap resolves through the env-profile (`resolveMcpMaxSessions`): the
// `ATLAS_MCP_MAX_SESSIONS` override wins when a positive integer, otherwise
// the deploy-env profile default (100) applies. An explicit `opts.maxSessions`
// passed by the caller always wins over the env. The resolver is pure and
// cannot log, so the malformed-override warn lives here at the call site
// where a logger is available. Mirrors `hosted.ts:maxSessions`.

function resolveMaxSessions(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  // Mirror resolveMcpMaxSessions's `.trim()` so a whitespace-only value is
  // treated as unset (no spurious warn) — the warn fires only for a genuinely
  // malformed non-empty override, matching what the resolver actually rejects.
  const raw = process.env.ATLAS_MCP_MAX_SESSIONS?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      log.warn(
        { raw },
        "ATLAS_MCP_MAX_SESSIONS is not a positive integer — falling back to the deploy-env profile default",
      );
    }
  }
  return resolveMcpMaxSessions();
}

// ── Idle-session sweep ─────────────────────────────────────────────
//
// Streamable HTTP is request-response, not a long-lived socket — there is
// no transport-level disconnect event for a client that closes without
// sending the explicit `DELETE`. Real-world MCP clients (Claude Desktop,
// Cursor) routinely vanish (laptop lid closed, app killed, OS update)
// without a clean handshake. The pre-sweep implementation kept those
// orphaned sessions in the in-memory map forever — eventually saturating
// the cap and 503-ing every new connection until process restart.
//
// The sweep evicts any session whose `lastSeenAt` is older than the idle
// timeout, and runs lazily, only on cap-pressure (inside the new-session
// path when `sessions.size + pendingReservations >= cap`). A quiet server
// with no traffic doesn't burn CPU on a periodic sweep; the newly-arriving
// caller pays the O(n) sweep cost, which is the right shape — the work is
// amortized against the request that benefits from it. Mirrors the lazy
// sweep in `hosted.ts`; a `setInterval` background sweep is deliberately
// not used (extra fiber to reason about, spends CPU on idle servers).

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MIN_SESSION_IDLE_TIMEOUT_MS = 60 * 1000; // 1 minute floor

/**
 * Test-only override. Bypasses the production floor so the cap-pressure
 * sweep can be driven end-to-end with sub-second timeouts. Production must
 * keep the 1-minute floor so a misconfigured env var can't degenerate the
 * sweep into a close-everything-on-every-request loop. Production code paths
 * never set this. Module-scoped (mirrors `hosted.ts`) because it tunes the
 * env-driven timeout resolution, not any one server instance's store.
 */
let _idleTimeoutOverrideMs: number | null = null;

/**
 * @internal — test-only. Pin idle timeout below the prod floor.
 *
 * Guarded behind a NODE_ENV check (#3577): calling this in production is a
 * programming error and throws immediately so the mistake surfaces at startup
 * rather than silently degenerate-sweeping every session on every request.
 * Tests run with NODE_ENV !== 'production' and are unaffected.
 */
export function _setIdleTimeoutForTests(ms: number | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "_setIdleTimeoutForTests must not be called in production — " +
        "use ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS instead",
    );
  }
  _idleTimeoutOverrideMs = ms;
}

function sessionIdleTimeoutMs(): number {
  if (_idleTimeoutOverrideMs !== null) {
    // Test-only path: return verbatim so tests can drive sub-second sweeps.
    // The production guard in `_setIdleTimeoutForTests` ensures this branch
    // is unreachable in production — the setter would have thrown at startup.
    return _idleTimeoutOverrideMs;
  }
  const raw = process.env.ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_SESSION_IDLE_TIMEOUT_MS) {
    log.warn(
      { raw, floor: MIN_SESSION_IDLE_TIMEOUT_MS },
      "ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS missing/below floor — falling back to default",
    );
    return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
  }
  return parsed;
}

// ── Max held-stream age (#3576) ─────────────────────────────────────
//
// A client can hold the GET SSE notification stream open indefinitely,
// pinning a session against the cap. `maxHeldStreamAgeMs` is how long we
// allow a GET stream to stay open before the sweep reclaims the session
// under cap-pressure. Mirrors the same logic in `hosted.ts`.

const DEFAULT_MAX_HELD_STREAM_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

function maxHeldStreamAgeMs(): number {
  const raw = process.env.ATLAS_MCP_MAX_HELD_STREAM_AGE_MS;
  if (!raw) return DEFAULT_MAX_HELD_STREAM_AGE_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    log.warn(
      { raw },
      "ATLAS_MCP_MAX_HELD_STREAM_AGE_MS is not a non-negative integer — falling back to default",
    );
    return DEFAULT_MAX_HELD_STREAM_AGE_MS;
  }
  return parsed;
}

/**
 * Evict sessions whose `lastSeenAt` is older than the configured idle
 * timeout. Returns the count evicted so the caller can decide whether the
 * cap-check should be retried (a successful sweep means a slot opened up).
 *
 * Eviction calls `transport.close()` + `server.close()` so the underlying
 * resources are released, not just the map entry. Both close paths swallow
 * their own errors via `.catch(() => {})` to match the existing teardown
 * pattern in `close()` and `transport.onclose` — a hanging close on a
 * leaked session must not block the new caller's init from proceeding.
 *
 * Takes the session map as a parameter (rather than reading a module store
 * like `hosted.ts`) because `startSseServer` is a multi-instance factory.
 *
 * #3576 — `activeStreams > 0` is no longer an absolute skip. A client
 * can hold the GET notification stream open indefinitely to pin a session
 * against the cap. The sweep reclaims sessions whose streams have been held
 * past `heldStreamMaxAgeMs`. POST stream liveness is tracked via `onActivity`
 * (see `startSseServer` dispatch path) so in-flight streaming tool calls
 * keep `lastSeenAt` current without leaking a GET stream to pin the session.
 */
function sweepIdleSessions(
  sessions: SessionMap,
  now: number,
  idleTimeoutMs: number,
  heldStreamMaxAgeMs: number = maxHeldStreamAgeMs(),
): number {
  let evicted = 0;
  const idleCutoff = now - idleTimeoutMs;
  const streamAgeCutoff = now - heldStreamMaxAgeMs;
  for (const [id, entry] of sessions) {
    if (entry.activeStreams > 0) {
      // Only reclaim if the stream has been held past the max age.
      if (entry.streamOpenedAt === undefined) continue;
      if (entry.streamOpenedAt > streamAgeCutoff) continue;
      log.warn(
        { sessionId: id, streamOpenedAt: entry.streamOpenedAt, heldStreamMaxAgeMs },
        "Evicting MCP session with stale held-open GET stream (cap pressure, #3576)",
      );
    } else {
      if (entry.lastSeenAt > idleCutoff) continue;
    }
    sessions.delete(id);
    // intentionally ignored: best-effort teardown of an already-orphaned
    // session — the client that owned this entry is gone by definition (no
    // frames in `idleTimeoutMs`), so a close failure has nowhere to surface.
    // The sweep counter is the signal that matters; missing one out of N
    // closes does not affect cap accounting.
    void entry.transport.close().catch(() => {});
    void entry.server.close().catch(() => {});
    evicted++;
  }
  if (evicted > 0) {
    log.info(
      { evicted, remaining: sessions.size, idleTimeoutMs },
      "Swept idle MCP sessions",
    );
  }
  return evicted;
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
  const explicitMaxSessions = opts?.maxSessions;

  if (port !== 0 && (isNaN(port) || port < 1 || port > 65535)) {
    throw new Error(`Invalid port: ${port}. Must be 0 (ephemeral) or 1-65535.`);
  }

  const sessions: SessionMap = new Map();
  const cors = corsHeaders(origin);

  // Reservation counter prevents the TOCTOU between the cap check and the
  // async `createServer` call. `sessions.size` only reflects post-
  // `onsessioninitialized` state; with N concurrent inits, all N would pass
  // a naïve `sessions.size >= max` check before any registers. We bump this
  // at the gate and decrement on failure or after the session registers.
  // Per-instance (closure-scoped) because each server owns its own store.
  let pendingReservations = 0;

  async function dispatchExistingSession(
    req: Request,
    entry: SessionEntry,
  ): Promise<Response> {
    // Refresh the activity timestamp so the lazy sweep at the cap-check
    // doesn't evict an actively-used session. Updated PRE-dispatch so a
    // long-running tool call (executeSQL on a large query) doesn't race
    // with a concurrent sweep observing a stale `lastSeenAt`.
    entry.lastSeenAt = Date.now();
    const response = await entry.transport.handleRequest(req);
    // A GET opens the standalone SSE notification stream, which stays open
    // for the life of the connection. Track its liveness so the idle sweep
    // never evicts a session that still has a client listening — `lastSeenAt`
    // alone would age out a connected-but-quiet client mid-stream.
    //
    // #3576 — also record `streamOpenedAt` so the sweep can reclaim sessions
    // whose GET stream has been held open past `maxHeldStreamAgeMs`.
    if (req.method === "GET") {
      return trackResponseStreamLifetime(response, {
        onOpen: () => {
          entry.activeStreams++;
          if (entry.streamOpenedAt === undefined) {
            entry.streamOpenedAt = Date.now();
          }
        },
        onClose: () => {
          entry.activeStreams = Math.max(0, entry.activeStreams - 1);
          // Reset the idle clock from the moment the client actually
          // disconnected, not from when the stream opened.
          entry.lastSeenAt = Date.now();
          if (entry.activeStreams === 0) {
            entry.streamOpenedAt = undefined;
          }
        },
        onError: (err) => {
          const detail = err instanceof Error ? err.message : String(err);
          log.debug(
            { sessionId: entry.transport.sessionId, err: detail },
            "SSE notification stream errored",
          );
        },
      });
    }
    // #3576 — for POST event-stream responses (long-running streaming tool
    // calls), keep `lastSeenAt` current as chunks are sent so the idle sweep
    // never evicts a session mid-flight.
    if (req.method === "POST") {
      return trackResponseStreamLifetime(response, {
        onOpen: () => {},
        onClose: () => {
          entry.lastSeenAt = Date.now();
        },
        onActivity: () => {
          entry.lastSeenAt = Date.now();
        },
      });
    }
    return response;
  }

  async function dispatchNewSession(req: Request): Promise<Response> {
    const cap = resolveMaxSessions(explicitMaxSessions);

    // Lazy sweep: when the cap appears full, evict idle sessions FIRST and
    // re-check. Without this, a server that has accumulated leaked sessions
    // (Streamable HTTP has no transport disconnect event for a client that
    // vanishes without sending DELETE) will permanently 503 every new
    // connection until process restart. The sweep cost is paid only on
    // cap-pressure, so quiet servers don't burn CPU evicting nothing.
    if (sessions.size + pendingReservations >= cap) {
      sweepIdleSessions(sessions, Date.now(), sessionIdleTimeoutMs());
      if (sessions.size + pendingReservations >= cap) {
        return new Response(
          JSON.stringify({
            error: "too_many_sessions",
            message: "Too many active MCP sessions. Try again later.",
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    pendingReservations++;
    let registered = false;

    try {
      const mcpServer = await createServer();

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          // Stamp `lastSeenAt: Date.now()` at registration so the sweep
          // doesn't immediately evict a freshly-created session that hasn't
          // yet received a follow-up frame.
          sessions.set(id, {
            transport,
            server: mcpServer,
            lastSeenAt: Date.now(),
            activeStreams: 0,
            streamOpenedAt: undefined,
          });
          registered = true;
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
          // intentionally ignored: best-effort cleanup on transport close
          entry.server.close().catch(() => {});
        }
      };

      try {
        await mcpServer.connect(transport);
      } catch (err) {
        // intentionally ignored: best-effort cleanup before re-throwing connect error
        await transport.close().catch(() => {});
        await mcpServer.close().catch(() => {});
        throw err;
      }

      const response = await transport.handleRequest(req);

      // The leak path: a non-initialize first frame (no `mcp-session-id`
      // header) is rejected by the SDK without firing `onsessioninitialized`.
      // The server + transport stay live but unregistered, so nothing ever
      // cleans them up. Detect via the `registered` flag set inside the init
      // callback and tear down here. Without this, every malformed first
      // frame leaks one McpServer per request. Mirrors `hosted.ts`.
      if (!registered) {
        // intentionally ignored: best-effort teardown of an unregistered
        // session — we already lost the request, no point surfacing close
        // errors that nothing can act on.
        await transport.close().catch(() => {});
        await mcpServer.close().catch(() => {});
      }

      return response;
    } finally {
      pendingReservations--;
    }
  }

  async function handleMcpRequest(req: Request): Promise<Response> {
    const sessionId = req.headers.get("mcp-session-id");

    if (sessionId) {
      const entry = sessions.get(sessionId);
      if (entry) {
        return dispatchExistingSession(req, entry);
      }
      return new Response("Session not found", { status: 404 });
    }

    return dispatchNewSession(req);
  }

  const bunServer = Bun.serve({
    port,
    hostname,
    idleTimeout: 0, // SSE streaming — no idle timeout
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
      pendingReservations = 0;

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
    _sessionCount() {
      return sessions.size;
    },
    _sweepIdleSessionsForTests(now?: number, idleTimeoutMs?: number, heldStreamMaxAgeMs?: number): number {
      return sweepIdleSessions(
        sessions,
        now ?? Date.now(),
        idleTimeoutMs ?? sessionIdleTimeoutMs(),
        heldStreamMaxAgeMs,
      );
    },
  };
}
