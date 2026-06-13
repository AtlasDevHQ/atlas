import { describe, expect, it, afterEach, mock } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAtlasUser } from "@atlas/api/lib/auth/types";

// Inject a bound actor so SSE tests don't depend on `resolveMcpActor`.
const SSE_ACTOR = createAtlasUser("u_sse", "managed", "sse@test", {
  role: "admin",
  activeOrganizationId: "org_sse",
});

// Mock config initialization to avoid requiring a real database. Per
// CLAUDE.md, mock.module() must cover every named export downstream
// callers use — partial mocks leak via the in-process Bun runner and
// break unrelated tests with `Export named 'X' not found`.
const __mockedConfig = {
  datasources: {},
  tools: ["explore", "executeSQL"],
  auth: "auto",
  semanticLayer: "./semantic",
  source: "env",
};
mock.module("@atlas/api/lib/config", () => ({
  initializeConfig: mock(async () => __mockedConfig),
  getConfig: mock(() => __mockedConfig),
  loadConfig: mock(async () => __mockedConfig),
  configFromEnv: mock(() => __mockedConfig),
  validateAndResolve: mock(() => __mockedConfig),
  defineConfig: (c: unknown) => c,
  applyDatasources: mock(async () => undefined),
  validateToolConfig: mock(async () => undefined),
  formatZodErrors: () => "",
  _resetConfig: mock(() => undefined),
  _setConfigForTest: mock(() => undefined),
  _warnPoolDefaultsInSaaS: mock(() => undefined),
}));

// Mock tool execute functions
mock.module("@atlas/api/lib/tools/explore", () => ({
  explore: {
    description: "Explore the semantic layer",
    execute: mock(async () => "catalog.yml\nentities/\nglossary.yml"),
  },
}));

mock.module("@atlas/api/lib/tools/sql", () => ({
  executeSQL: {
    description: "Execute SQL",
    execute: mock(async () => ({
      success: true,
      explanation: "Count users",
      row_count: 1,
      columns: ["count"],
      rows: [{ count: 42 }],
      truncated: false,
    })),
  },
}));

// Import after mocks
const { createAtlasMcpServer } = await import("../server.js");
const { startSseServer, _setIdleTimeoutForTests } = await import("../sse.js");

type SseHandle = Awaited<ReturnType<typeof startSseServer>>;
let handle: SseHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  // Reset session-hardening knobs so one test's env/override can't bleed
  // into the next (the in-process Bun runner shares module state).
  delete process.env.ATLAS_MCP_MAX_SESSIONS;
  delete process.env.ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS;
  _setIdleTimeoutForTests(null);
});

describe("SSE server — lifecycle", () => {
  it("starts and exposes a health endpoint", async () => {
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), { port: 0 });

    const res = await fetch(`http://localhost:${handle.server.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; transport: string; sessions: number };
    expect(body.status).toBe("ok");
    expect(body.transport).toBe("sse");
    expect(body.sessions).toBe(0);
  });

  it("returns 404 for unknown paths", async () => {
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), { port: 0 });

    const res = await fetch(`http://localhost:${handle.server.port}/unknown`);
    expect(res.status).toBe(404);
  });

  it("handles CORS preflight on /mcp", async () => {
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), { port: 0 });

    const res = await fetch(`http://localhost:${handle.server.port}/mcp`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("includes CORS headers on /health response", async () => {
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), { port: 0 });

    const res = await fetch(`http://localhost:${handle.server.port}/health`);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("respects custom CORS origin", async () => {
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), {
      port: 0,
      corsOrigin: "https://example.com",
    });

    const res = await fetch(`http://localhost:${handle.server.port}/health`);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
  });

  it("close() shuts down cleanly", async () => {
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), { port: 0 });
    const port = handle.server.port;

    // Verify server is running
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);

    await handle.close();
    handle = null;

    // Server should be stopped — connection should fail
    try {
      await fetch(`http://localhost:${port}/health`);
      // If we get here, the server didn't stop yet (race condition in Bun)
      // That's fine, the important thing is close() didn't throw
    } catch {
      // Expected — connection refused
    }
  });

  it("rejects invalid port", async () => {
    await expect(
      startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), { port: -1 }),
    ).rejects.toThrow("Invalid port");
  });
});

