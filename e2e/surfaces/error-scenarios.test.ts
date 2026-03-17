/**
 * E2E: Error scenario tests.
 *
 * Validates that the API returns correct structured error responses for:
 * - Invalid SQL (rejected by validation pipeline)
 * - Unreachable LLM provider
 * - Rate limiting enforcement
 * - Provider authentication failures
 * - Provider timeouts
 * - Missing datasource configuration
 *
 * Uses in-process Hono app.fetch() with mocked dependencies that simulate
 * various failure modes.
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

const mockValidateEnvironment: Mock<() => Promise<{ code: string; message: string }[]>> =
  mock(() => Promise.resolve([]));

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mockValidateEnvironment,
  getStartupWarnings: mock(() => []),
  resetStartupCache: mock(() => {}),
}));

const mockResolveDatasourceUrl: Mock<() => string | undefined> = mock(() =>
  "postgresql://test:test@localhost/test",
);

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
    resolveDatasourceUrl: mockResolveDatasourceUrl,
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
  detectAuthMode: () => "api-key",
  resetAuthModeCache: () => {},
  getAuthModeSource: () => null,
}));

// ---------------------------------------------------------------------------
// Auth + rate limit mocks — configurable per test
// ---------------------------------------------------------------------------

const testUser = { id: "test-user", mode: "api-key" as const, label: "Test", role: "analyst" as const };

const mockAuthenticateRequest: Mock<(req: Request) => Promise<
  | { authenticated: true; mode: string; user: typeof testUser }
  | { authenticated: false; mode: string; status: 401 | 403 | 500; error: string }
>> = mock(() =>
  Promise.resolve({
    authenticated: true as const,
    mode: "api-key",
    user: testUser,
  }),
);

const mockCheckRateLimit: Mock<(key: string) => {
  allowed: boolean;
  retryAfterMs?: number;
}> = mock(() => ({ allowed: true }));

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mockCheckRateLimit,
  getClientIP: mock(() => "127.0.0.1"),
  _stopCleanup: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
  resetRateLimits: mock(() => {}),
}));

// ---------------------------------------------------------------------------
// Agent query mock — configurable for error simulation
// ---------------------------------------------------------------------------

const mockExecuteAgentQuery: Mock<
  (question: string, requestId?: string, options?: unknown) => Promise<{
    answer: string;
    sql: string[];
    data: { columns: string[]; rows: Record<string, unknown>[] }[];
    steps: number;
    usage: { totalTokens: number };
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

function queryRequest(question: string, headers?: Record<string, string>) {
  return app.fetch(
    new Request("http://localhost/api/v1/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
        ...headers,
      },
      body: JSON.stringify({ question }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockExecuteAgentQuery.mockClear();
  mockAuthenticateRequest.mockClear();
  mockCheckRateLimit.mockClear();
  mockValidateEnvironment.mockClear();
  mockResolveDatasourceUrl.mockClear();

  // Restore defaults
  mockExecuteAgentQuery.mockResolvedValue({
    answer: "Default answer",
    sql: [],
    data: [],
    steps: 1,
    usage: { totalTokens: 100 },
  });
  mockAuthenticateRequest.mockResolvedValue({
    authenticated: true as const,
    mode: "api-key",
    user: testUser,
  });
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockValidateEnvironment.mockResolvedValue([]);
  mockResolveDatasourceUrl.mockReturnValue("postgresql://test:test@localhost/test");
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Error scenarios — provider failures", () => {
  it("returns 503 with provider_unreachable when provider cannot be reached", async () => {
    mockExecuteAgentQuery.mockRejectedValueOnce(
      new Error("fetch failed: ECONNREFUSED"),
    );

    const res = await queryRequest("How many orders?");

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("provider_unreachable");
    expect(body.message).toContain("Could not reach");
  });

  it("returns 504 with provider_timeout when provider times out", async () => {
    mockExecuteAgentQuery.mockRejectedValueOnce(
      new Error("Request timed out after 30000ms"),
    );

    const res = await queryRequest("Complex query that takes too long");

    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("provider_timeout");
    expect(body.message).toContain("timed out");
  });

  it("returns 504 on AbortError (timeout variant)", async () => {
    const abortError = new Error("AbortError: The operation was aborted");
    abortError.name = "AbortError";
    mockExecuteAgentQuery.mockRejectedValueOnce(abortError);

    const res = await queryRequest("Another timeout scenario");

    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("provider_timeout");
  });

  it("returns 500 with internal_error for unexpected errors", async () => {
    mockExecuteAgentQuery.mockRejectedValueOnce(
      new Error("Something completely unexpected"),
    );

    const res = await queryRequest("Trigger unexpected error");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("internal_error");
    // Error message should include a reference ID but not the raw error
    expect(body.message).toContain("unexpected error");
    expect(body.message).not.toContain("Something completely unexpected");
  });
});

describe("E2E: Error scenarios — rate limiting", () => {
  it("returns 429 with Retry-After when rate limit is exceeded", async () => {
    mockCheckRateLimit.mockReturnValueOnce({
      allowed: false,
      retryAfterMs: 30000,
    });

    const res = await queryRequest("Rate limited request");

    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      error: string;
      message: string;
      retryAfterSeconds: number;
    };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("rate limit response includes retry timing", async () => {
    mockCheckRateLimit.mockReturnValueOnce({
      allowed: false,
      retryAfterMs: 60000,
    });

    const res = await queryRequest("Another rate limited request");

    expect(res.status).toBe(429);
    const body = (await res.json()) as { retryAfterSeconds: number };
    expect(body.retryAfterSeconds).toBe(60);
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});

describe("E2E: Error scenarios — authentication failures", () => {
  it("returns 401 when authentication fails", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({
      authenticated: false as const,
      mode: "api-key",
      status: 401 as const,
      error: "Invalid API key",
    });

    const res = await queryRequest("Unauthenticated request");

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("auth_error");
    expect(body.message).toContain("Invalid API key");
  });

  it("returns 500 when auth system throws", async () => {
    mockAuthenticateRequest.mockRejectedValueOnce(
      new Error("Auth service unavailable"),
    );

    const res = await queryRequest("Auth broken request");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("auth_error");
  });
});

describe("E2E: Error scenarios — configuration errors", () => {
  it("returns 400 when environment validation fails", async () => {
    mockValidateEnvironment.mockResolvedValueOnce([
      { code: "MISSING_API_KEY", message: "ANTHROPIC_API_KEY is not set" },
    ]);

    const res = await queryRequest("Config error request");

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      message: string;
      diagnostics: { code: string; message: string }[];
    };
    expect(body.error).toBe("configuration_error");
    expect(body.diagnostics).toHaveLength(1);
    expect(body.diagnostics[0].code).toBe("MISSING_API_KEY");
  });

  it("returns 400 when no datasource is configured", async () => {
    mockResolveDatasourceUrl.mockReturnValueOnce(undefined);

    const res = await queryRequest("No datasource request");

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("no_datasource");
    expect(body.message).toContain("ATLAS_DATASOURCE_URL");
  });
});

describe("E2E: Error scenarios — CORS and method validation", () => {
  it("rejects non-POST requests to /api/v1/query", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/v1/query", {
        method: "GET",
        headers: { Authorization: "Bearer test-key" },
      }),
    );

    // Hono returns 404 for unmatched methods on a route (no GET handler)
    expect(res.status).toBe(404);
  });

  it("handles OPTIONS preflight request", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/v1/query", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,authorization",
        },
      }),
    );

    // CORS middleware should respond to OPTIONS
    expect(res.status).toBeLessThan(400);
  });
});

describe("E2E: Error scenarios — error message safety", () => {
  it("does not leak raw error details in 500 responses", async () => {
    const sensitiveError = new Error(
      "connection to server at \"db.internal.prod\" (10.0.1.42), port 5432 failed: " +
      "FATAL: password authentication failed for user \"admin_secret\"",
    );
    mockExecuteAgentQuery.mockRejectedValueOnce(sensitiveError);

    const res = await queryRequest("Trigger sensitive error");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };

    // Should NOT contain raw error details
    expect(body.message).not.toContain("db.internal.prod");
    expect(body.message).not.toContain("10.0.1.42");
    expect(body.message).not.toContain("admin_secret");

    // Should contain a sanitized reference
    expect(body.error).toBe("internal_error");
  });

  it("does not leak connection strings in error responses", async () => {
    mockExecuteAgentQuery.mockRejectedValueOnce(
      new Error("fetch failed: ENOTFOUND host.secret-provider.internal"),
    );

    const res = await queryRequest("Provider not found");

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };

    // The structured error should use generic messaging
    expect(body.error).toBe("provider_unreachable");
    expect(body.message).not.toContain("secret-provider.internal");
  });
});
