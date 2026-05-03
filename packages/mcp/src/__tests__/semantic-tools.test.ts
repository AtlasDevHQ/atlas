import { describe, expect, it, mock, beforeEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { getRequestContext } from "@atlas/api/lib/logger";
import { parseAtlasMcpToolError } from "@useatlas/types/mcp";

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
  registerSemanticTools(server, {
    actor,
    transport: "stdio",
    workspaceId: actor.activeOrganizationId ?? actor.id,
    deployMode: "self-hosted",
  });

  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server };
}

// Default executeSQL behaviour — single column / single row scalar metric.
// Restored in beforeEach so any test that uses `mockImplementationOnce`
// can't leak its custom behaviour into the next test.
const defaultExecuteSqlResult = {
  success: true,
  explanation: "ok",
  row_count: 1,
  columns: ["count"],
  rows: [{ count: 42 }],
  truncated: false,
};

describe("MCP semantic tools", () => {
  beforeEach(() => {
    mockListEntities.mockClear();
    mockGetEntityByName.mockClear();
    mockSearchGlossary.mockClear();
    mockFindMetricById.mockClear();
    mockExecuteSQLExecute.mockClear();
    // Reset to the documented base implementation so tests are
    // order-independent. Without this, a `mockImplementationOnce` left
    // over from a previous run could shape the next test's response.
    mockExecuteSQLExecute.mockImplementation(async () => defaultExecuteSqlResult);
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

  it("typed-tool descriptions document the error contract (#2030)", async () => {
    const { client } = await createTestClient();
    const result = await client.listTools();
    const map = new Map(result.tools.map((t) => [t.name, t.description ?? ""]));

    expect(map.get("listEntities")).toContain("Error contract");
    expect(map.get("describeEntity")).toContain("`unknown_entity`");
    // The disambiguation contract — the description must advertise
    // `ambiguous_term` so an LLM picks the right recovery from the tool
    // surface (the forthcoming #2025 eval harness will rely on this).
    expect(map.get("searchGlossary")).toContain("`ambiguous_term`");
    expect(map.get("runMetric")).toContain("`unknown_metric`");
    expect(map.get("runMetric")).toContain("`validation_failed`");
    expect(map.get("runMetric")).toContain("`rls_denied`");
  });

  // --- internal_error coverage on the read-only tools ---

  it("listEntities returns an internal_error envelope when the lookup throws", async () => {
    mockListEntities.mockImplementationOnce(() => {
      throw new Error("semantic root unreadable");
    });

    const { client } = await createTestClient();
    const result = await client.callTool({ name: "listEntities", arguments: {} });

    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("internal_error");
    expect(envelope!.message).toContain("semantic root unreadable");
    expect(envelope!.request_id).toMatch(/^mcp-listEntities-/);
  });

  it("describeEntity returns an internal_error envelope when the lookup throws", async () => {
    mockGetEntityByName.mockImplementationOnce(() => {
      throw new Error("yaml parse failed");
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "describeEntity",
      arguments: { name: "users" },
    });

    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("internal_error");
    expect(envelope!.message).toContain("yaml parse failed");
    expect(envelope!.request_id).toMatch(/^mcp-describeEntity-/);
  });

  it("searchGlossary returns an internal_error envelope when the lookup throws", async () => {
    mockSearchGlossary.mockImplementationOnce(() => {
      throw new Error("glossary index corrupt");
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "searchGlossary",
      arguments: { term: "anything" },
    });

    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("internal_error");
    expect(envelope!.message).toContain("glossary index corrupt");
    expect(envelope!.request_id).toMatch(/^mcp-searchGlossary-/);
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

  it("describeEntity returns an unknown_entity envelope when the entity does not exist", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "describeEntity",
      arguments: { name: "ghost" },
    });
    // #2030: missing entity is now a typed envelope so the agent can
    // branch on `code === "unknown_entity"` and call listEntities to
    // recover, instead of pattern-matching `found: false` prose.
    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope).not.toBeNull();
    expect(envelope!.code).toBe("unknown_entity");
    expect(envelope!.message).toContain("ghost");
    expect(envelope!.hint).toContain("listEntities");
  });

  // --- searchGlossary ---

  it("searchGlossary returns an ambiguous_term envelope when any match has status: ambiguous", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "searchGlossary",
      arguments: { term: "status" },
    });
    // #2030: the disambiguation contract — the envelope must use
    // `code === "ambiguous_term"` so the forthcoming #2025 eval harness
    // can branch on it. The hint must point the agent at
    // possible_mappings rather than letting it silently pick.
    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope).not.toBeNull();
    expect(envelope!.code).toBe("ambiguous_term");
    expect(envelope!.message).toContain("orders.status");
    expect(envelope!.message).toContain("users.status");
    expect(envelope!.hint).toContain("possible_mappings");
  });

  it("searchGlossary ambiguous envelope mentions sibling matches that were dropped", async () => {
    // The ambiguous override replaces the whole match list with a single
    // envelope — agents would otherwise lose the sibling defined terms
    // silently. The message must tell the agent additional matches exist
    // so it can re-call with a more specific term to recover them.
    mockSearchGlossary.mockImplementationOnce(() => [
      {
        term: "status",
        status: "ambiguous",
        definition: null,
        note: null,
        possible_mappings: ["orders.status"],
        source: "default",
      },
      {
        term: "revenue",
        status: "defined",
        definition: "Sum of paid invoices.",
        note: null,
        possible_mappings: [],
        source: "default",
      },
      {
        term: "lifetime_value",
        status: "defined",
        definition: "Sum of paid invoices per customer.",
        note: null,
        possible_mappings: [],
        source: "default",
      },
    ]);

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "searchGlossary",
      arguments: { term: "anything" },
    });

    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("ambiguous_term");
    expect(envelope!.message).toMatch(/2 additional matches omitted/);
    expect(envelope!.message).toContain("re-call searchGlossary");
  });

  it("searchGlossary returns prose JSON (not an envelope) for a defined term", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "searchGlossary",
      arguments: { term: "revenue" },
    });
    // status: "defined" is the happy path — the result is not an error
    // envelope, just the plain JSON so the agent can inline the definition.
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(getContentText(result.content));
    expect(parsed.count).toBe(1);
    expect(parsed.matches[0].status).toBe("defined");
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

    const callArgs = mockExecuteSQLExecute.mock.calls[0] as unknown[];
    const sqlArgs = callArgs[0] as { sql: string };
    const ctxArgs = callArgs[1] as { toolCallId?: string };
    expect(sqlArgs.sql).toContain("SELECT COUNT(DISTINCT id)");
    // The AI SDK execute signature is `(input, ctx)`; ctx must include
    // a toolCallId or downstream telemetry can't correlate the call.
    expect(ctxArgs.toolCallId).toBe("mcp-runMetric");

    const parsed = JSON.parse(getContentText(result.content));
    expect(parsed.id).toBe("orders_count");
    expect(parsed.value).toBe(42);
    expect(parsed.row_count).toBe(1);
    // ISO-8601: a numeric or RFC2822 fallback would still be a string but
    // would silently break MCP clients that parse this as a Date. Pin
    // the format with a regex.
    expect(parsed.executed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // Scalar coercion edge cases — `0`, `false`, and `null` are the most
  // likely metric values to silently break under a defensive `?? rows`.
  it.each([
    ["zero", 0],
    ["false", false],
    ["null", null],
  ])("runMetric coerces a single-column / single-row %s value as the scalar", async (_label, scalar) => {
    mockExecuteSQLExecute.mockImplementationOnce(async () => ({
      success: true,
      explanation: "ok",
      row_count: 1,
      columns: ["count"],
      rows: [{ count: scalar }],
      truncated: false,
    }));

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "runMetric",
      arguments: { id: "orders_count" },
    });

    const parsed = JSON.parse(getContentText(result.content));
    expect(parsed.value).toBe(scalar);
    expect(parsed.row_count).toBe(1);
  });

  it("runMetric returns an empty array as `value` when columns has one entry but rows is empty", async () => {
    mockExecuteSQLExecute.mockImplementationOnce(async () => ({
      success: true,
      explanation: "ok",
      row_count: 0,
      columns: ["count"],
      rows: [],
      truncated: false,
    }));

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "runMetric",
      arguments: { id: "orders_count" },
    });

    const parsed = JSON.parse(getContentText(result.content));
    // Falls into the multi-row branch (rows.length !== 1) and hands back
    // the (empty) rows array — distinct from `null` (single-row null
    // scalar) so callers can tell "no result" from "the result is null".
    expect(parsed.value).toEqual([]);
    expect(parsed.row_count).toBe(0);
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
    // `rows` is included unconditionally so MCP clients that always read
    // `rows` (rather than discriminating on `value`) keep working when
    // the metric has a breakdown shape. Lock that contract.
    expect(parsed.rows).toEqual(parsed.value);
  });

  it("runMetric returns an unknown_metric envelope for an unknown metric id", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "runMetric",
      arguments: { id: "missing_metric" },
    });

    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("unknown_metric");
    expect(envelope!.message).toContain("missing_metric");
    expect(envelope!.hint).toContain("metric ids");
    // executeSQL must not be called when the metric lookup fails — the
    // pipeline short-circuits before we touch SQL.
    expect(mockExecuteSQLExecute).not.toHaveBeenCalled();
  });

  // The runMetric tests below feed REAL upstream messages (not synthetic
  // stand-ins) so envelope-regex drift surfaces here, not in production.
  it("runMetric surfaces real RLS rejections (`Row-level security ...`) as rls_denied", async () => {
    mockExecuteSQLExecute.mockImplementationOnce(async () => ({
      success: false,
      error: "Row-level security is enabled but not fully configured. Contact your administrator.",
    }));

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "runMetric",
      arguments: { id: "orders_count" },
    });

    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("rls_denied");
    expect(envelope!.message).toContain("Row-level security");
  });

  it("runMetric maps a statement timeout to query_timeout", async () => {
    mockExecuteSQLExecute.mockImplementationOnce(async () => ({
      success: false,
      error: "canceling statement due to statement timeout",
    }));

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "runMetric",
      arguments: { id: "orders_count" },
    });

    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("query_timeout");
  });

  it("runMetric maps a real SQL guard rejection to validation_failed", async () => {
    mockExecuteSQLExecute.mockImplementationOnce(async () => ({
      success: false,
      error: "Forbidden SQL operation detected: drop\\s+table",
    }));

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "runMetric",
      arguments: { id: "orders_count" },
    });

    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("validation_failed");
  });

  it("runMetric maps the real `QPM limit reached` message to rate_limited and forwards retry_after", async () => {
    mockExecuteSQLExecute.mockImplementationOnce(async () => ({
      success: false,
      error: 'Source "default" QPM limit reached (60/min)',
      retryAfterMs: 8_000,
    }));

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "runMetric",
      arguments: { id: "orders_count" },
    });

    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("rate_limited");
    expect(envelope!.retry_after).toBe(8);
  });

  it("runMetric approval-required: surfaces approval_request_id intact, NOT as an error envelope", async () => {
    // Same governance contract as executeSQL — approval-required must not
    // be demoted to internal_error or the agent will retry and silently
    // duplicate the approval request.
    mockExecuteSQLExecute.mockImplementationOnce(async () => ({
      success: false,
      approval_required: true,
      approval_request_id: "appr_xyz",
      matched_rules: ["pii-tables"],
      message: 'This query requires approval before execution. Rule: "pii-tables". An approval request has been submitted (ID: appr_xyz).',
    }));

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "runMetric",
      arguments: { id: "orders_count" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(getContentText(result.content));
    expect(parsed.approval_required).toBe(true);
    expect(parsed.approval_request_id).toBe("appr_xyz");
    expect(parsed.message).toContain("appr_xyz");
  });

  it("runMetric falls back to internal_error on opaque executeSQL failures", async () => {
    mockExecuteSQLExecute.mockImplementationOnce(async () => ({
      success: false,
      error: "Some completely unknown failure mode the regex catalog doesn't recognize",
    }));

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "runMetric",
      arguments: { id: "orders_count" },
    });

    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("internal_error");
    expect(envelope!.request_id).toMatch(/^mcp-runMetric-/);
  });

  it("runMetric rejects non-empty filters with a validation_failed envelope", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "runMetric",
      arguments: {
        id: "orders_count",
        filters: { region: "us" },
      },
    });

    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("validation_failed");
    expect(envelope!.message).toContain("filters");
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
