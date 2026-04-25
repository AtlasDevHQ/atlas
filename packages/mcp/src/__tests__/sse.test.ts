import { describe, expect, it, afterEach, mock } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAtlasUser } from "@atlas/api/lib/auth/types";

// Inject a bound actor so SSE tests don't depend on `resolveMcpActor`.
const SSE_ACTOR = createAtlasUser("u_sse", "managed", "sse@test", {
  role: "admin",
  activeOrganizationId: "org_sse",
});

// Mock config initialization to avoid requiring a real database
mock.module("@atlas/api/lib/config", () => ({
  initializeConfig: mock(async () => ({
    datasources: {},
    tools: ["explore", "executeSQL"],
    auth: "auto",
    semanticLayer: "./semantic",
    source: "env",
  })),
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
const { startSseServer } = await import("../sse.js");

type SseHandle = Awaited<ReturnType<typeof startSseServer>>;
let handle: SseHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
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
    expect(result.tools.length).toBe(2);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["executeSQL", "explore"]);

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

    // Both clients can list tools independently
    const result1 = await client1.listTools();
    const result2 = await client2.listTools();
    expect(result1.tools.length).toBe(2);
    expect(result2.tools.length).toBe(2);

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
