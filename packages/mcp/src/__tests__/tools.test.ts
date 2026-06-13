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

// --- Billing gate mock (#3437) ---
// The MCP layer consults `checkAgentBillingGate` before any datasource
// query (executeSQL / runMetric). Tests flip `billingGateVerdict` to
// exercise the blocked arm; the default allows so the rest of the suite
// is unaffected.

type GateVerdict =
  | { allowed: true }
  | {
      allowed: false;
      errorCode: string;
      errorMessage: string;
      httpStatus: 403 | 404 | 429 | 503;
      retryable: boolean;
      retryAfterSeconds?: number;
      usage?: { currentUsage: number; limit: number; metric: string };
    };
let billingGateVerdict: GateVerdict = { allowed: true };
const mockCheckAgentBillingGate = mock(async (_orgId: string | undefined) => billingGateVerdict);

mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: mockCheckAgentBillingGate,
  BillingBlockedError: class BillingBlockedError extends Error {
    override readonly name = "BillingBlockedError";
  },
}));

/** Extract text from MCP tool call result content. */
function getContentText(content: unknown): string {
  const arr = content as Array<{ type: string; text: string }>;
  return arr[0]?.text ?? "";
}

async function createTestClient(
  actor = TEST_ACTOR,
  clientId?: string,
  scopes?: readonly string[],
) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerTools(server, {
    actor,
    ...(clientId ? { clientId } : {}),
    ...(scopes ? { scopes } : {}),
  });

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
    billingGateVerdict = { allowed: true };
    mockCheckAgentBillingGate.mockClear();
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
    // #3437 — the billing gate can block executeSQL; the LLM-facing
    // contract must advertise the code so the agent doesn't blind-retry.
    expect(sql?.description).toContain("`billing_blocked`");
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

  // Each test below uses the LITERAL upstream message string emitted by the
  // upstream constructor (sql.ts / rls.ts / source-rate-limit.ts /
  // connection.ts) — NOT a synthetic stand-in. If the upstream rewords its
  // message and the envelope regex isn't updated, these tests break, which
  // is the desired drift signal. (See `error-envelope.ts` header for the
  // tagged-error replumb that would replace string matching.)

  it("executeSQL returns validation_failed for `Forbidden SQL operation detected` (sql.ts:304)", async () => {
    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      error: "Forbidden SQL operation detected: drop\\s+table",
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

  it("executeSQL returns validation_failed for `Empty query` and `Multiple statements are not allowed` (sql.ts:268, 322)", async () => {
    const { client } = await createTestClient();

    mockExecuteSQLExecute.mockResolvedValueOnce({ success: false, error: "Empty query" });
    let result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "", explanation: "empty" },
    });
    expect(parseAtlasMcpToolError(getContentText(result.content))!.code).toBe("validation_failed");

    mockExecuteSQLExecute.mockResolvedValueOnce({ success: false, error: "Multiple statements are not allowed" });
    result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1; SELECT 2", explanation: "two" },
    });
    expect(parseAtlasMcpToolError(getContentText(result.content))!.code).toBe("validation_failed");
  });

  it("executeSQL returns validation_failed for `Query could not be parsed.` (sql.ts:361)", async () => {
    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      error: "Query could not be parsed. unexpected token at position 12. Rewrite using standard SQL syntax.",
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT FROM WHERE", explanation: "broken" },
    });

    expect(parseAtlasMcpToolError(getContentText(result.content))!.code).toBe("validation_failed");
  });

  it("executeSQL returns rls_denied for the real `Row-level security is enabled but not fully configured` message (sql.ts:651)", async () => {
    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      error: "Row-level security is enabled but not fully configured. Contact your administrator.",
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT * FROM orders", explanation: "All orders" },
    });

    expect(result.isError).toBe(true);
    expect(parseAtlasMcpToolError(getContentText(result.content))!.code).toBe("rls_denied");
  });

  it("executeSQL returns rls_denied for `RLS policy ...` and `RLS is enabled ...` (rls.ts:91, 134)", async () => {
    const { client } = await createTestClient();

    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      error: 'RLS policy requires claim "org_id" but it is missing from the user\'s claims. Query blocked.',
    });
    let result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "x" },
    });
    expect(parseAtlasMcpToolError(getContentText(result.content))!.code).toBe("rls_denied");

    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      error: "RLS is enabled but no authenticated user is available. Authentication is required when RLS policies are active.",
    });
    result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "x" },
    });
    expect(parseAtlasMcpToolError(getContentText(result.content))!.code).toBe("rls_denied");
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

  it("executeSQL returns unknown_entity for `is not in the allowed list` (sql.ts:393)", async () => {
    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      error: 'Table "ghosts" is not in the allowed list. Check catalog.yml for available tables.',
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT * FROM ghosts", explanation: "Ghost scan" },
    });

    expect(parseAtlasMcpToolError(getContentText(result.content))!.code).toBe("unknown_entity");
  });

  it("executeSQL returns unknown_entity for `Connection \"X\" is not registered.` (sql.ts:544)", async () => {
    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      error: 'Connection "warehouse" is not registered.',
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "x", connectionId: "warehouse" },
    });

    expect(parseAtlasMcpToolError(getContentText(result.content))!.code).toBe("unknown_entity");
  });

  it("executeSQL returns rate_limited for the real `QPM limit reached` message (source-rate-limit.ts:99)", async () => {
    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      error: 'Source "default" QPM limit reached (60/min)',
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

  it("executeSQL returns rate_limited for `Connection pool capacity reached` (sql.ts:556)", async () => {
    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      error: "Connection pool capacity reached — the system is handling many concurrent tenants. Try again shortly.",
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "ping" },
    });

    expect(parseAtlasMcpToolError(getContentText(result.content))!.code).toBe("rate_limited");
  });

  it("executeSQL approval-required: surfaces approval_request_id + message intact, NOT as an error envelope (sql.ts:1093)", async () => {
    // The pre-fix bug demoted approval-required to internal_error "Query
    // failed", losing the request id and prompting the agent to retry +
    // silently re-create duplicate approval requests. Lock the contract.
    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      approval_required: true,
      approval_request_id: "appr_abc123",
      matched_rules: ["pii-tables"],
      message: 'This query requires approval before execution. Rule: "pii-tables". An approval request has been submitted (ID: appr_abc123). An admin must approve it before the query can run.',
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT * FROM customers", explanation: "PII scan" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(getContentText(result.content));
    expect(parsed.approval_required).toBe(true);
    expect(parsed.approval_request_id).toBe("appr_abc123");
    expect(parsed.message).toContain("appr_abc123");
    expect(parsed.matched_rules).toEqual(["pii-tables"]);
  });

  it("executeSQL falls back to internal_error with a request_id on opaque failures", async () => {
    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      error: "Some completely unknown failure mode the regex catalog doesn't recognize",
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

  // #2067 — every tool dispatch must stamp `actor: { kind: "mcp", toolName }`
  // on the request context so `audit_log.{actor_kind, tool_name}` is populated.
  // A regression that drops the third arg from any single `withRequestContext`
  // call would invisibly NULL out those columns for that tool — these tests
  // pin the wrap shape per dispatch site.
  it("executeSQL stamps actor: mcp + toolName on RequestContext", async () => {
    let observed: ReturnType<typeof getRequestContext>;
    mockExecuteSQLExecute.mockImplementationOnce(async () => {
      observed = getRequestContext();
      return { success: true, explanation: "noop", row_count: 0, columns: [], rows: [] };
    });

    const { client } = await createTestClient();
    await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "actor probe" },
    });

    expect(observed!.actor).toEqual({ kind: "mcp", toolName: "executeSQL" });
  });

  it("explore stamps actor: mcp + toolName on RequestContext", async () => {
    let observed: ReturnType<typeof getRequestContext>;
    mockExploreExecute.mockImplementationOnce(async () => {
      observed = getRequestContext();
      return "ls output";
    });

    const { client } = await createTestClient();
    await client.callTool({ name: "explore", arguments: { command: "ls" } });

    expect(observed!.actor).toEqual({ kind: "mcp", toolName: "explore" });
  });

  it("threads clientId through registerTools into RequestContext.actor", async () => {
    let observed: ReturnType<typeof getRequestContext>;
    mockExecuteSQLExecute.mockImplementationOnce(async () => {
      observed = getRequestContext();
      return { success: true, explanation: "noop", row_count: 0, columns: [], rows: [] };
    });

    const { client } = await createTestClient(TEST_ACTOR, "claude-desktop");
    await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "clientId probe" },
    });

    expect(observed!.actor).toEqual({
      kind: "mcp",
      clientId: "claude-desktop",
      toolName: "executeSQL",
    });
  });

  it("#3504: threads OAuth token scopes through registerTools into RequestContext.scopes", async () => {
    let observed: ReturnType<typeof getRequestContext>;
    mockExecuteSQLExecute.mockImplementationOnce(async () => {
      observed = getRequestContext();
      return { success: true, explanation: "noop", row_count: 0, columns: [], rows: [] };
    });

    const { client } = await createTestClient(TEST_ACTOR, "claude-desktop", [
      "mcp:read",
      "mcp:write",
    ]);
    await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "scope probe" },
    });

    expect(observed!.scopes).toEqual(["mcp:read", "mcp:write"]);
  });

  it("#3504: leaves RequestContext.scopes undefined for stdio dispatch (no bearer)", async () => {
    let observed: ReturnType<typeof getRequestContext>;
    mockExecuteSQLExecute.mockImplementationOnce(async () => {
      observed = getRequestContext();
      return { success: true, explanation: "noop", row_count: 0, columns: [], rows: [] };
    });

    // stdio: createTestClient with no clientId / no scopes.
    const { client } = await createTestClient();
    await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "stdio probe" },
    });

    expect(observed!.scopes).toBeUndefined();
  });

  // #3437 — billing enforcement on the MCP datasource-query perimeter.
  // A suspended / trial-expired workspace must not be able to query
  // connected datasources through MCP. Blocks surface as the shaped
  // AtlasMcpToolError envelope, never a silent empty result.

  describe("billing gate (#3437)", () => {
    it("executeSQL returns billing_blocked when the workspace is suspended — query never runs", async () => {
      billingGateVerdict = {
        allowed: false,
        errorCode: "workspace_suspended",
        errorMessage: "Workspace suspended due to unusual activity. Contact your administrator.",
        httpStatus: 403,
        retryable: false,
      };

      const { client } = await createTestClient();
      const result = await client.callTool({
        name: "executeSQL",
        arguments: { sql: "SELECT 1", explanation: "ping" },
      });

      expect(result.isError).toBe(true);
      const envelope = parseAtlasMcpToolError(getContentText(result.content));
      expect(envelope).not.toBeNull();
      expect(envelope!.code).toBe("billing_blocked");
      expect(envelope!.message).toContain("suspended");
      expect(mockExecuteSQLExecute).not.toHaveBeenCalled();
      // The gate keys on the actor's workspace, not the OTel fallback id.
      expect(mockCheckAgentBillingGate).toHaveBeenCalledWith("org_test");
    });

    it("executeSQL returns billing_blocked with a hint when the trial has expired", async () => {
      billingGateVerdict = {
        allowed: false,
        errorCode: "trial_expired",
        errorMessage: "Your free trial has expired. Upgrade to a paid plan to continue using Atlas.",
        httpStatus: 403,
        retryable: false,
      };

      const { client } = await createTestClient();
      const result = await client.callTool({
        name: "executeSQL",
        arguments: { sql: "SELECT 1", explanation: "ping" },
      });

      const envelope = parseAtlasMcpToolError(getContentText(result.content));
      expect(envelope!.code).toBe("billing_blocked");
      expect(envelope!.message).toContain("trial has expired");
      // Retrying cannot help — the hint must steer the agent to the
      // workspace owner instead of a retry loop.
      expect(envelope!.hint).toBeDefined();
      expect(mockExecuteSQLExecute).not.toHaveBeenCalled();
    });

    it("executeSQL maps an abuse-throttle block to rate_limited with retry_after", async () => {
      billingGateVerdict = {
        allowed: false,
        errorCode: "workspace_throttled",
        errorMessage: "Workspace is temporarily throttled due to high usage. Please retry shortly.",
        httpStatus: 429,
        retryable: true,
        retryAfterSeconds: 5,
      };

      const { client } = await createTestClient();
      const result = await client.callTool({
        name: "executeSQL",
        arguments: { sql: "SELECT 1", explanation: "ping" },
      });

      const envelope = parseAtlasMcpToolError(getContentText(result.content));
      expect(envelope!.code).toBe("rate_limited");
      expect(envelope!.retry_after).toBe(5);
      expect(mockExecuteSQLExecute).not.toHaveBeenCalled();
    });

    it("executeSQL fails closed as internal_error with request_id when the billing check itself fails (503)", async () => {
      // check_failed is "try again" (infra fault), NOT "upgrade your plan" —
      // it must not surface as billing_blocked.
      billingGateVerdict = {
        allowed: false,
        errorCode: "workspace_check_failed",
        errorMessage: "Unable to verify workspace status. Please try again.",
        httpStatus: 503,
        retryable: true,
      };

      const { client } = await createTestClient();
      const result = await client.callTool({
        name: "executeSQL",
        arguments: { sql: "SELECT 1", explanation: "ping" },
      });

      expect(result.isError).toBe(true);
      const envelope = parseAtlasMcpToolError(getContentText(result.content));
      expect(envelope!.code).toBe("internal_error");
      expect(envelope!.request_id).toMatch(/^mcp-executeSQL-/);
      expect(mockExecuteSQLExecute).not.toHaveBeenCalled();
    });

    it("executeSQL fails closed as internal_error when the gate itself throws", async () => {
      mockCheckAgentBillingGate.mockRejectedValueOnce(new Error("gate exploded"));

      const { client } = await createTestClient();
      const result = await client.callTool({
        name: "executeSQL",
        arguments: { sql: "SELECT 1", explanation: "ping" },
      });

      expect(result.isError).toBe(true);
      const envelope = parseAtlasMcpToolError(getContentText(result.content));
      expect(envelope!.code).toBe("internal_error");
      expect(mockExecuteSQLExecute).not.toHaveBeenCalled();
    });

    it("executeSQL proceeds when the gate allows (allowed arm)", async () => {
      const { client } = await createTestClient();
      const result = await client.callTool({
        name: "executeSQL",
        arguments: { sql: "SELECT count(*) FROM users", explanation: "Count users" },
      });

      expect(result.isError).toBeFalsy();
      expect(mockCheckAgentBillingGate).toHaveBeenCalledTimes(1);
      expect(mockCheckAgentBillingGate).toHaveBeenCalledWith("org_test");
      expect(mockExecuteSQLExecute).toHaveBeenCalledTimes(1);
    });

    it("explore is not billing-gated — semantic-metadata reads stay available", async () => {
      // Decision pinned: the gate guards the datasource-query perimeter
      // (executeSQL / runMetric). Metadata reads (explore, listEntities,
      // describeEntity, searchGlossary) are not blocked. See #3437.
      const { client } = await createTestClient();
      await client.callTool({ name: "explore", arguments: { command: "ls" } });
      expect(mockCheckAgentBillingGate).not.toHaveBeenCalled();
    });
  });

});
