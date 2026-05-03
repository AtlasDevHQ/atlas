import { describe, expect, it, mock, beforeEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { getRequestContext } from "@atlas/api/lib/logger";

const TEST_ACTOR = createAtlasUser("u_sem", "managed", "sem@test", {
  role: "admin",
  activeOrganizationId: "org_sem",
});

// --- Mocks for the semantic lookup helpers + executeSQL pipeline ---

const mockListEntities = mock<(...args: unknown[]) => unknown>(() => [
  { name: "User", table: "users", description: "Users", source: "default" },
  { name: "orders", table: "orders", description: "Orders", source: "default" },
]);
const mockGetEntityByName = mock<(...args: unknown[]) => unknown>(
  (name: unknown) =>
    name === "users"
      ? { name: "User", table: "users", dimensions: [{ name: "id" }] }
      : null,
);
const mockSearchGlossary = mock<(...args: unknown[]) => unknown>(
  (term: unknown) =>
    term === "revenue"
      ? [
          {
            term: "revenue",
            status: "defined",
            definition: "Sum of paid invoices.",
            note: null,
            possible_mappings: [],
            source: "default",
          },
        ]
      : term === "status"
        ? [
            {
              term: "status",
              status: "ambiguous",
              definition: null,
              note: "appears in multiple tables — ASK the user",
              possible_mappings: ["orders.status", "users.status"],
              source: "default",
            },
          ]
        : [],
);
const mockFindMetricById = mock<(...args: unknown[]) => unknown>(
  (id: unknown) =>
    id === "orders_count"
      ? {
          id: "orders_count",
          label: "Total orders",
          description: "Distinct order count.",
          sql: "SELECT COUNT(DISTINCT id) AS count FROM orders",
          type: "atomic",
          aggregation: "count_distinct",
          unit: null,
          source: "default",
          binding: null,
        }
      : null,
);

mock.module("@atlas/api/lib/semantic/lookups", () => ({
  listEntities: mockListEntities,
  getEntityByName: mockGetEntityByName,
  searchGlossary: mockSearchGlossary,
  findMetricById: mockFindMetricById,
  // The SUT only needs the four above. Re-export the full surface area as
  // mocks anyway so other modules importing from this path don't break.
  loadGlossaryTerms: mock(() => []),
  loadMetricDefinitions: mock(() => []),
}));

const mockExecuteSQLExecute = mock<(...args: unknown[]) => Promise<unknown>>(
  async () => ({
    success: true,
    explanation: "ok",
    row_count: 1,
    columns: ["count"],
    rows: [{ count: 42 }],
    truncated: false,
  }),
);

mock.module("@atlas/api/lib/tools/sql", () => ({
  executeSQL: {
    description: "Execute SQL",
    execute: mockExecuteSQLExecute,
  },
}));

// Imports must come AFTER mock.module() registrations.
const { registerSemanticTools } = await import("../semantic-tools.js");

function getContentText(content: unknown): string {
  const arr = content as Array<{ type: string; text: string }>;
  return arr[0]?.text ?? "";
}

async function createTestClient(actor = TEST_ACTOR) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerSemanticTools(server, { actor });

  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server };
}