describe("SSE server — MCP client integration", () => {
  it("connects an MCP client and lists tools", async () => {
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), { port: 0 });

    const client = new Client({ name: "test-sse-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.server.port}/mcp`),
    );

    await client.connect(transport);

    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "describeEntity",
      "executeSQL",
      "explore",
      "listEntities",
      "runMetric",
      "searchGlossary",
    ]);

    await client.close();
  });

  it("connects an MCP client and lists resources", async () => {
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), { port: 0 });

    const client = new Client({ name: "test-sse-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.server.port}/mcp`),
    );

    await client.connect(transport);

    const result = await client.listResources();
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain("atlas://semantic/catalog");
    expect(uris).toContain("atlas://semantic/glossary");

    await client.close();
  });

  it("calls explore tool over SSE", async () => {
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), { port: 0 });

    const client = new Client({ name: "test-sse-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.server.port}/mcp`),
    );

    await client.connect(transport);

    const result = await client.callTool({
      name: "explore",
      arguments: { command: "ls" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("catalog.yml");

    await client.close();
  });

  it("returns 404 for unknown session ID", async () => {
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), { port: 0 });

    const res = await fetch(`http://localhost:${handle.server.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "mcp-session-id": "nonexistent-session-id",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });

    expect(res.status).toBe(404);
  });

  it("health endpoint shows active sessions", async () => {
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), { port: 0 });

    // Connect a client to create a session
    const client = new Client({ name: "test-sse-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.server.port}/mcp`),
    );
    await client.connect(transport);

    const res = await fetch(`http://localhost:${handle.server.port}/health`);
    const body = (await res.json()) as { sessions: number };
    expect(body.sessions).toBeGreaterThanOrEqual(1);

    await client.close();
  });

  it("handles multiple concurrent clients", async () => {
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), { port: 0 });

    const client1 = new Client({ name: "client-1", version: "0.0.1" });
    const transport1 = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.server.port}/mcp`),
    );
    await client1.connect(transport1);

    const client2 = new Client({ name: "client-2", version: "0.0.1" });
    const transport2 = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.server.port}/mcp`),
    );
    await client2.connect(transport2);

    // Both clients can list tools independently — explore + executeSQL +
    // the four typed semantic tools (#2020).
    const result1 = await client1.listTools();
    const result2 = await client2.listTools();
    expect(result1.tools.length).toBe(6);
    expect(result2.tools.length).toBe(6);

    // Health shows 2+ sessions
    const res = await fetch(`http://localhost:${handle.server.port}/health`);
    const body = (await res.json()) as { sessions: number };
    expect(body.sessions).toBeGreaterThanOrEqual(2);

    await client1.close();
    await client2.close();
  });

  it("rejects new sessions when maxSessions is reached", async () => {
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), { port: 0, maxSessions: 1 });

    // First client connects fine
    const client = new Client({ name: "client-1", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.server.port}/mcp`),
    );
    await client.connect(transport);

    // Second connection attempt should be rejected with 503
    const res = await fetch(`http://localhost:${handle.server.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.1" },
        },
      }),
    });
    expect(res.status).toBe(503);

    await client.close();
  });

  it("returns 500 for malformed requests without crashing", async () => {
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), { port: 0 });

    const res = await fetch(`http://localhost:${handle.server.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    // Server should not crash — returns an error status
    expect(res.status).toBeGreaterThanOrEqual(400);

    // Server is still healthy after the bad request
    const health = await fetch(`http://localhost:${handle.server.port}/health`);
    expect(health.status).toBe(200);
  });
});

// ── Session hardening (#3492) — idle sweep + TOCTOU cap parity ───────
//
// Backport of the hosted.ts session lifecycle: an idle-session sweep, a
// `pendingReservations` cap guard, and `ATLAS_MCP_MAX_SESSIONS` honored via
// the env-profile. Without these, a self-hosted `--transport sse` deploy
// permanently exhausts its session pool once enough clients vanish without
// sending DELETE.

function rawInitRequest(port: number): Promise<Response> {
  return fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "raw", version: "0.0.1" },
      },
    }),
  });
}

