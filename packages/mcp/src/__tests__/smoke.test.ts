/**
 * MCP server smoke tests — executeSQL success path, error messages,
 * and server lifecycle.
 *
 * Uses InMemoryTransport with mocked tool implementations.
 * Complements server.test.ts by adding success-path executeSQL round-trips,
 * SQL validation error handling, and server lifecycle tests.
 */
import { describe, expect, it, mock } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasUser } from "@atlas/api/lib/auth/types";

// Inject a bound actor so smoke tests don't depend on `resolveMcpActor`
// (mock leakage across files would otherwise break unrelated assertions).
const SMOKE_ACTOR = createAtlasUser("u_smoke", "managed", "smoke@test", {
  role: "admin",
  activeOrganizationId: "org_smoke",
});

// ---------------------------------------------------------------------------
// Module mocks — mock the named exports consumed by the server module
// ---------------------------------------------------------------------------

// Mock all named exports — partial mocks leak via the in-process Bun
// runner and break unrelated tests (`Export named 'getConfig' not found`).
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

mock.module("@atlas/api/lib/tools/explore", () => ({
  explore: {
    description: "Explore the semantic layer",
    execute: mock(async () => "catalog.yml\nentities/\nglossary.yml"),
  },
}));

// Dynamic mock: routes based on the SQL input for success/error scenarios
mock.module("@atlas/api/lib/tools/sql", () => ({
  executeSQL: {
    description: "Execute SQL",
    execute: mock(async ({ sql }: { sql: string }) => {
      if (sql === "SELECT count(*) FROM users") {
        return {
          success: true,
          explanation: "Count all users",
          row_count: 1,
          columns: ["count"],
          rows: [{ count: 42 }],
          truncated: false,
        };
      }
      if (sql === "DROP TABLE users") {
        return {
          success: false,
          error: "Only SELECT statements are allowed. Mutations are forbidden.",
        };
      }
      if (sql === "SELECT * FROM nonexistent_table") {
        return {
          success: false,
          error: "Table 'nonexistent_table' is not in the allowed table list.",
        };
      }
      return {
        success: false,
        error: "No valid datasource configured.",
      };
    }),
  },
}));

// Import after mocks are set up
const { createAtlasMcpServer } = await import("../server.js");

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function createTestPair() {
  const server = await createAtlasMcpServer({ actor: SMOKE_ACTOR });
  const client = new Client({ name: "smoke-test", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    server,
    client,
    async cleanup() {
      await client.close();
      await server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Tool listing
// ---------------------------------------------------------------------------

describe("MCP smoke — tool listing", () => {
  it("registers explore + executeSQL + the four typed semantic tools (#2020)", async () => {
    const { client, cleanup } = await createTestPair();
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
    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// executeSQL round-trip — success path
// ---------------------------------------------------------------------------

describe("MCP smoke — executeSQL round-trip", () => {
  it("returns structured { columns, rows } for valid SELECT", async () => {
    const { client, cleanup } = await createTestPair();

    const result = await client.callTool({
      name: "executeSQL",
      arguments: {
        sql: "SELECT count(*) FROM users",
        explanation: "Count all users",
      },
    });

    expect(result.isError).not.toBe(true);

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.columns).toEqual(["count"]);
    expect(parsed.rows).toEqual([{ count: 42 }]);
    expect(parsed.row_count).toBe(1);
    expect(parsed.truncated).toBe(false);
    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("MCP smoke — error handling", () => {
  it("returns isError with descriptive message for forbidden SQL", async () => {
    const { client, cleanup } = await createTestPair();

    const result = await client.callTool({
      name: "executeSQL",
      arguments: {
        sql: "DROP TABLE users",
        explanation: "Attempting destructive operation",
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Only SELECT statements are allowed");
    await cleanup();
  });

  it("returns isError with descriptive message for unknown table", async () => {
    const { client, cleanup } = await createTestPair();

    const result = await client.callTool({
      name: "executeSQL",
      arguments: {
        sql: "SELECT * FROM nonexistent_table",
        explanation: "Querying unknown table",
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("not in the allowed table list");
    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

describe("MCP smoke — server lifecycle", () => {
  it("server connects, operates, and shuts down cleanly", async () => {
    const server = await createAtlasMcpServer({ actor: SMOKE_ACTOR });
    const client = new Client({ name: "lifecycle-test", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // Verify the server is operational — explore + executeSQL + the four
    // typed semantic tools (#2020).
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(6);

    // Clean shutdown — should not throw
    await client.close();
    await server.close();
  });
});