describe("MCP semantic tools", () => {
  beforeEach(() => {
    mockListEntities.mockClear();
    mockGetEntityByName.mockClear();
    mockSearchGlossary.mockClear();
    mockFindMetricById.mockClear();
    mockExecuteSQLExecute.mockClear();
  });

  it("registers four typed tools", async () => {
    const { client } = await createTestClient();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "describeEntity",
      "listEntities",
      "runMetric",
      "searchGlossary",
    ]);
  });

  // --- listEntities ---

  it("listEntities returns the catalog with a count", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "listEntities",
      arguments: {},
    });
    expect(mockListEntities).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(getContentText(result.content));
    expect(parsed.count).toBe(2);
    expect(parsed.entities[0].table).toBe("users");
  });

  it("listEntities passes filter through to the lookup helper", async () => {
    const { client } = await createTestClient();
    await client.callTool({
      name: "listEntities",
      arguments: { filter: "ord" },
    });
    expect(mockListEntities).toHaveBeenCalledWith({ filter: "ord" });
  });

  // --- describeEntity ---

  it("describeEntity returns the parsed entity for a known name", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "describeEntity",
      arguments: { name: "users" },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(getContentText(result.content));
    expect(parsed.found).toBe(true);
    expect(parsed.entity.table).toBe("users");
  });

  it("describeEntity returns { found: false } for an unknown entity", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "describeEntity",
      arguments: { name: "ghost" },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(getContentText(result.content));
    expect(parsed.found).toBe(false);
    expect(parsed.name).toBe("ghost");
  });

  // --- searchGlossary ---

  it("searchGlossary returns the matching terms with status and mappings", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "searchGlossary",
      arguments: { term: "status" },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(getContentText(result.content));
    expect(parsed.count).toBe(1);
    expect(parsed.matches[0].status).toBe("ambiguous");
    expect(parsed.matches[0].possible_mappings).toContain("orders.status");
  });

  it("searchGlossary returns an empty result list on a glossary miss", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "searchGlossary",
      arguments: { term: "nonexistent" },
    });
    const parsed = JSON.parse(getContentText(result.content));
    expect(parsed.count).toBe(0);
    expect(parsed.matches).toEqual([]);
  });

  // --- runMetric ---

  it("runMetric executes the metric SQL through executeSQL and returns the scalar value", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "runMetric",
      arguments: { id: "orders_count" },
    });

    expect(result.isError).toBeFalsy();
    expect(mockFindMetricById).toHaveBeenCalledWith("orders_count");
    expect(mockExecuteSQLExecute).toHaveBeenCalledTimes(1);

    const sqlArgs = (mockExecuteSQLExecute.mock.calls[0] as unknown[])[0] as {
      sql: string;
    };
    expect(sqlArgs.sql).toContain("SELECT COUNT(DISTINCT id)");

    const parsed = JSON.parse(getContentText(result.content));
    expect(parsed.id).toBe("orders_count");
    expect(parsed.value).toBe(42);
    expect(parsed.row_count).toBe(1);
    expect(typeof parsed.executed_at).toBe("string");
  });

  it("runMetric returns rows array when result has multiple columns or rows", async () => {
    mockExecuteSQLExecute.mockImplementationOnce(async () => ({
      success: true,
      explanation: "ok",
      row_count: 2,
      columns: ["status", "count"],
      rows: [
        { status: "open", count: 10 },
        { status: "closed", count: 5 },
      ],
      truncated: false,
    }));

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "runMetric",
      arguments: { id: "orders_count" },
    });

    const parsed = JSON.parse(getContentText(result.content));
    expect(Array.isArray(parsed.value)).toBe(true);
    expect(parsed.value).toHaveLength(2);
  });

  it("runMetric returns isError for an unknown metric id", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "runMetric",
      arguments: { id: "missing_metric" },
    });

    expect(result.isError).toBe(true);
    expect(getContentText(result.content)).toContain("not found");
    // executeSQL must not be called when the metric lookup fails — the
    // pipeline short-circuits before we touch SQL.
    expect(mockExecuteSQLExecute).not.toHaveBeenCalled();
  });

  it("runMetric surfaces validation/RLS rejections from executeSQL as isError", async () => {
    mockExecuteSQLExecute.mockImplementationOnce(async () => ({
      success: false,
      error: "RLS check failed: user has no claim for orders.org_id",
    }));

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "runMetric",
      arguments: { id: "orders_count" },
    });

    expect(result.isError).toBe(true);
    expect(getContentText(result.content)).toContain("RLS check failed");
  });

  it("runMetric rejects non-empty filters with a clear message", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "runMetric",
      arguments: {
        id: "orders_count",
        filters: { region: "us" },
      },
    });

    expect(result.isError).toBe(true);
    expect(getContentText(result.content)).toContain("filters");
    // Short-circuit before metric lookup or SQL execution.
    expect(mockFindMetricById).not.toHaveBeenCalled();
    expect(mockExecuteSQLExecute).not.toHaveBeenCalled();
  });

  it("runMetric forwards connectionId through to executeSQL", async () => {
    const { client } = await createTestClient();
    await client.callTool({
      name: "runMetric",
      arguments: { id: "orders_count", connectionId: "warehouse" },
    });

    const callArgs = (mockExecuteSQLExecute.mock.calls[0] as unknown[])[0] as {
      connectionId?: string;
    };
    expect(callArgs.connectionId).toBe("warehouse");
  });

  // --- actor binding ---
  // #1858 regression: every dispatch must wrap in withRequestContext so
  // executeSQL's approval gate sees a bound caller. Same shape as the
  // explore/executeSQL probe in tools.test.ts.

  it("runMetric dispatch sees the bound actor via getRequestContext", async () => {
    let observed: ReturnType<typeof getRequestContext>;
    mockExecuteSQLExecute.mockImplementationOnce(async () => {
      observed = getRequestContext();
      return {
        success: true,
        explanation: "ok",
        row_count: 0,
        columns: [],
        rows: [],
      };
    });

    const { client } = await createTestClient();
    await client.callTool({
      name: "runMetric",
      arguments: { id: "orders_count" },
    });

    expect(observed).toBeDefined();
    expect(observed!.user?.id).toBe(TEST_ACTOR.id);
    expect(observed!.user?.activeOrganizationId).toBe("org_sem");
  });

  it("listEntities dispatch sees the bound actor via getRequestContext", async () => {
    let observed: ReturnType<typeof getRequestContext>;
    mockListEntities.mockImplementationOnce(() => {
      observed = getRequestContext();
      return [];
    });

    const { client } = await createTestClient();
    await client.callTool({ name: "listEntities", arguments: {} });

    expect(observed).toBeDefined();
    expect(observed!.user?.id).toBe(TEST_ACTOR.id);
  });
});
