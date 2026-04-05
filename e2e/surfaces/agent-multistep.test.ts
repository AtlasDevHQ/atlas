/**
 * E2E: Agent multi-step tests.
 *
 * Tests the /api/v1/query route's request validation, response
 * serialization, and action URL enrichment using mocked agent results.
 * The executeAgentQuery function is mocked — these tests verify the
 * route handler correctly:
 *
 * 1. Passes questions to executeAgentQuery
 * 2. Serializes structured results (steps, sql, data) to JSON
 * 3. Enriches pending actions with approve/deny URLs
 * 4. Validates request bodies (empty, missing, invalid JSON)
 *
 * Note: Actual agent behavior (explore-then-SQL ordering, semantic
 * layer consultation) is NOT tested here — the agent is fully mocked.
 *
 * Uses in-process Hono app.fetch() with a mocked executeAgentQuery
 * that returns structured multi-step results.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
  type Mock,
} from "bun:test";
import { createConnectionMock } from "../../packages/api/src/__mocks__/connection";

// ---------------------------------------------------------------------------
// Mocks — must be before app import
// ---------------------------------------------------------------------------

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: mock(() => []),
  resetStartupCache: mock(() => {}),
}));

mock.module("@atlas/api/lib/db/connection", () => {
  const mockDBConn = {
    query: async () => ({ columns: ["?column?"], rows: [{ "?column?": 1 }] }),
    close: async () => {},
  };
  return createConnectionMock({
    getDB: () => mockDBConn,
    connections: {
      get: () => mockDBConn,
      getDefault: () => mockDBConn,
      list: () => [],
      describe: () => [],
    },
    resolveDatasourceUrl: () => "postgresql://test:test@localhost/test",
    rewriteClickHouseUrl: (url: string) => url,
    parseSnowflakeURL: () => ({}),
  });
});

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => false,
  getInternalDB: () => { throw new Error("No internal DB"); },
  internalQuery: async () => [],
  internalExecute: () => {},
  closeInternalDB: async () => {},
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  migrateInternalDB: async () => {},
  upsertSuggestion: mock(() => Promise.resolve("created")),
  getSuggestionsByTables: mock(() => Promise.resolve([])),
  getPopularSuggestions: mock(() => Promise.resolve([])),
  incrementSuggestionClick: mock(),
  deleteSuggestion: mock(() => Promise.resolve(false)),
  getAuditLogQueries: mock(() => Promise.resolve([])),
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["test_orders"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
  registerPluginEntities: mock(() => {}),
  _resetPluginEntities: mock(() => {}),
}));

mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
  explore: { type: "function" },
  invalidateExploreBackend: mock(() => {}),
  markNsjailFailed: mock(() => {}),
  markSidecarFailed: mock(() => {}),
}));

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(() =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      text: Promise.resolve("answer"),
    }),
  ),
  buildSystemParam: mock(() => ({})),
  applyCacheControl: mock(() => {}),
}));

mock.module("@atlas/api/lib/tools/actions", () => ({
  createJiraTicket: {
    name: "createJiraTicket", description: "Mock", tool: { type: "function" },
    actionType: "jira:create", reversible: true, defaultApproval: "manual",
    requiredCredentials: ["JIRA_BASE_URL"],
  },
  sendEmailReport: {
    name: "sendEmailReport", description: "Mock", tool: { type: "function" },
    actionType: "email:send", reversible: false, defaultApproval: "admin-only",
    requiredCredentials: ["RESEND_API_KEY"],
  },
}));

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mock(() => Promise.resolve(null)),
  addMessage: mock(() => {}),
  getConversation: mock(() => Promise.resolve(null)),
  generateTitle: mock((q: string) => q.slice(0, 80)),
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  starConversation: mock(() => Promise.resolve(null)),
  deleteConversation: mock(() => Promise.resolve(false)),
  shareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  unshareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  getSharedConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  updateNotebookState: mock(() => Promise.resolve({ ok: true })),
  forkConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
}));

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => null,
  configFromEnv: () => ({}),
  loadConfig: async () => null,
  initializeConfig: async () => {},
  validateAndResolve: () => ({}),
  defineConfig: (c: unknown) => c,
  _resetConfig: () => {},
  validateToolConfig: async () => {},
  applyDatasources: async () => {},
}));

mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async () => {},
  dispatchMutableHook: async (_name: string, payload: unknown) => payload,
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "none",
  resetAuthModeCache: () => {},
  getAuthModeSource: () => null,
}));

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mock(() =>
    Promise.resolve({
      authenticated: true as const,
      mode: "none",
      user: { id: "test-user", role: "analyst" },
    }),
  ),
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  rateLimitCleanupTick: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
  resetRateLimits: mock(() => {}),
}));

// ---------------------------------------------------------------------------
// Mock executeAgentQuery — the core of multi-step testing
// ---------------------------------------------------------------------------

const mockExecuteAgentQuery: Mock<
  (question: string, requestId?: string, options?: unknown) => Promise<{
    answer: string;
    sql: string[];
    data: { columns: string[]; rows: Record<string, unknown>[] }[];
    steps: number;
    usage: { totalTokens: number };
    pendingActions?: { id: string; type: string; target: string; summary: string }[];
  }>
> = mock(() =>
  Promise.resolve({
    answer: "Default answer",
    sql: [],
    data: [],
    steps: 1,
    usage: { totalTokens: 100 },
  }),
);

mock.module("@atlas/api/lib/agent-query", () => ({
  executeAgentQuery: mockExecuteAgentQuery,
}));

// ---------------------------------------------------------------------------
// Import app after all mocks
// ---------------------------------------------------------------------------

const { app } = await import("../../packages/api/src/api/index");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function queryRequest(question: string) {
  return app.fetch(
    new Request("http://localhost/api/v1/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockExecuteAgentQuery.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Agent multi-step — explore + SQL", () => {
  it("returns structured result from multi-step explore + SQL sequence", async () => {
    // Simulate an agent that explores the semantic layer (step 1-2),
    // writes SQL (step 3), and returns interpreted results
    mockExecuteAgentQuery.mockResolvedValueOnce({
      answer: "There are 5 orders in the system. 3 are completed (60%), 1 is pending, and 1 is cancelled.",
      sql: [
        "SELECT status, COUNT(*) as count FROM test_orders GROUP BY status ORDER BY count DESC",
      ],
      data: [
        {
          columns: ["status", "count"],
          rows: [
            { status: "completed", count: 3 },
            { status: "pending", count: 1 },
            { status: "cancelled", count: 1 },
          ],
        },
      ],
      steps: 4,
      usage: { totalTokens: 2500 },
    });

    const res = await queryRequest("How many orders by status?");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answer: string;
      sql: string[];
      data: { columns: string[]; rows: Record<string, unknown>[] }[];
      steps: number;
      usage: { totalTokens: number };
    };

    // Answer should contain the agent's interpretation
    expect(body.answer).toContain("5 orders");
    expect(body.answer).toContain("completed");

    // SQL should be present
    expect(body.sql).toHaveLength(1);
    expect(body.sql[0]).toContain("SELECT");
    expect(body.sql[0]).toContain("test_orders");

    // Data should contain the query results
    expect(body.data).toHaveLength(1);
    expect(body.data[0].columns).toContain("status");
    expect(body.data[0].columns).toContain("count");
    expect(body.data[0].rows).toHaveLength(3);

    // Steps reflect the multi-step nature
    expect(body.steps).toBe(4);

    // Token usage is tracked
    expect(body.usage.totalTokens).toBeGreaterThan(0);
  });

  it("handles multiple SQL queries in a single session", async () => {
    // Agent runs two SQL queries: one for revenue, one for order count
    mockExecuteAgentQuery.mockResolvedValueOnce({
      answer: "Total revenue is $895.49 across 5 orders, giving an average of $179.10 per order.",
      sql: [
        "SELECT SUM(amount) as total_revenue FROM test_orders",
        "SELECT COUNT(*) as order_count, AVG(amount) as avg_amount FROM test_orders",
      ],
      data: [
        {
          columns: ["total_revenue"],
          rows: [{ total_revenue: 895.49 }],
        },
        {
          columns: ["order_count", "avg_amount"],
          rows: [{ order_count: 5, avg_amount: 179.098 }],
        },
      ],
      steps: 5,
      usage: { totalTokens: 3200 },
    });

    const res = await queryRequest("What is the total revenue and average order value?");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sql: string[];
      data: { columns: string[]; rows: Record<string, unknown>[] }[];
      steps: number;
    };

    // Two SQL queries executed
    expect(body.sql).toHaveLength(2);
    expect(body.sql[0]).toContain("SUM(amount)");
    expect(body.sql[1]).toContain("AVG(amount)");

    // Two data results
    expect(body.data).toHaveLength(2);
    expect(body.data[0].rows[0].total_revenue).toBe(895.49);
    expect(body.data[1].rows[0].order_count).toBe(5);
  });

  it("handles explore-only responses (no SQL needed)", async () => {
    // Some questions can be answered from the semantic layer alone
    mockExecuteAgentQuery.mockResolvedValueOnce({
      answer: "The test_orders table has 5 columns: id (integer primary key), customer_name (text), amount (numeric), status (text), and created_at (date).",
      sql: [],
      data: [],
      steps: 2,
      usage: { totalTokens: 800 },
    });

    const res = await queryRequest("What columns does the orders table have?");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answer: string;
      sql: string[];
      data: unknown[];
      steps: number;
    };

    // Answer derived from semantic layer exploration
    expect(body.answer).toContain("customer_name");
    expect(body.answer).toContain("amount");

    // No SQL was needed
    expect(body.sql).toHaveLength(0);
    expect(body.data).toHaveLength(0);

    // Still took multiple steps (explore)
    expect(body.steps).toBe(2);
  });

  it("passes the question to executeAgentQuery correctly", async () => {
    mockExecuteAgentQuery.mockResolvedValueOnce({
      answer: "Answer",
      sql: [],
      data: [],
      steps: 1,
      usage: { totalTokens: 100 },
    });

    const question = "How many completed orders were placed in March 2025?";
    await queryRequest(question);

    // Verify executeAgentQuery was called with the exact question
    expect(mockExecuteAgentQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockExecuteAgentQuery.mock.calls[0];
    expect(callArgs[0]).toBe(question);
  });
});

describe("E2E: Agent multi-step — response with pending actions", () => {
  it("includes pending actions in the response when present", async () => {
    mockExecuteAgentQuery.mockResolvedValueOnce({
      answer: "I found a data anomaly. Would you like me to create a JIRA ticket?",
      sql: ["SELECT * FROM test_orders WHERE amount < 0"],
      data: [{ columns: ["id"], rows: [] }],
      steps: 3,
      usage: { totalTokens: 1800 },
      pendingActions: [
        {
          id: "act-123",
          type: "jira:create",
          target: "TEST",
          summary: "Data anomaly: negative order amounts detected",
        },
      ],
    });

    const res = await queryRequest("Are there any data anomalies?");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answer: string;
      pendingActions?: {
        id: string;
        type: string;
        target: string;
        summary: string;
        approveUrl: string;
        denyUrl: string;
      }[];
    };

    expect(body.pendingActions).toBeDefined();
    expect(body.pendingActions).toHaveLength(1);
    expect(body.pendingActions![0].id).toBe("act-123");
    expect(body.pendingActions![0].type).toBe("jira:create");
    expect(body.pendingActions![0].approveUrl).toContain("/api/v1/actions/act-123/approve");
    expect(body.pendingActions![0].denyUrl).toContain("/api/v1/actions/act-123/deny");
  });
});

describe("E2E: Agent multi-step — request validation", () => {
  it("rejects empty question", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/v1/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "" }),
      }),
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_error");
  });

  it("rejects missing question field", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/v1/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_error");
  });

  it("rejects invalid JSON body", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/v1/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json{{{",
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("rejects whitespace-only question", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/v1/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "   " }),
      }),
    );

    expect(res.status).toBe(422);
  });
});
