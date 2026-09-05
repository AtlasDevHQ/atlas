/**
 * MCP server integration tests — the `createAtlasMcpServer` factory driven
 * through a real MCP client over InMemoryTransport.
 *
 * Also home to the executeSQL round-trip / SQL-error / lifecycle cases that
 * were formerly `smoke.test.ts`, merged here because both suites drove the
 * same factory. The exact-tool-list assertion that file duplicated is dropped;
 * the copy in "creates a server and lists explore + executeSQL + query + the
 * four typed semantic tools" below asserts the identical array.
 */
import { describe, expect, it, mock } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { getRequestContext, withRequestContext } from "@atlas/api/lib/logger";
import pkg from "../../package.json" with { type: "json" };

// Server tests inject the actor directly so they don't depend on
// `resolveMcpActor` (whose env-var + rule-lookup behaviour is pinned in
// actor.test.ts). Mock leakage across test files would otherwise spoil
// these unrelated assertions.
const TEST_ACTOR = createAtlasUser("u_server", "managed", "server@test", {
  role: "admin",
  activeOrganizationId: "org_server",
});

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

// Mock tool execute functions
void mock.module("@atlas/api/lib/tools/explore", () => ({
  explore: {
    description: "Explore the semantic layer",
    execute: mock(async () => "catalog.yml\nentities/\nglossary.yml"),
  },
}));

// Dynamic mock: routes on the SQL input so the success path and the two
// SQL-validation error shapes are all reachable. Any other statement falls
// through to the "no datasource" failure the factory tests rely on.
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
// so these tests stay hermetic. Mock ALL runtime exports so a sibling test
// loading the real module doesn't inherit a partial mock (CLAUDE.md); the
// module's other exports (`AgentBillingBlock`, `AgentBillingGateResult`) are
// types and erase at runtime.
void mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: mock(async (_orgId: string | undefined) => ({ allowed: true as const })),
  BillingBlockedError: class BillingBlockedError extends Error {
    override readonly name = "BillingBlockedError";
  },
}));

// Import after mocks are set up
const { createAtlasMcpServer } = await import("../server.js");

describe("MCP server integration", () => {
  it("creates a server and lists explore + executeSQL + query + the four typed semantic tools", async () => {
    const server = await createAtlasMcpServer({ actor: TEST_ACTOR });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

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
      "searchAtlas",
      "searchGlossary",
      "test_datasource",
    ]);
  });

  it("advertises tools/resources/prompts capabilities and not logging (#3497)", async () => {
    const server = await createAtlasMcpServer({ actor: TEST_ACTOR });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const caps = client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
    expect(caps?.resources).toBeDefined();
    expect(caps?.prompts).toBeDefined();
    // `logging`/`sampling`/`roots` are intentionally not adopted (deprecated
    // in the 2026-07-28 draft) — PRD #3483.
    expect(caps?.logging).toBeUndefined();
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

  // #2067 — hosted MCP threads `bindFactoryContext.clientId` →
  // `createAtlasMcpServer({ clientId })` → `RequestContext.actor.clientId`
  // → `audit_log.client_id`. The hosted-route plumbing is exercised in
  // hosted.test.ts; this test pins the server-factory leg so a regression
  // that drops the `clientId` field on `CreateMcpServerOptions` is caught
  // even if hosted.ts continues to set `mcp_session.start.metadata.clientId`.
  it("threads clientId from createAtlasMcpServer into RequestContext.actor", async () => {
    let observed: ReturnType<typeof getRequestContext>;
    const { explore } = await import("@atlas/api/lib/tools/explore");
    const exploreExecuteMock = explore.execute as ReturnType<typeof mock>;
    exploreExecuteMock.mockImplementationOnce(async () => {
      observed = getRequestContext();
      return "ok";
    });

    const server = await createAtlasMcpServer({
      actor: TEST_ACTOR,
      skipConfig: true,
      clientId: "claude-desktop",
    });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // The hosted route's outermost transport frame (`hosted.ts`): published
    // mode, no `connectionId` pin. The tool body must read the mode through
    // the dispatch's own frame (#5626).
    await withRequestContext(
      { requestId: "hosted-transport", user: TEST_ACTOR, atlasMode: "published", agentOrigin: "mcp" },
      () => client.callTool({ name: "explore", arguments: { command: "ls" } }),
    );

    expect(observed!.actor).toEqual({
      kind: "mcp",
      clientId: "claude-desktop",
      toolName: "explore",
    });
    expect(observed!.atlasMode).toBe("published");
    expect(observed!.requestId).not.toBe("hosted-transport");
    // The dispatch frame carries a `connectionId` pin only when the door that
    // mounted it set one (the anonymous demo does). The hosted server pins
    // nothing, so its tools resolve their own default — asserted here so the
    // carry-through can never turn into an implicit pin on this route.
    expect(observed!.connectionId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Formerly smoke.test.ts — a shared client pair for the round-trip cases.
// ---------------------------------------------------------------------------

async function createTestPair() {
  const server = await createAtlasMcpServer({ actor: TEST_ACTOR });
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

describe("MCP smoke — server lifecycle", () => {
  it("server connects, operates, and shuts down cleanly", async () => {
    const server = await createAtlasMcpServer({ actor: TEST_ACTOR });
    const client = new Client({ name: "lifecycle-test", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // Verify the server is operational — explore + executeSQL + the NL-agent
    // query tool (#4094) + searchBrain (#4773) + the four typed semantic tools
    // (#2020) + the nine datasource lifecycle tools (#3511–#3514, #3547,
    // #4126) = 17.
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(17);

    // Clean shutdown — should not throw
    await client.close();
    await server.close();
  });
});
