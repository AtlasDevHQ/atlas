/**
 * `McpSessionStore` — the single owner of the Streamable-HTTP session
 * lifecycle shared by both MCP transports (`hosted.ts` + `sse.ts`).
 *
 * ── Why this exists (#3600) ────────────────────────────────────────
 *
 * `hosted.ts` (the SaaS per-region Hono router) and `sse.ts` (the
 * self-hosted `--transport sse` standalone Bun server) carried the SAME
 * session-lifecycle logic twice — the `SessionEntry` shape, the
 * `resolveMaxSessions` / `sessionIdleTimeoutMs` / `maxHeldStreamAgeMs`
 * env resolution, the idle-session `sweep`, the `pendingReservations`
 * TOCTOU cap guard, the GET-stream / POST-stream liveness wiring
 * (`lastSeenAt` / `activeStreams` / `streamOpenedAt`), and the
 * `_sweepIdleSessionsForTests` test seam. `sse.ts`'s own docstring
 * admitted it mirrored `hosted.ts` "kept in lockstep"; the #3527 backport
 * (sse re-acquiring hardening hosted already had) was the structural tell
 * that the duplication had already drifted once and been manually re-synced.
 *
 * This module collapses that duplicated surface into one tested unit. The
 * `lastSeenAt` / `activeStreams` / `pendingReservations` TOCTOU+liveness
 * invariant now lives here exactly once: deleting the sweep/dispatch logic
 * from this file breaks BOTH transports (the deletion test).
 *
 * ── Instance lifetimes (preserved exactly) ─────────────────────────
 *
 *   - **hosted** constructs ONE module-scoped store (its session map was
 *     module-scoped: all per-region requests share one cap).
 *   - **sse** constructs one store PER `startSseServer` call (each
 *     standalone server owns its own cap / session map).
 *
 * The store is a plain class instance, so both lifetimes fall out of
 * *where the caller constructs it* — module scope vs. factory closure.
 *
 * ── Env-driven timeout resolution (module-scoped, shared) ───────────
 *
 * The idle-timeout / held-stream-age / max-sessions resolvers read
 * `process.env` and are identical across both transports. The test-only
 * `_idleTimeoutOverrideMs` override (driven by `_setIdleTimeoutForTests`)
 * was module-scoped in BOTH files — it tunes the env-driven resolution,
 * not any one instance's store — so it stays module-scoped here and both
 * transports re-export the one setter.
 *
 * The store composes with the already-extracted `stream-liveness.ts` leaf
 * (`trackResponseStreamLifetime`); it does not re-implement it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { resolveMcpMaxSessions } from "@atlas/api/lib/env-profile";
import { createLogger } from "@atlas/api/lib/logger";
import { trackResponseStreamLifetime } from "./stream-liveness.js";

const log = createLogger("mcp-session-store");

// ── Session entry ──────────────────────────────────────────────────

export interface SessionEntry {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly server: McpServer;
  /**
   * Wall-clock ms of the most recent successful frame against this
   * session. Updated on every dispatch (init AND every subsequent
   * request). The lazy-sweep at session-creation reads this to evict
   * idle entries when the cap-check trips — see {@link McpSessionStore.sweep}.
   *
   * Mutable by design: a `Map<string, SessionEntry>` of frozen objects
   * would force a re-set on every dispatch, defeating the cheap-read
   * property of the on-hot-path activity refresh.
   */
  lastSeenAt: number;
  /**
   * Count of live GET SSE notification streams held open by this session.
   * A session with `activeStreams > 0` has a client actively listening and
   * is never idle, so the sweep skips it even when `lastSeenAt` has aged
   * out — see {@link McpSessionStore.sweep} and `trackResponseStreamLifetime`.
   *
   * #3576 — a client can hold the GET notification stream open indefinitely
   * to pin a session against the cap. The sweep allows reclaiming sessions
   * whose streams have been held past `maxHeldStreamAgeMs` even when
   * `activeStreams > 0`; see {@link McpSessionStore.sweep} and `streamOpenedAt`.
   */
  activeStreams: number;
  /**
   * Wall-clock ms when the FIRST active GET notification stream was opened
   * for this session. Set on the first `onOpen` callback and cleared when
   * `activeStreams` drops back to 0. Used by the sweep (#3576) to detect
   * streams held open past `maxHeldStreamAgeMs` and reclaim them.
   * `undefined` when no stream is currently open.
   */
  streamOpenedAt: number | undefined;
}

