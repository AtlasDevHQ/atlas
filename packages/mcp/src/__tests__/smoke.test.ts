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
void mock.module("@atlas/api/lib/config", () => ({
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

// Gate-1 action policy (#4095): executeSQL declares actionCategory "raw_sql",
// so the dispatch gate consults the per-workspace policy. Stub it all-allowed
// (no real `mcp_action_policy` table here) — mock ALL runtime exports so a
// sibling test loading the real module doesn't inherit a partial mock (CLAUDE.md).
void mock.module("@atlas/api/lib/mcp/action-policy", () => ({
  loadMcpActionPolicy: async () => ({ isBlocked: () => false }),
  mcpActionDenialCopy: (category: string) => ({
    message: `MCP '${category}' actions are disabled for this workspace by an administrator.`,
    hint: "A workspace admin can re-enable this category under Admin → MCP action policy.",
  }),
  MCP_ACTION_CATEGORIES: ["datasource", "integration", "policy", "raw_sql"],
  MCP_ACTION_CATEGORY_META: [],
  isMcpActionCategory: (v: string) =>
    ["datasource", "integration", "policy", "raw_sql"].includes(v),
  getMcpActionPolicyEntries: async () => [],
  setMcpActionCategoryStatus: async () => {},
}));

// Gate-0 billing gate (#3437; stub added by #4370): the dispatch path consults
// `checkAgentBillingGate` before any datasource query (executeSQL / runMetric).
// The real gate reads the internal DB (`organization` / `settings`) and FAILS
// CLOSED when that DB is missing or unmigrated, short-circuiting to
// `internal_error` before the mocked `executeSQL` ever runs. Stub it all-allowed
// so these smoke tests stay hermetic. Mock ALL runtime exports so a sibling test
// loading the real module doesn't inherit a partial mock (CLAUDE.md); the
// module's other exports (`AgentBillingBlock`, `AgentBillingGateResult`) are
// types and erase at runtime.
void mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: mock(async (_orgId: string | undefined) => ({ allowed: true as const })),
  BillingBlockedError: class BillingBlockedError extends Error {
    override readonly name = "BillingBlockedError";
  },
}));

void mock.module("@atlas/api/lib/tools/explore", () => ({
  explore: {
    description: "Explore the semantic layer",
    execute: mock(async () => "catalog.yml\nentities/\nglossary.yml"),
  },
}));

// Dynamic mock: routes based on the SQL input for success/error scenarios
void mock.module("@atlas/api/lib/tools/sql", () => ({
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
  it("registers explore + executeSQL + the typed semantic tools + datasource lifecycle tools (#2020, #3511–#3514)", async () => {
    const { client, cleanup } = await createTestPair();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "archive_datasource",
      "create_datasource",
      "create_rest_datasource",
      "delete_datasource",
      "describeEntity",
      "executeSQL",
      "explore",
      "listEntities",
      "list_datasources",
      "profile_datasource",
      "publish_datasources",
      "query",
      "restore_datasource",
      "runMetric",
      "searchGlossary",
      "test_datasource",
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

    // Verify the server is operational — explore + executeSQL + the NL-agent
    // query tool (#4094) + the four typed semantic tools (#2020) + the nine
    // datasource lifecycle tools (#3511–#3514, #3547, #4126) = 16.
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(16);

    // Clean shutdown — should not throw
    await client.close();
    await server.close();
  });
});
