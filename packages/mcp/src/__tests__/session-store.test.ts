/**
 * Characterization tests for the extracted `McpSessionStore` (#3600).
 *
 * The end-to-end session lifecycle (cap, idle sweep, stream-age reclaim) is
 * already exercised through both transports in `hosted.test.ts` and
 * `sse.test.ts` — those stay green and are the behavior-unchanged proof. This
 * file pins the SHARED unit directly where the per-transport suites are thin:
 *
 *   - `dispatchExisting` composes with the caller's `wrap` (hosted threads
 *     `withLiveActor` through it; sse passes none) and fires the GET/POST
 *     stream-liveness hooks against the entry.
 *   - the GET-stream `activeStreams` / `streamOpenedAt` invariant is updated
 *     on open and cleared on close — the one tested unit the issue calls for.
 *
 * These assert the invariant lives in `session-store.ts` and not in either
 * transport (the deletion test): deleting `dispatchExisting` here breaks both.
 *
 * Two more suites live here because they pin the same module:
 *   - the settings-registry precedence for `sessionIdleTimeoutMs` /
 *     `maxHeldStreamAgeMs` (#3705) — formerly `session-store-settings.test.ts`;
 *   - the `_setIdleTimeoutForTests` production guard (#3577), which was
 *     copy-pasted into `hosted.test.ts` and `streamable-http.test.ts`. Both
 *     transports merely re-export the function defined here, so the guard is
 *     asserted once, at its definition site.
 */

import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { setSetting, _resetSettingsCache } from "@atlas/api/lib/settings";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import {
  McpSessionStore,
  sessionIdleTimeoutMs,
  maxHeldStreamAgeMs,
  _setIdleTimeoutForTests,
  type SessionEntry,
} from "../session-store.js";

const enc = new TextEncoder();

/**
 * A minimal `SessionEntry` whose `transport.handleRequest` returns a caller-
 * supplied Response. Only the fields the store reads are populated; the casts
 * are narrow (a stub transport/server) and confined to this fixture.
 */
function fakeEntry(handleRequest: (req: Request) => Promise<Response>): {
  entry: SessionEntry;
  closes: { transport: number; server: number };
} {
  const closes = { transport: 0, server: 0 };
  const transport = {
    sessionId: "sess-1",
    handleRequest,
    close: async () => {
      closes.transport++;
    },
  } as unknown as WebStandardStreamableHTTPServerTransport;
  const server = {
    close: async () => {
      closes.server++;
    },
  } as unknown as McpServer;
  const entry: SessionEntry = {
    transport,
    server,
    lastSeenAt: 0,
    activeStreams: 0,
    streamOpenedAt: undefined,
  };
  return { entry, closes };
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("McpSessionStore.dispatchExisting", () => {
  it("refreshes lastSeenAt pre-dispatch and runs the caller's wrap", async () => {
    const store = new McpSessionStore(() => 100);
    const { entry } = fakeEntry(async () => new Response("ok"));
    entry.lastSeenAt = 1; // stale

    let wrapped = false;
    const before = Date.now();
    const res = await store.dispatchExisting(
      new Request("http://x/mcp", { method: "DELETE" }),
      entry,
      (run) => {
        wrapped = true;
        return run();
      },
    );

    expect(wrapped).toBe(true);
    expect(await res.text()).toBe("ok");
    // lastSeenAt was refreshed PRE-dispatch (a stale value would race the sweep).
    expect(entry.lastSeenAt).toBeGreaterThanOrEqual(before);
  });

  it("tracks GET notification-stream liveness: activeStreams up on open, cleared on close", async () => {
    const store = new McpSessionStore(() => 100);
    // A GET response that stays open until the consumer reads it to completion.
    const { entry } = fakeEntry(async () =>
      sseResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode("data: hi\n\n"));
            controller.close();
          },
        }),
      ),
    );

    const res = await store.dispatchExisting(
      new Request("http://x/mcp", { method: "GET" }),
      entry,
    );

    // onOpen fired synchronously while the stream is live.
    expect(entry.activeStreams).toBe(1);
    expect(entry.streamOpenedAt).toBeGreaterThan(0);

    // Drain the stream → onClose releases the liveness mark.
    await new Response(res.body).text();
    expect(entry.activeStreams).toBe(0);
    expect(entry.streamOpenedAt).toBeUndefined();
  });

  it("keeps lastSeenAt current per-chunk for POST event-streams (#3576)", async () => {
    const store = new McpSessionStore(() => 100);
    const { entry } = fakeEntry(async () =>
      sseResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode("data: chunk\n\n"));
            controller.close();
          },
        }),
      ),
    );
    entry.lastSeenAt = 1;

    const res = await store.dispatchExisting(
      new Request("http://x/mcp", { method: "POST" }),
      entry,
    );
    const before = Date.now();
    await new Response(res.body).text();
    // onActivity (per-chunk) + onClose both bump lastSeenAt to "now".
    expect(entry.lastSeenAt).toBeGreaterThanOrEqual(before);
  });
});

