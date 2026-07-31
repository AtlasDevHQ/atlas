import { describe, expect, it, mock, beforeEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { getRequestContext } from "@atlas/api/lib/logger";
import { parseAtlasMcpToolError } from "@useatlas/types/mcp";
import { registerTools } from "../tools.js";
import { executeSqlOutputSchema } from "../structured-output.js";

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

void mock.module("@atlas/api/lib/tools/explore", () => ({
  explore: {
    description: "Explore the semantic layer",
    execute: mockExploreExecute,
  },
}));

void mock.module("@atlas/api/lib/tools/sql", () => ({
  executeSQL: {
    description: "Execute SQL",
    execute: mockExecuteSQLExecute,
  },
}));

// --- searchBrain (#4773) ---
// The MCP edge maps the tool's `{ error, reason }` onto a typed envelope, and
// `reader_unresolved` MUST arrive as `forbidden` rather than as "the brain knows
// nothing". Mock all value exports of the module so the reason vocabulary comes
// from the real source — a test that retyped the strings would pin nothing.
const { BRAIN_TOOL_REASONS: REAL_BRAIN_TOOL_REASONS } = await import(
  "@atlas/api/lib/tools/search-brain"
);
const mockSearchBrainExecute = mock<(...args: unknown[]) => Promise<unknown>>(async () => ({
  results: [],
  neighbors: [],
  stores: {
    fact: { queried: true, matched: 0, truncated: false },
    "raw-episode": { queried: true, matched: 0, truncated: false },
    document: { queried: true, matched: 0, truncated: false },
  },
  tensionsTruncated: false,
}));
void mock.module("@atlas/api/lib/tools/search-brain", () => ({
  BRAIN_TOOL_REASONS: REAL_BRAIN_TOOL_REASONS,
  SEARCH_BRAIN_DESCRIPTION: "Search the company brain",
  normalizeSearchInput: (input: Record<string, unknown>) => input,
  searchBrain: {
    description: "Search the company brain",
    execute: mockSearchBrainExecute,
  },
}));

// --- Action-policy gate mock (gate 1, #4095) ---
// executeSQL now declares actionCategory "raw_sql", so the dispatch gate
// consults the per-workspace policy. Default all-allowed (these tests have no
// real `mcp_action_policy` table); a test flips `blockedCategories` to exercise
// the raw_sql kill-switch. Mock ALL runtime exports so a sibling test loading
// the real module doesn't inherit a partial mock (CLAUDE.md).
let blockedCategories = new Set<string>();
void mock.module("@atlas/api/lib/mcp/action-policy", () => ({
  loadMcpActionPolicy: async () => ({ isBlocked: (c: string) => blockedCategories.has(c) }),
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

void mock.module("@atlas/api/lib/billing/agent-gate", () => ({
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
    blockedCategories = new Set();
    mockCheckAgentBillingGate.mockClear();
    mockSearchBrainExecute.mockClear();
  });

  it("lists explore + executeSQL + searchBrain + the four typed semantic tools (#2020, #4773)", async () => {
    const { client } = await createTestClient();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "describeEntity",
      "executeSQL",
      "explore",
      "listEntities",
      "runMetric",
      // #4773 — ADDITIVE. `searchKnowledge` was never on this surface, so the
      // rename removes no MCP tool name; the stability contract's
      // frozen-tool-name rule is untouched.
      "searchBrain",
      "searchGlossary",
    ]);
  });

  it("declares read-only annotations on every native tool (#3497)", async () => {
    const { client } = await createTestClient();
    const { tools } = await client.listTools();
    const annotationsByName = new Map(
      tools.map((t) => [t.name, t.annotations]),
    );

    // All six native tools are read-only: explore + the semantic-layer
    // tools read YAML, executeSQL / runMetric are SELECT-only (validated).
    // A client must NOT prompt for confirmation on any of them.
    for (const name of [
      "explore",
      "executeSQL",
      "listEntities",
      "describeEntity",
      "searchGlossary",
      "runMetric",
    ]) {
      expect(annotationsByName.get(name)?.readOnlyHint).toBe(true);
    }

    // Semantic-layer tools operate on a closed, local domain (the semantic
    // directory) → openWorldHint false.
    for (const name of [
      "explore",
      "listEntities",
      "describeEntity",
      "searchGlossary",
    ]) {
      expect(annotationsByName.get(name)?.openWorldHint).toBe(false);
    }

    // Datasource-query tools reach an external database → openWorldHint true.
    for (const name of ["executeSQL", "runMetric"]) {
      expect(annotationsByName.get(name)?.openWorldHint).toBe(true);
    }
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

  it("executeSQL is blocked (forbidden, pipeline never runs) when the workspace disables raw_sql (#4095)", async () => {
    // The MCP half of the raw_sql kill-switch: executeSQL declares
    // actionCategory "raw_sql", so a workspace that blocks the category must
    // deny the tool at the dispatch gate BEFORE the SQL pipeline runs. Without
    // this, dropping `actionCategory: "raw_sql"` from the tool registration
    // would ship green while silently disabling the MCP enforcement surface.
    blockedCategories = new Set(["raw_sql"]);
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT count(*) FROM users", explanation: "Count users" },
    });

    expect(result.isError).toBe(true);
    const envelope = JSON.parse(getContentText(result.content));
    expect(envelope.code).toBe("forbidden");
    expect(envelope.message).toContain("raw_sql");
    // The kill-switch short-circuits ahead of the SQL pipeline.
    expect(mockExecuteSQLExecute).not.toHaveBeenCalled();
  });

  it("executeSQL returns structuredContent conforming to the declared outputSchema (#3498)", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT count(*) FROM users", explanation: "Count users" },
    });

    // Structured output present and schema-valid.
    expect(result.structuredContent).toBeDefined();
    const validated = executeSqlOutputSchema.parse(result.structuredContent);
    expect(validated.row_count).toBe(1);
    expect(validated.columns).toEqual(["count"]);
    expect(validated.rows).toEqual([{ count: 42 }]);

    // The text block is retained and mirrors the structured payload (#3498
    // requires backward-compat).
    expect(JSON.parse(getContentText(result.content))).toEqual(result.structuredContent);

    // The SDK advertises the outputSchema on the tool definition.
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "executeSQL")?.outputSchema).toBeDefined();
  });

  it("emits progress notifications when a progressToken is supplied (#3500)", async () => {
    const { client } = await createTestClient();
    const progresses: number[] = [];
    await client.callTool(
      { name: "executeSQL", arguments: { sql: "SELECT 1", explanation: "x" } },
      undefined,
      { onprogress: (p) => progresses.push(p.progress) },
    );
    // Start (0) + completion (>0), monotonically increasing.
    expect(progresses.length).toBeGreaterThanOrEqual(2);
    expect(progresses[0]).toBe(0);
    expect(progresses.at(-1)!).toBeGreaterThan(progresses[0]);
  });

  it("aborts the dispatch when the client cancels (#3500)", async () => {
    const { client } = await createTestClient();
    // A query that never resolves on its own — only cancellation ends it.
    mockExecuteSQLExecute.mockImplementationOnce(() => new Promise<never>(() => {}));

    const ac = new AbortController();
    const pending = client.callTool(
      { name: "executeSQL", arguments: { sql: "SELECT pg_sleep(60)", explanation: "slow" } },
      undefined,
      { signal: ac.signal },
    );
    // Let the request reach the server, then cancel.
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();

    await expect(pending).rejects.toThrow();
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

  it("executeSQL does NOT pass abortSignal to the execute call (#3575 — dead arg removed)", async () => {
    // #3575 AC (chosen: remove dead arg). `executeSQL.execute` only
    // destructures { sql, explanation, connectionId, scope } — `abortSignal`
    // was a dead arg that implied driver-level cancellation without delivering
    // it. The fix removes it from the call site; statement-timeout
    // (`ATLAS_QUERY_TIMEOUT`) is the sole documented cancellation mechanism.
    // This test pins that the first positional argument (the params object)
    // does NOT carry `abortSignal`, so the code doesn't mislead future readers
    // into thinking the signal is threaded through.
    const { client } = await createTestClient();
    await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT 1", explanation: "probe" },
    });

    const calls = mockExecuteSQLExecute.mock.calls;
    const params = calls[calls.length - 1]![0] as Record<string, unknown>;
    expect("abortSignal" in params).toBe(false);
  });

  it("executeSQL approval-required branch survives a malformed internal payload without throwing (#3584c)", async () => {
    // #3584c AC: the approval-branch structuredContent is validated/narrowed
    // via executeSqlOutputSchema.safeParse before assignment so an unexpected
    // internal field type (e.g. non-string approval_request_id from an older
    // gateway version) doesn't cause an SDK output-schema validation throw that
    // would break the dispatch and lose the approval_request_id entirely.
    mockExecuteSQLExecute.mockResolvedValueOnce({
      success: false,
      approval_required: true,
      // Non-string approval_request_id — a malformed internal payload.
      approval_request_id: 12345 as unknown as string,
      matched_rules: [{ id: "pii" }], // objects instead of strings
      message: "approval needed",
    });

    const { client } = await createTestClient();
    // Must not throw — the safeParse fallback strips the non-string field.
    const result = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT * FROM customers", explanation: "PII check" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(getContentText(result.content));
    // The approval_required flag must always be present (it's valid as bool).
    expect(parsed.approval_required).toBe(true);
    // approval_request_id was a non-string — the safeParse fallback strips it
    // from structuredContent (the string validation fails on a number), so it
    // should be absent or the message field carries the relevant context.
    // The key contract: the dispatch did NOT throw, it returned a result.
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


  // --- searchBrain dispatch (#4773) ---

  describe("searchBrain", () => {
    it("advertises the tool prose the api package owns, not a local copy (#4933)", async () => {
      // The link that makes #4933's api-side fix reach an MCP client at all:
      // `registerTools` must keep deriving this description from
      // `searchBrain.description` (wrapped by `withErrorContract`) rather than
      // growing a hand-written literal here. The retraction labels are pinned
      // on the constant in the api package
      // (`lib/tools/__tests__/search-brain-tool.test.ts`); nothing there would
      // notice this file re-declaring the prose, and every retraction
      // assertion in this suite would still be green.
      //
      // The stub text comes from the module mock at the top of this file, so
      // this asserts the WIRING, not the prose — which is the only half that
      // can be checked here without duplicating a 148-word string.
      //
      // Exact-match on the pre-contract paragraph, not `toContain`: the stub
      // ("Search the company brain") is a PREFIX of the real constant, so a
      // hand-written literal copied from `descriptions.ts` would satisfy a
      // substring check and `withErrorContract` would still append its section
      // — i.e. both assertions would go green on the exact decoupling this
      // test exists to catch.
      const { client } = await createTestClient();
      const { tools } = await client.listTools();
      const description = tools.find((t) => t.name === "searchBrain")?.description;
      expect(description?.split("\n\n")[0]).toBe("Search the company brain");
      expect(description).toContain("Error contract:");
    });

    it("the advertised `asOf` argument does not promise retracted facts are unreachable (#4933)", async () => {
      // Unlike the tool prose above, the whole input schema is re-declared in
      // `src/tools.ts` rather than imported — `query` has already drifted from
      // its api-side twin — so `asOf` is the argument where that drift is
      // correctness-bearing and a fix in `lib/tools/descriptions.ts`
      // structurally cannot reach it. It shipped saying "retracted never",
      // full stop. #4913 kept a retracted rival in `tensions` precisely so it
      // stays distinguishable, so the absolute was false of the response and
      // true only of `results`; a model reading it reports a settled
      // retraction as a live contradiction.
      //
      // Asserted through `listTools()` rather than against the source string
      // because what an external client's model actually reads is the
      // REGISTERED schema.
      const { client } = await createTestClient();
      const { tools } = await client.listTools();
      // Narrowed, not asserted: the MCP SDK types `properties` as
      // `Record<string, object>`, so a cast here would re-introduce on this
      // side exactly the blind widening the api-side twin was rewritten to
      // avoid.
      const asOf = tools.find((t) => t.name === "searchBrain")?.inputSchema.properties?.asOf;
      const description =
        asOf && "description" in asOf && typeof asOf.description === "string"
          ? asOf.description
          : undefined;
      expect(
        description,
        "searchBrain's registered inputSchema has no `asOf` description — the registration in src/tools.ts changed shape, so the retraction pins below would pass vacuously",
      ).toBeTruthy();
      // Both arms, so neither half can be dropped: the carve-out has to be
      // stated (`tensions`) AND the field that labels it has to be nameable
      // (`invalidatedAt`), or the guidance is unactionable.
      expect(description).toContain("tensions");
      expect(description).toContain("invalidatedAt");
      // The never-arm the carve-out could plausibly displace: a retracted fact
      // is still never a RESULT, which is what makes `asOf` safe to trust.
      expect(description).toMatch(/never as a RESULT/);
      // And the arm the three pins above survive: a rewrite that keeps every
      // token and re-adds the absolute in a neighbouring sentence.
      //
      // A deliberate second copy of `unqualifiedRetractionSentences` from the
      // api suite, not a forced one — `@atlas/api` does export a `./testing/*`
      // entrypoint these four lines could live behind. The rule is OWNED
      // there, where it is stated in full; a tightening there has to be
      // mirrored here by hand, which is the cost of not adding a cross-package
      // test-utility export to a scoped fix. The `\n(?=[-*] )` bullet arm is
      // omitted because this string is prose, not markdown.
      const unqualified = (description ?? "")
        .split(/(?<=\.)\s+/)
        .filter((s) => /retract/i.test(s))
        .filter((s) =>
          /retract\w*\s+(?:facts?\s+)?(?:is |are )?never|never\s+(?:returned|surfaces?|appears?|as a RESULT)|retract\w*[^.]{0,40}\b(?:excluded|omitted)\b/i.test(
            s,
          ),
        )
        .filter((s) => !/(only|except|still appears?|the one place)[^.]{0,80}tensions/i.test(s));
      expect(
        unqualified,
        "a sentence promising retracted facts never come back must name the `tensions` carve-out in that same sentence",
      ).toEqual([]);
    });

    it("returns the fused payload as JSON on success", async () => {
      const { client } = await createTestClient();
      const result = await client.callTool({ name: "searchBrain", arguments: { query: "x" } });
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(getContentText(result.content));
      expect(payload.stores.fact.queried).toBe(true);
      expect(payload.results).toEqual([]);
    });

    it("maps an identity refusal to `forbidden`, NOT to an empty page", async () => {
      // The load-bearing mapping. An empty success here would tell the agent
      // the company brain knows nothing about the subject, and it would answer
      // from its own priors — the failure a trust-labeled surface exists to
      // prevent. Branching is on `reason`, so rewording the prose cannot
      // silently demote this to `internal_error`.
      mockSearchBrainExecute.mockResolvedValueOnce({
        error: "Company-brain search was refused: ...",
        reason: REAL_BRAIN_TOOL_REASONS.readerUnresolved,
      });
      const { client } = await createTestClient();
      const result = await client.callTool({ name: "searchBrain", arguments: { query: "x" } });
      expect(result.isError).toBe(true);
      const envelope = parseAtlasMcpToolError(getContentText(result.content));
      expect(envelope?.code).toBe("forbidden");
      // Correlatable: the refusal is documented as an upstream defect, and the
      // request id is the only handle an operator has on the matching log line.
      expect(envelope?.request_id).toBeTruthy();
    });

    it("maps a rejected asOf to `validation_failed` — fix the argument, don't retry (#4916)", async () => {
      // The caller's own timestamp refused. `internal_error` here would tell
      // the agent to retry the identical call; `validation_failed` tells it
      // the argument is the problem, which the message then names.
      mockSearchBrainExecute.mockResolvedValueOnce({
        error: 'asOf "yesterday-ish" is not an ISO-8601 instant.',
        reason: REAL_BRAIN_TOOL_REASONS.invalidAsOf,
      });
      const { client } = await createTestClient();
      const result = await client.callTool({
        name: "searchBrain",
        arguments: { query: "x", asOf: "yesterday-ish" },
      });
      expect(result.isError).toBe(true);
      const envelope = parseAtlasMcpToolError(getContentText(result.content));
      expect(envelope?.code).toBe("validation_failed");
      // The MCP input schema is a strip-unknown z.object: if the `asOf` entry
      // were dropped from the registration, the argument would be silently
      // stripped and the tool would answer as-of-now — the exact fall-through
      // #4916 forbids, invisible to every other assertion in this block.
      expect(mockSearchBrainExecute).toHaveBeenCalledWith(
        expect.objectContaining({ asOf: "yesterday-ish" }),
        expect.anything(),
      );
    });

    it("forwards asOf and passes the historical page's echo through untouched (#4916)", async () => {
      mockSearchBrainExecute.mockResolvedValueOnce({
        results: [],
        neighbors: [],
        stores: {
          fact: { queried: true, matched: 0, truncated: false },
          "raw-episode": { queried: false },
          document: { queried: false },
        },
        tensionsTruncated: false,
        asOf: "2026-07-01T00:00:00.000Z",
      });
      const { client } = await createTestClient();
      const result = await client.callTool({
        name: "searchBrain",
        arguments: { query: "x", asOf: "2026-07-01T00:00:00Z" },
      });
      expect(result.isError).toBeFalsy();
      expect(mockSearchBrainExecute).toHaveBeenCalledWith(
        expect.objectContaining({ asOf: "2026-07-01T00:00:00Z" }),
        expect.anything(),
      );
      // The echo is the page's only "this is historical" marker; the MCP edge
      // must not strip it on the way to the agent.
      expect(JSON.parse(getContentText(result.content)).asOf).toBe("2026-07-01T00:00:00.000Z");
    });

    it("maps every other degraded reason to `internal_error`", async () => {
      mockSearchBrainExecute.mockResolvedValueOnce({
        error: "Company-brain search failed.",
        reason: REAL_BRAIN_TOOL_REASONS.searchFailed,
      });
      const { client } = await createTestClient();
      const result = await client.callTool({ name: "searchBrain", arguments: { query: "x" } });
      expect(result.isError).toBe(true);
      const envelope = parseAtlasMcpToolError(getContentText(result.content));
      expect(envelope?.code).toBe("internal_error");
      expect(envelope?.request_id).toBeTruthy();
    });

    it("passes the shaped `unavailable` empty response through rather than swallowing it", async () => {
      // The unbound trusted-transport actor's path. It is not an error — the
      // tool genuinely has no workspace to search — but the label has to survive
      // to the agent, or the answer is indistinguishable from an empty brain.
      mockSearchBrainExecute.mockResolvedValueOnce({
        results: [],
        neighbors: [],
        stores: {
          fact: { queried: false },
          "raw-episode": { queried: false },
          document: { queried: false },
        },
        tensionsTruncated: false,
        unavailable: REAL_BRAIN_TOOL_REASONS.noWorkspace,
      });
      const { client } = await createTestClient();
      const result = await client.callTool({ name: "searchBrain", arguments: { query: "x" } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(getContentText(result.content)).unavailable).toBe("no_workspace");
    });
  });
});