// ── Concurrent-session cap ──────────────────────────────────────────
//
// The cap resolves through the env-profile (`resolveMcpMaxSessions`): the
// `ATLAS_MCP_MAX_SESSIONS` override wins when a positive integer, otherwise
// the deploy-env profile default (100) applies. An explicit value passed by
// the caller (sse's `opts.maxSessions`) always wins over the env. The
// resolver is pure and cannot log, so the malformed-override warn lives here
// at the call site where a logger is available.

export function resolveMaxSessions(explicit?: number): number {
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

// ── Idle-session sweep (timeout resolution) ────────────────────────
//
// Streamable HTTP is request-response, not a long-lived socket — there
// is no transport-level disconnect event for a client that closes
// without sending the explicit `DELETE`. Real-world MCP clients
// (Claude Desktop, Cursor) routinely vanish (laptop lid closed, app
// killed, OS update) without a clean handshake. Without the sweep those
// orphaned sessions would linger in the in-memory map forever —
// eventually saturating `resolveMaxSessions()` and 503-ing every new
// connection until process/container restart.
//
// The sweep evicts any session whose `lastSeenAt` is older than the idle
// timeout, and runs lazily — only on cap-pressure (inside `dispatchNew`
// when `size + pendingReservations >= cap`). A quiet server with no
// traffic doesn't burn CPU on a periodic sweep; the newly-arriving caller
// pays the O(n) sweep cost, which is the right shape — the work is
// amortized against the request that benefits from it. A `setInterval`
// background sweep is deliberately not used (extra fiber to reason about:
// unref, shutdown ordering, test-time reset; spends CPU on idle servers).

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MIN_SESSION_IDLE_TIMEOUT_MS = 60 * 1000; // 1 minute floor

/**
 * Test-only override. Bypasses the production floor so the cap-pressure
 * sweep can be driven end-to-end with sub-second timeouts. Production must
 * keep the 1-minute floor so a misconfigured env var can't degenerate the
 * sweep into a close-everything-on-every-request loop. Production code paths
 * never set this. Module-scoped (it tunes the env-driven timeout resolution,
 * not any one server instance's store) — both transports re-export the setter.
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

export function sessionIdleTimeoutMs(): number {
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
// which causes `activeStreams > 0` and pins the session against the cap
// forever. `maxHeldStreamAgeMs` is how long we allow a GET stream to stay
// open before the sweep reclaims the session under cap-pressure. The default
// is 2 hours — generous for legitimate use (long-running agent sessions) but
// finite so resource-exhaustion by a hung client is bounded.
//
// The env var `ATLAS_MCP_MAX_HELD_STREAM_AGE_MS` allows operators to tune
// this. Unlike the idle-timeout floor, there is no minimum here: a very
// short held-stream age is unusual but not as dangerous as a sub-minute
// idle timeout (which could degenerate the sweep into a close-everything
// loop). The default is conservative; set to 0 to disable age-based reclaim.

const DEFAULT_MAX_HELD_STREAM_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

export function maxHeldStreamAgeMs(): number {
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

// ── Per-session creation spec ──────────────────────────────────────

/**
 * Transport-specific bits the store needs to materialize one new session.
 * Both transports supply the same two steps; only their bodies differ:
 *
 *   - `createServer` — hosted builds a bearer-bound `McpServer`; sse just
 *     calls the caller's factory.
 *   - `onRegistered` — fires inside `onsessioninitialized` AFTER the entry
 *     is stored, so hosted can emit its `mcp_session.start` audit with the
 *     real session id (and both transports can log "session created").
 *     Optional.
 *   - `tooManyMessage` — the 503 body copy differs slightly between the two
 *     transports (region wording); keep both verbatim.
 */
export interface NewSessionSpec {
  readonly createServer: () => Promise<McpServer>;
  readonly onRegistered?: (sessionId: string, entry: SessionEntry) => void;
  readonly tooManyMessage: string;
}

// ── The store ──────────────────────────────────────────────────────

export class McpSessionStore {
  private readonly sessions = new Map<string, SessionEntry>();

  // Reservation counter prevents the TOCTOU between the cap check and the
  // async `createServer` call. `sessions.size` only reflects post-
  // `onsessioninitialized` state; with N concurrent inits, all N would pass
  // a naïve `sessions.size >= max` check before any registers. We bump this
  // at the gate and decrement on failure or after the session registers.
  private pendingReservations = 0;

  constructor(
    /**
     * Resolves the concurrent-session cap for THIS store. hosted passes the
     * env-only resolver; sse passes one closing over its explicit
     * `opts.maxSessions` so a caller-pinned cap wins over the env.
     */
    private readonly resolveCap: () => number,
  ) {}

  /** Current live session count. */
  get size(): number {
    return this.sessions.size;
  }

  /** Look up a live session by id, or `undefined` if absent/evicted. */
  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Evict sessions whose `lastSeenAt` is older than the configured idle
   * timeout. Returns the count evicted so the caller can decide whether the
   * cap-check should be retried (a successful sweep means a slot opened up).
   *
   * Eviction calls `transport.close()` + `server.close()` so the underlying
   * resources are released, not just the map entry. Both close paths swallow
   * their own errors via `.catch(() => {})` to match the existing teardown
   * pattern in {@link reset} and `transport.onclose` — a hanging close on a
   * leaked session must not block the new caller's init from proceeding.
   *
   * #3576 — `activeStreams > 0` is no longer an absolute skip. A client
   * can hold the GET notification stream open indefinitely to pin a session
   * against the cap. The sweep reclaims sessions whose streams have been held
   * past `heldStreamMaxAgeMs` even under cap-pressure. Active POST streams are
   * protected differently: `lastSeenAt` is refreshed per-chunk via `onActivity`
   * so a long-running streaming tool call keeps the session alive without
   * leaking a GET stream pinning it.
   */
  sweep(
    now: number,
    idleTimeoutMs: number,
    heldStreamMaxAgeMs: number = maxHeldStreamAgeMs(),
  ): number {
    let evicted = 0;
    const idleCutoff = now - idleTimeoutMs;
    const streamAgeCutoff = now - heldStreamMaxAgeMs;
    for (const [id, entry] of this.sessions) {
      if (entry.activeStreams > 0) {
        // The session has a live GET notification stream. Only reclaim it if
        // the stream has been held open past the max-held-stream-age limit.
        // A stream with no `streamOpenedAt` is a logic anomaly (activeStreams
        // > 0 but no open timestamp) — skip it conservatively.
        if (entry.streamOpenedAt === undefined) continue;
        if (entry.streamOpenedAt > streamAgeCutoff) continue;
        // Stream is too old — reclaim under cap-pressure. The client that holds
        // it will get a transport error and should reconnect.
        log.warn(
          { sessionId: id, streamOpenedAt: entry.streamOpenedAt, heldStreamMaxAgeMs },
          "Evicting MCP session with stale held-open GET stream (cap pressure, #3576)",
        );
      } else {
        // No active stream — standard idle-timeout check.
        if (entry.lastSeenAt > idleCutoff) continue;
      }
      this.sessions.delete(id);
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
        { evicted, remaining: this.sessions.size, idleTimeoutMs },
        "Swept idle MCP sessions",
      );
    }
    return evicted;
  }

  /**
   * Dispatch a request against an EXISTING session, refreshing liveness.
   *
   * - `lastSeenAt` is refreshed PRE-dispatch so a long-running tool call
   *   (executeSQL on a large query) doesn't race with a concurrent sweep
   *   observing a stale `lastSeenAt`.
   * - GET opens the standalone SSE notification stream; its liveness is
   *   tracked via `activeStreams` / `streamOpenedAt` so the idle sweep never
   *   evicts a session that still has a client listening (#3576).
   * - POST event-stream responses (long-running streaming tool calls) keep
   *   `lastSeenAt` current per-chunk via `onActivity` so a 2-hour streaming
   *   query is never swept mid-flight (#3576).
   *
   * `wrap` lets a caller run the transport's `handleRequest` inside an
   * ambient context. hosted threads the freshly-resolved live actor through
   * `withLiveActor` so dispatch-gate gate-3 is revocation-immediate; sse
   * passes no wrapper.
   */
  async dispatchExisting(
    req: Request,
    entry: SessionEntry,
    wrap?: (run: () => Promise<Response>) => Promise<Response>,
  ): Promise<Response> {
    entry.lastSeenAt = Date.now();
    const run = (): Promise<Response> => entry.transport.handleRequest(req);
    const response = wrap ? await wrap(run) : await run();

    if (req.method === "GET") {
      return trackResponseStreamLifetime(response, {
        onOpen: () => {
          entry.activeStreams++;
          // Only set `streamOpenedAt` for the FIRST active stream — if multiple
          // GET streams were opened (uncommon), we track the oldest one so the
          // sweep's age check is conservative (oldest stream, not newest).
          if (entry.streamOpenedAt === undefined) {
            entry.streamOpenedAt = Date.now();
          }
        },
        onClose: () => {
          entry.activeStreams = Math.max(0, entry.activeStreams - 1);
          // Reset the idle clock from the moment the client actually
          // disconnected, not from when the stream opened.
          entry.lastSeenAt = Date.now();
          // Clear the opened-at timestamp when the last stream closes so a
          // future reconnect starts a fresh age window.
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

  /**
   * Create and dispatch a NEW session under the cap guard.
   *
   * Owns: the lazy cap-pressure sweep + re-check, the `pendingReservations`
   * TOCTOU reservation, transport construction with the `onsessioninitialized`
   * / `onsessionclosed` / `onclose` lifecycle callbacks, the connect-failure
   * teardown, and the unregistered-leak teardown (a non-initialize first
   * frame is rejected by the SDK without firing `onsessioninitialized`, so
   * the server + transport would otherwise stay live but unregistered).
   *
   * The transport-specific server creation + post-register hook + 503 copy
   * come from `spec`.
   */
  async dispatchNew(req: Request, spec: NewSessionSpec): Promise<Response> {
    const cap = this.resolveCap();

    // Lazy sweep: when the cap appears full, evict idle sessions FIRST and
    // re-check. Without this, a server that has accumulated leaked sessions
    // (Streamable HTTP has no transport disconnect event for a client that
    // vanishes without sending DELETE) will permanently 503 every new
    // connection until process restart. The sweep cost is paid only on
    // cap-pressure, so quiet servers don't burn CPU evicting nothing.
    if (this.sessions.size + this.pendingReservations >= cap) {
      this.sweep(Date.now(), sessionIdleTimeoutMs());
      if (this.sessions.size + this.pendingReservations >= cap) {
        return new Response(
          JSON.stringify({
            error: "too_many_sessions",
            message: spec.tooManyMessage,
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    this.pendingReservations++;
    let registered = false;

    try {
      const mcpServer = await spec.createServer();

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          // Stamp `lastSeenAt: Date.now()` at registration so the sweep
          // doesn't immediately evict a freshly-created session that hasn't
          // yet received a follow-up frame.
          const entry: SessionEntry = {
            transport,
            server: mcpServer,
            lastSeenAt: Date.now(),
            activeStreams: 0,
            streamOpenedAt: undefined,
          };
          this.sessions.set(id, entry);
          registered = true;
          spec.onRegistered?.(id, entry);
        },
        onsessionclosed: (id) => {
          const entry = this.sessions.get(id);
          if (entry) {
            this.sessions.delete(id);
            entry.server.close().catch((err) => {
              const detail = err instanceof Error ? err.message : String(err);
              log.warn(
                { sessionId: id, err: detail },
                "Failed to close per-session MCP server",
              );
            });
          }
          log.info({ sessionId: id }, "Session closed");
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && this.sessions.has(sid)) {
          const entry = this.sessions.get(sid)!;
          this.sessions.delete(sid);
          // intentionally ignored: transport.onclose fires from the SDK's own
          // cleanup path; surfacing a server-close error here would have
          // nowhere to go.
          entry.server.close().catch(() => {});
        }
      };

      try {
        await mcpServer.connect(transport);
      } catch (err) {
        // intentionally ignored: cleanup-and-rethrow — the connect error is
        // the signal; we just want to release the resources before propagating.
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
      // frame leaks one McpServer per request.
      if (!registered) {
        // intentionally ignored: best-effort teardown of an unregistered
        // session — we already lost the request, no point surfacing close
        // errors that nothing can act on.
        await transport.close().catch(() => {});
        await mcpServer.close().catch(() => {});
      }

      return response;
    } finally {
      this.pendingReservations--;
    }
  }

  /**
   * Tear down every live session and reset the reservation counter. Takes
   * ownership of the entries and clears the map first to prevent
   * callback-triggered double-cleanup. Used by `sse.ts`'s `close()` and by
   * `hosted.ts`'s test-reset seam.
   */
  async reset(): Promise<void> {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();
    this.pendingReservations = 0;
    for (const [sessionId, entry] of entries) {
      // intentionally ignored: best-effort teardown — both the test reset path
      // (afterEach) and graceful shutdown reach here; a hanging close must not
      // fail the suite or block shutdown. Real shutdown emits warnings via
      // onsessionclosed.
      await entry.transport.close().catch((err) => {
        const detail = err instanceof Error ? err.message : String(err);
        log.warn({ sessionId, err: detail }, "Failed to close transport");
      });
      await entry.server.close().catch((err) => {
        const detail = err instanceof Error ? err.message : String(err);
        log.warn({ sessionId, err: detail }, "Failed to close per-session MCP server");
      });
    }
  }
}