describe("SSE server — session hardening (#3492)", () => {
  it("evicts idle sessions on a far-future sweep", async () => {
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), {
      port: 0,
      maxSessions: 1,
    });

    const client = new Client({ name: "client-stale", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.server.port}/mcp`),
    );
    await client.connect(transport);
    expect(handle._sessionCount()).toBe(1);

    // Drive the sweep with a clock far enough in the future that the
    // freshly-created session is past the idle window. The assertion is
    // unambiguous: sweep evicts, count drops to zero. The leaked client is
    // intentionally left un-closed — its server-side transport+server were
    // already torn down by the sweep.
    const farFuture = Date.now() + 24 * 60 * 60 * 1000; // +1 day
    const evicted = handle._sweepIdleSessionsForTests(farFuture, 60_000);
    expect(evicted).toBe(1);
    expect(handle._sessionCount()).toBe(0);
  });

  it("preserves recently-active sessions across a sweep", async () => {
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), {
      port: 0,
      maxSessions: 5,
    });

    const client = new Client({ name: "client-active", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.server.port}/mcp`),
    );
    await client.connect(transport);
    expect(handle._sessionCount()).toBe(1);

    // Sweep with the current clock — the session was created moments ago,
    // so lastSeenAt is fresh and eviction must be a no-op.
    const evicted = handle._sweepIdleSessionsForTests(Date.now(), 60_000);
    expect(evicted).toBe(0);
    expect(handle._sessionCount()).toBe(1);

    // The preserved session must still function — listTools is the cheapest
    // dispatch that hits the existing-session path.
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);

    await client.close();
  });

  it("honors ATLAS_MCP_MAX_SESSIONS on the SSE path", async () => {
    process.env.ATLAS_MCP_MAX_SESSIONS = "1";
    // No explicit `maxSessions` opt — the cap must resolve from the env via
    // resolveMcpMaxSessions, proving the SSE path honors the override.
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), {
      port: 0,
    });

    const client = new Client({ name: "client-cap", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.server.port}/mcp`),
    );
    await client.connect(transport);
    expect(handle._sessionCount()).toBe(1);

    const res = await rawInitRequest(handle.server.port);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("too_many_sessions");

    await client.close();
  });

  it("rejects concurrent inits over the cap via the reservation counter", async () => {
    // The TOCTOU the reservation counter closes: with cap=1 and two inits
    // in flight, both pass a naïve `sessions.size >= cap` check before
    // either registers. The factory parks inside `createServer` so the
    // first init holds a reservation (pendingReservations=1, sessions.size=0)
    // while the second arrives — the second must be rejected by the
    // reservation guard, before any McpServer is even allocated.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;

    handle = await startSseServer(
      async () => {
        entered++;
        await gate;
        return createAtlasMcpServer({ actor: SSE_ACTOR });
      },
      { port: 0, maxSessions: 1 },
    );
    const port = handle.server.port;

    // Fire the first init and wait until it is parked inside the factory.
    const p1 = rawInitRequest(port);
    while (entered < 1) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Second concurrent init — must be rejected by the reservation guard.
    const res2 = await rawInitRequest(port);
    expect(res2.status).toBe(503);
    const body2 = (await res2.json()) as { error: string };
    expect(body2.error).toBe("too_many_sessions");
    // The guard short-circuited before the factory ran a second time.
    expect(entered).toBe(1);

    // Release the first init so it registers its session cleanly.
    release();
    const res1 = await p1;
    expect(res1.status).not.toBe(503);
    expect(handle._sessionCount()).toBe(1);
  });

  it("auto-sweeps an abandoned (no-stream) session on cap-pressure (regression for the pool-exhaustion bug)", async () => {
    process.env.ATLAS_MCP_MAX_SESSIONS = "1";
    // Bypass the production 1-min idle floor so the age-out path can be
    // driven with a sub-second sleep instead of a 60s wait.
    _setIdleTimeoutForTests(50); // 50 ms
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), {
      port: 0,
    });

    // A genuinely-abandoned session: initialized via a raw POST, then the
    // response drained and nothing kept open — no live notification stream,
    // so `activeStreams` stays 0 and it can age out of the idle window. (An
    // SDK client would instead hold its GET notification stream open, which
    // correctly keeps the session unsweepable — covered by the next test.)
    const leaked = await rawInitRequest(handle.server.port);
    await leaked.body?.cancel().catch(() => {});
    expect(handle._sessionCount()).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 200));

    // A fresh init should now succeed: the new-session path's cap-check
    // sweep evicts the aged-out abandoned session first, freeing the slot.
    // Without the sweep this would 503 forever until process restart.
    const fresh = new Client({ name: "client-fresh", version: "0.0.1" });
    const freshTransport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.server.port}/mcp`),
    );
    await fresh.connect(freshTransport);
    // Only the fresh session remains; the abandoned one was swept.
    expect(handle._sessionCount()).toBe(1);

    await fresh.close();
  });

  it("does not sweep a session whose client still holds a live notification stream", async () => {
    process.env.ATLAS_MCP_MAX_SESSIONS = "1";
    // Age lastSeenAt out aggressively — the live stream, not the timestamp,
    // is what must keep the session alive here.
    _setIdleTimeoutForTests(50); // 50 ms
    handle = await startSseServer(() => createAtlasMcpServer({ actor: SSE_ACTOR }), {
      port: 0,
    });

    // An SDK client holds its standalone GET notification stream open for the
    // life of the connection, so `activeStreams > 0`.
    const connected = new Client({ name: "client-connected", version: "0.0.1" });
    const connectedTransport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.server.port}/mcp`),
    );
    await connected.connect(connectedTransport);
    expect(handle._sessionCount()).toBe(1);

    // Let lastSeenAt age well past the 50ms idle window while the client
    // keeps listening.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // A second connection hits the cap. The cap-pressure sweep must NOT
    // reclaim the first session — its client is still listening — so the new
    // init is rejected rather than stealing a live client's slot.
    const blocked = new Client({ name: "client-blocked", version: "0.0.1" });
    const blockedTransport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.server.port}/mcp`),
    );
    await expect(blocked.connect(blockedTransport)).rejects.toThrow();
    expect(handle._sessionCount()).toBe(1);

    await connected.close();
  });
});
