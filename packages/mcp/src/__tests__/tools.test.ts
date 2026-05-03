import { describe, expect, it, mock, beforeEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { getRequestContext } from "@atlas/api/lib/logger";
import { parseAtlasMcpToolError } from "@useatlas/types/mcp";
import { registerTools } from "../tools.js";

const TEST_ACTOR = createAtlasUser("u_test", "managed", "test@example.com", {
  role: "admin",
  activeOrganizationId: "org_test",
});

// --- Mocks for AI SDK tool execute functions ---
// Use `unknown` return type so mockResolvedValueOnce can return different shapes.

const mockExploreExecute = mock<(...args: unknown[]) => Promise<unknown>>(
  async () => "catalog.yml\nentities/\nglossary.yml",
);
const mockExecuteSQLExecute = mock<(...args: unknown[]) => Promise<unknown>>(
  async () => ({
    success: true,
    explanation: "Count all users",
    row_count: 1,
    columns: ["count"],
    rows: [{ count: 42 }],
    truncated: false,
  }),
);

mock.module("@atlas/api/lib/tools/explore", () => ({
  explore: {
    description: "Explore the semantic layer",
    execute: mockExploreExecute,
  },
}));

mock.module("@atlas/api/lib/tools/sql", () => ({
  executeSQL: {
    description: "Execute SQL",
    execute: mockExecuteSQLExecute,
  },
}));

/** Extract text from MCP tool call result content. */
function getContentText(content: unknown): string {
  const arr = content as Array<{ type: string; text: string }>;
  return arr[0]?.text ?? "";
}

async function createTestClient(actor = TEST_ACTOR) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerTools(server, { actor });

  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server };
}

