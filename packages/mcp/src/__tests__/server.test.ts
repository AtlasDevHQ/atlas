import { describe, expect, it, mock } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import pkg from "../../package.json" with { type: "json" };

// Server tests inject the actor directly so they don't depend on
// `resolveMcpActor` (whose env-var + rule-lookup behaviour is pinned in
// actor.test.ts). Mock leakage across test files would otherwise spoil
// these unrelated assertions.
const TEST_ACTOR = createAtlasUser("u_server", "managed", "server@test", {
  role: "admin",
  activeOrganizationId: "org_server",
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
      success: false,
      error: "No valid datasource configured.",
    })),
  },
}));

// Import after mocks are set up
const { createAtlasMcpServer } = await import("../server.js");

describe("MCP server integration", () => {
  it("creates a server and lists explore + executeSQL + the four typed semantic tools", async () => {
    const server = await createAtlasMcpServer({ actor: TEST_ACTOR });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

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
  });

  it("creates a server and lists resources", async () => {
    const server = await createAtlasMcpServer({ actor: TEST_ACTOR });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.listResources();
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain("atlas://semantic/catalog");
    expect(uris).toContain("atlas://semantic/glossary");
  });

  it("explore tool returns text via MCP", async () => {
    const server = await createAtlasMcpServer({ actor: TEST_ACTOR });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "explore",
      arguments: { command: "ls" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("catalog.yml");
  });

  it("executeSQL with bad config returns isError", async () => {
    const server = await createAtlasMcpServer({ actor: TEST_ACTOR });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "executeSQL",
      arguments: {
        sql: "SELECT 1",
        explanation: "Test query",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("serverInfo.version tracks @atlas/mcp/package.json", async () => {
    const server = await createAtlasMcpServer({ actor: TEST_ACTOR });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const info = client.getServerVersion();
    expect(info?.version).toBe(pkg.version);
    expect(info?.name).toBe("atlas");
  });

  it("skipConfig option skips initialization", async () => {
    const { initializeConfig } = await import("@atlas/api/lib/config");
    const mockFn = initializeConfig as ReturnType<typeof mock>;
    mockFn.mockClear();

    await createAtlasMcpServer({ skipConfig: true, actor: TEST_ACTOR });
    expect(mockFn).not.toHaveBeenCalled();
  });
});