describe("McpSessionStore cap resolution", () => {
  it("503s a new session when the cap resolver reports full (no slot freed by sweep)", async () => {
    // cap = 0 → the cap-pressure branch trips immediately, the sweep frees
    // nothing (empty store), and the new session is refused with the verbatim
    // 503 copy supplied by the spec.
    const store = new McpSessionStore(() => 0);
    const res = await store.dispatchNew(new Request("http://x/mcp", { method: "POST" }), {
      createServer: async () => {
        throw new Error("createServer must not run when the cap is full");
      },
      tooManyMessage: "Too many active MCP sessions. Try again later.",
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("too_many_sessions");
    expect(body.message).toBe("Too many active MCP sessions. Try again later.");
  });
});

/**
 * #3705 — MCP session-store tuning knobs promoted into the settings registry.
 *
 * `sessionIdleTimeoutMs` and `maxHeldStreamAgeMs` were env-only. The hosted
 * MCP transport mounts on the per-region API server, which loads (and, in
 * SaaS, periodically refreshes) the settings cache — so these now resolve
 * through the platform settings registry: DB override > env > default.
 *
 * Seeds the real settings cache via `setSetting` + the `_resetPool` mock-pool
 * pattern (same as the @atlas/api precedence tests) rather than mocking
 * `getSettingAuto`, so the full resolution path is exercised.
 *
 * The hooks are scoped to this describe so the store tests above run against
 * an untouched pool / settings cache.
 */
describe("session-store tuning knobs — settings registry (#3705)", () => {
  const mockPool: InternalPool = {
    query: async () => ({ rows: [] }),
    async connect() {
      return { query: async () => ({ rows: [] }), release() {} };
    },
    end: async () => {},
    on: () => {},
  };

  const ENV_KEYS = [
    "ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS",
    "ATLAS_MCP_MAX_HELD_STREAM_AGE_MS",
  ] as const;

  const origEnv = new Map<string, string | undefined>();
  let origDbUrl: string | undefined;

  beforeEach(() => {
    origDbUrl = process.env.DATABASE_URL;
    for (const k of ENV_KEYS) {
      origEnv.set(k, process.env[k]);
      delete process.env[k];
    }
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    _resetPool(mockPool);
    _resetSettingsCache();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = origEnv.get(k);
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    _resetPool(null);
    _resetSettingsCache();
  });

  describe("sessionIdleTimeoutMs — registry precedence (#3705)", () => {
    it("defaults to 30 minutes when nothing is set", () => {
      expect(sessionIdleTimeoutMs()).toBe(30 * 60 * 1000);
    });

    it("platform DB override wins over the env var", async () => {
      process.env.ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS = "600000";
      await setSetting("ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS", "120000", "test");
      expect(sessionIdleTimeoutMs()).toBe(120000);
    });

    it("a DB override below the 1-minute floor falls back to the default", async () => {
      await setSetting("ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS", "1000", "test");
      expect(sessionIdleTimeoutMs()).toBe(30 * 60 * 1000);
    });
  });

  describe("maxHeldStreamAgeMs — registry precedence (#3705)", () => {
    it("defaults to 2 hours when nothing is set", () => {
      expect(maxHeldStreamAgeMs()).toBe(2 * 60 * 60 * 1000);
    });

    it("platform DB override wins over the env var", async () => {
      process.env.ATLAS_MCP_MAX_HELD_STREAM_AGE_MS = "999999";
      await setSetting("ATLAS_MCP_MAX_HELD_STREAM_AGE_MS", "1000", "test");
      expect(maxHeldStreamAgeMs()).toBe(1000);
    });

    it("0 is a valid override (disables age-based reclaim)", async () => {
      await setSetting("ATLAS_MCP_MAX_HELD_STREAM_AGE_MS", "0", "test");
      expect(maxHeldStreamAgeMs()).toBe(0);
    });
  });
});

/**
 * #3577 — `_setIdleTimeoutForTests` refuses to run in production.
 *
 * The setter bypasses the 1-minute idle floor so test sweeps can run in
 * milliseconds. In production that bypass must be unreachable — calling the
 * setter with NODE_ENV=production is a programming error and throws so the
 * mistake surfaces at startup, not silently degenerate-sweeps every session.
 *
 * The override is module-scoped in `session-store.ts`; `hosted.ts` and
 * `streamable-http.ts` only re-export it, so the guard is asserted here
 * rather than duplicated in each transport's suite (it was, until this file
 * took it over).
 */
describe("_setIdleTimeoutForTests production guard (#3577)", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    // Reset the override (safe because NODE_ENV is restored above).
    _setIdleTimeoutForTests(null);
  });

  it("throws when called in production (NODE_ENV=production)", () => {
    process.env.NODE_ENV = "production";
    expect(() => _setIdleTimeoutForTests(50)).toThrow(
      "_setIdleTimeoutForTests must not be called in production",
    );
  });

  it("succeeds in test mode (NODE_ENV=test) — existing tests set sub-floor values", () => {
    process.env.NODE_ENV = "test";
    expect(() => _setIdleTimeoutForTests(50)).not.toThrow();
    _setIdleTimeoutForTests(null);
  });

  it("succeeds when NODE_ENV is unset (dev / CI without explicit NODE_ENV)", () => {
    delete process.env.NODE_ENV;
    expect(() => _setIdleTimeoutForTests(100)).not.toThrow();
    _setIdleTimeoutForTests(null);
  });
});