describe("MCP tools", () => {
  beforeEach(() => {
    mockExploreExecute.mockClear();
    mockExecuteSQLExecute.mockClear();
  });

  it("lists explore + executeSQL + the four typed semantic tools (#2020)", async () => {
    const { client } = await createTestClient();
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

  it("tool descriptions document the error contract (#2030)", async () => {
    const { client } = await createTestClient();
    const result = await client.listTools();
    const explore = result.tools.find((t) => t.name === "explore");
    const sql = result.tools.find((t) => t.name === "executeSQL");

    // The LLM-facing description must list the codes the agent can branch
    // on — we don't assume the agent reads the SDK types.
    expect(explore?.description).toContain("Error contract");
    expect(explore?.description).toContain("`internal_error`");
    expect(sql?.description).toContain("Error contract");
    expect(sql?.description).toContain("`validation_failed`");
    expect(sql?.description).toContain("`rls_denied`");
    expect(sql?.description).toContain("`query_timeout`");
    expect(sql?.description).toContain("`rate_limited`");
  });

  it("explore returns text content", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "explore",
      arguments: { command: "ls" },
    });

    expect(mockExploreExecute).toHaveBeenCalledTimes(1);
    expect(result.content).toEqual([
      { type: "text", text: "catalog.yml\nentities/\nglossary.yml" },
    ]);
    expect(result.isError).toBeFalsy();
  });

  it("explore returns an internal_error envelope on exit-coded backend output", async () => {
    mockExploreExecute.mockResolvedValueOnce("Error (exit 1):\ncommand not found");

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "explore",
      arguments: { command: "bad-command" },
    });

    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope).not.toBeNull();
    expect(envelope!.code).toBe("internal_error");
    expect(envelope!.message).toContain("command not found");
    expect(envelope!.request_id).toMatch(/^mcp-explore-/);
  });

  it("explore returns a rate_limited envelope when the backend says so", async () => {
    mockExploreExecute.mockResolvedValueOnce("Error: too many requests, slow down");

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "explore",
      arguments: { command: "ls" },
    });

    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("rate_limited");
    // request_id is only set on internal_error — rate_limited is operator-side
    // and the agent doesn't need a correlation id to back off.
    expect(envelope!.request_id).toBeUndefined();
  });

  it("executeSQL returns JSON content on success", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "executeSQL",
      arguments: {
        sql: "SELECT count(*) FROM users",
        explanation: "Count users",
      },
    });

    expect(mockExecuteSQLExecute).toHaveBeenCalledTimes(1);
    const text = getContentText(result.content);
    const parsed = JSON.parse(text);
    expect(parsed.row_count).toBe(1);
    expect(parsed.rows).toEqual([{ count: 42 }]);
    expect(result.isError).toBeFalsy();
  });

  it("executeSQL returns a validation_failed envelope on a SQL guard rejection", async () => {
    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      error: "Forbidden SQL operation detected",
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "executeSQL",
      arguments: {
        sql: "DROP TABLE users",
        explanation: "Drop table",
      },
    });

    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope).not.toBeNull();
    expect(envelope!.code).toBe("validation_failed");
    expect(envelope!.message).toContain("Forbidden SQL operation");
  });

  it("executeSQL maps an RLS rejection to rls_denied", async () => {
    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      error: "RLS check failed: user has no claim for orders.org_id",
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT * FROM orders", explanation: "All orders" },
    });

    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("rls_denied");
  });

  it("executeSQL maps a statement timeout to query_timeout", async () => {
    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      error: "canceling statement due to statement timeout",
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT * FROM huge", explanation: "Huge scan" },
    });

    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("query_timeout");
  });

  it("executeSQL maps an unknown table to unknown_entity", async () => {
    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      error: "Table 'ghosts' is not whitelisted in the semantic layer",
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT * FROM ghosts", explanation: "Ghost scan" },
    });

    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("unknown_entity");
  });

  it("executeSQL maps a rate-limit rejection to rate_limited and forwards retry_after", async () => {
    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      error: "Rate limit exceeded for source default",
      retryAfterMs: 12_000,
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "ping" },
    });

    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("rate_limited");
    // Wire field uses snake_case so SDK consumers see the same shape the
    // typed envelope advertises. retryAfterMs (ms) → retry_after (s).
    expect(envelope!.retry_after).toBe(12);
  });

  it("executeSQL falls back to internal_error with a request_id on opaque failures", async () => {
    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      error: "Approval system unavailable — query blocked. Contact your administrator.",
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "ping" },
    });

    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("internal_error");
    // request_id is mandatory on internal_error so users can correlate with
    // server logs — the contract called out in @useatlas/types/mcp.
    expect(envelope!.request_id).toBeDefined();
    expect(envelope!.request_id).toMatch(/^mcp-executeSQL-/);
  });

  it("executeSQL passes connectionId through", async () => {
    const { client } = await createTestClient();
    await client.callTool({
      name: "executeSQL",
      arguments: {
        sql: "SELECT 1",
        explanation: "Test",
        connectionId: "warehouse",
      },
    });

    expect(mockExecuteSQLExecute).toHaveBeenCalledTimes(1);
    const calls = mockExecuteSQLExecute.mock.calls;
    const firstCallArgs = calls[calls.length - 1] as unknown[];
    expect((firstCallArgs[0] as Record<string, unknown>).connectionId).toBe("warehouse");
  });

  it("explore catches thrown exception and returns an internal_error envelope", async () => {
    mockExploreExecute.mockRejectedValueOnce(new Error("sandbox crashed"));

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "explore",
      arguments: { command: "ls" },
    });

    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("internal_error");
    expect(envelope!.message).toContain("sandbox crashed");
    expect(envelope!.request_id).toBeDefined();
  });

  it("explore JSON-stringifies non-string return values", async () => {
    mockExploreExecute.mockResolvedValueOnce({ files: ["a.yml", "b.yml"] });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "explore",
      arguments: { command: "ls" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(getContentText(result.content));
    expect(parsed.files).toEqual(["a.yml", "b.yml"]);
  });

  it("executeSQL catches thrown exception and returns an internal_error envelope", async () => {
    mockExecuteSQLExecute.mockRejectedValueOnce(new Error("connection lost"));

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "executeSQL",
      arguments: {
        sql: "SELECT 1",
        explanation: "Test",
      },
    });

    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("internal_error");
    expect(envelope!.message).toContain("connection lost");
    expect(envelope!.request_id).toBeDefined();
  });

  it("executeSQL returns an internal_error envelope when success is false with no error field", async () => {
    mockExecuteSQLExecute.mockResolvedValueOnce({ success: false });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "executeSQL",
      arguments: {
        sql: "SELECT 1",
        explanation: "Test",
      },
    });

    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("internal_error");
    expect(envelope!.message).toBe("Query failed");
  });

  // #1858 — actor binding regression. Inside executeSQL the approval gate
  // reads `getRequestContext()?.user?.activeOrganizationId`; if MCP forgot
  // to wrap the dispatch, the user is undefined and any approval-rule-
  // matching query silently bypasses governance (the F-54/F-55 shape).
  it("executeSQL dispatch sees the bound actor via getRequestContext", async () => {
    let observed: ReturnType<typeof getRequestContext>;
    mockExecuteSQLExecute.mockImplementationOnce(async () => {
      observed = getRequestContext();
      return { success: true, explanation: "noop", row_count: 0, columns: [], rows: [] };
    });

    const { client } = await createTestClient();
    await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "Bound-actor probe" },
    });

    expect(observed).toBeDefined();
    expect(observed!.user?.id).toBe(TEST_ACTOR.id);
    expect(observed!.user?.activeOrganizationId).toBe("org_test");
    expect(typeof observed!.requestId).toBe("string");
    expect(observed!.requestId.length).toBeGreaterThan(0);
  });

  it("explore dispatch sees the bound actor via getRequestContext", async () => {
    let observed: ReturnType<typeof getRequestContext>;
    mockExploreExecute.mockImplementationOnce(async () => {
      observed = getRequestContext();
      return "ls output";
    });

    const { client } = await createTestClient();
    await client.callTool({ name: "explore", arguments: { command: "ls" } });

    expect(observed).toBeDefined();
    expect(observed!.user?.id).toBe(TEST_ACTOR.id);
  });

});
