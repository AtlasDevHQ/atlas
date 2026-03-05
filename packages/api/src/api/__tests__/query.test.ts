/**
 * Unit tests for the POST /api/v1/query and GET /api/v1/openapi.json routes.
 *
 * Mocks auth, rate-limiting, startup diagnostics, and the agent to
 * isolate the route wiring logic. Tests the Hono app.fetch() directly.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  type Mock,
} from "bun:test";
import { APICallError, LoadAPIKeyError, NoSuchModelError } from "ai";
import { GatewayModelNotFoundError } from "@ai-sdk/gateway";
import type { AuthResult } from "@atlas/api/lib/auth/types";

// --- Mocks ---

const mockAuthenticateRequest: Mock<
  (req: Request) => Promise<AuthResult>
> = mock(() =>
  Promise.resolve({
    authenticated: true as const,
    mode: "none" as const,
    user: undefined,
  }),
);

const mockCheckRateLimit: Mock<
  (key: string) => { allowed: boolean; retryAfterMs?: number }
> = mock(() => ({ allowed: true }));

const mockGetClientIP: Mock<(req: Request) => string | null> = mock(
  () => null,
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mockCheckRateLimit,
  getClientIP: mockGetClientIP,
}));

const mockValidateEnvironment: Mock<
  () => Promise<{ message: string }[]>
> = mock(() => Promise.resolve([]));

// Helper to build a mock step with toolResults using AI SDK shape (input/output)
function mockStep(
  toolResults: {
    toolName: string;
    input: unknown;
    output: unknown;
  }[],
) {
  return {
    toolResults: toolResults.map((tr) => ({
      type: "tool-result" as const,
      toolCallId: crypto.randomUUID(),
      toolName: tr.toolName,
      input: tr.input,
      output: tr.output,
    })),
  };
}

function makeAgentResult(overrides?: {
  text?: string;
  steps?: ReturnType<typeof mockStep>[];
  inputTokens?: number;
  outputTokens?: number;
}) {
  return {
    toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
    text: Promise.resolve(overrides?.text ?? "The answer is 42."),
    steps: Promise.resolve(
      overrides?.steps ?? [
        mockStep([
          {
            toolName: "executeSQL",
            input: { sql: "SELECT COUNT(*) FROM users" },
            output: { success: true, columns: ["count"], rows: [{ count: 42 }] },
          },
        ]),
      ],
    ),
    totalUsage: Promise.resolve({
      inputTokens: overrides?.inputTokens ?? 100,
      outputTokens: overrides?.outputTokens ?? 50,
    }),
  };
}

const mockRunAgent = mock(() => Promise.resolve(makeAgentResult()));

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mockRunAgent,
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(),
  _resetWhitelists: () => {},
}));

mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "none",
  resetAuthModeCache: () => {},
}));

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mockValidateEnvironment,
  getStartupWarnings: () => [],
}));

const mockCreateConversationQuery = mock((): Promise<{ id: string } | null> =>
  Promise.resolve({ id: "conv-query-123" }),
);
const mockAddMessageQuery = mock(() => {});
const mockGetConversationQuery = mock((): Promise<{ ok: boolean; reason?: string; data?: unknown }> => Promise.resolve({ ok: false, reason: "not_found" }));
const mockGenerateTitleQuery = mock((q: string) => q.slice(0, 80));

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mockCreateConversationQuery,
  addMessage: mockAddMessageQuery,
  getConversation: mockGetConversationQuery,
  generateTitle: mockGenerateTitleQuery,
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  deleteConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  starConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
}));

// Import after mocks are registered
const { app } = await import("../index");

// --- Helpers ---

function makeQueryRequest(body?: unknown): Request {
  return new Request("http://localhost/api/v1/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? { question: "How many users?" }),
  });
}

// --- POST /api/v1/query ---

describe("POST /api/v1/query", () => {
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;
  const origDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.ATLAS_DATASOURCE_URL =
      "postgresql://test:test@localhost:5432/test";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    mockAuthenticateRequest.mockReset();
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true as const,
      mode: "none" as const,
      user: undefined,
    });
    mockCheckRateLimit.mockReset();
    mockCheckRateLimit.mockReturnValue({ allowed: true });
    mockGetClientIP.mockReset();
    mockGetClientIP.mockReturnValue(null);
    mockValidateEnvironment.mockReset();
    mockValidateEnvironment.mockResolvedValue([]);
    mockRunAgent.mockReset();
    mockRunAgent.mockResolvedValue(makeAgentResult());
    mockCreateConversationQuery.mockReset();
    mockCreateConversationQuery.mockResolvedValue({ id: "conv-query-123" });
    mockAddMessageQuery.mockReset();
    mockGetConversationQuery.mockReset();
    mockGetConversationQuery.mockResolvedValue({ ok: false, reason: "not_found" });
  });

  afterEach(() => {
    if (origDatasource !== undefined)
      process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
    if (origDatabaseUrl !== undefined)
      process.env.DATABASE_URL = origDatabaseUrl;
    else delete process.env.DATABASE_URL;
  });

  it("returns structured JSON on success", async () => {
    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.answer).toBe("The answer is 42.");
    expect(body.sql).toEqual(["SELECT COUNT(*) FROM users"]);
    expect(body.data).toEqual([{ columns: ["count"], rows: [{ count: 42 }] }]);
    expect(body.steps).toBe(1);
    expect(body.usage).toEqual({ totalTokens: 150 });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({
      authenticated: false as const,
      mode: "simple-key" as const,
      status: 401 as const,
      error: "API key required",
    });

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(401);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("auth_error");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns 500 when auth throws", async () => {
    mockAuthenticateRequest.mockRejectedValueOnce(new Error("DB crashed"));

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(500);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("auth_error");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when rate limited", async () => {
    mockCheckRateLimit.mockReturnValueOnce({
      allowed: false,
      retryAfterMs: 30000,
    });

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterSeconds).toBe(30);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns retryAfterSeconds=60 when retryAfterMs is undefined", async () => {
    mockCheckRateLimit.mockReturnValueOnce({ allowed: false });
    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.retryAfterSeconds).toBe(60);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns 400 when ATLAS_DATASOURCE_URL is not set", async () => {
    delete process.env.ATLAS_DATASOURCE_URL;

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(400);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("no_datasource");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns 400 when validateEnvironment reports errors", async () => {
    mockValidateEnvironment.mockResolvedValueOnce([
      { message: "Missing API key" },
    ]);

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(400);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("configuration_error");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await app.fetch(
      new Request("http://localhost/api/v1/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(response.status).toBe(400);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_request");
  });

  it("returns 422 for missing question field", async () => {
    const response = await app.fetch(makeQueryRequest({}));
    expect(response.status).toBe(422);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("validation_error");
    expect(body.details).toBeDefined();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns 422 for empty question", async () => {
    const response = await app.fetch(makeQueryRequest({ question: "" }));
    expect(response.status).toBe(422);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("validation_error");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("passes question as user message to runAgent", async () => {
    await app.fetch(makeQueryRequest({ question: "Top 10 users by revenue" }));
    expect(mockRunAgent).toHaveBeenCalledTimes(1);

    const calls = mockRunAgent.mock.calls as unknown as [
      [{ messages: { parts: { text: string }[] }[] }],
    ];
    expect(calls[0][0].messages[0].parts[0].text).toBe(
      "Top 10 users by revenue",
    );
  });

  it("uses result.text as answer", async () => {
    mockRunAgent.mockResolvedValueOnce(
      makeAgentResult({
        text: "Here is the raw answer.",
        steps: [
          mockStep([
            {
              toolName: "executeSQL",
              input: { sql: "SELECT 1" },
              output: { success: true, columns: ["?column?"], rows: [{ "?column?": 1 }] },
            },
          ]),
        ],
        inputTokens: 50,
        outputTokens: 25,
      }),
    );

    const response = await app.fetch(makeQueryRequest());
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.answer).toBe("Here is the raw answer.");
  });

  it("handles agent error with 500", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("Something broke"));

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(500);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("internal_error");
  });

  it("handles timeout error with 504", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("Request timed out"));

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(504);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("provider_timeout");
  });

  it("handles connection error with 503", async () => {
    mockRunAgent.mockRejectedValueOnce(
      new Error("fetch failed: ECONNREFUSED"),
    );

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(503);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("provider_unreachable");
  });

  it("skips failed executeSQL results in data array", async () => {
    mockRunAgent.mockResolvedValueOnce(
      makeAgentResult({
        text: "Query failed.",
        steps: [
          mockStep([
            {
              toolName: "executeSQL",
              input: { sql: "SELECT bad_col FROM users" },
              output: {
                success: false,
                error: "column bad_col does not exist",
              },
            },
          ]),
        ],
        inputTokens: 50,
        outputTokens: 25,
      }),
    );

    const response = await app.fetch(makeQueryRequest());
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.sql).toEqual(["SELECT bad_col FROM users"]);
    expect(body.data).toEqual([]); // Failed queries don't produce data
  });

  // --- AI SDK error type tests ---

  it("maps GatewayModelNotFoundError to 400 provider_model_not_found", async () => {
    mockRunAgent.mockRejectedValueOnce(
      new GatewayModelNotFoundError({
        message: "Model not found",
        modelId: "bad/model",
      }),
    );

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(400);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("provider_model_not_found");
  });

  it("maps NoSuchModelError to 400 provider_model_not_found", async () => {
    mockRunAgent.mockRejectedValueOnce(
      new NoSuchModelError({
        modelId: "nonexistent-model",
        modelType: "languageModel",
      }),
    );

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(400);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("provider_model_not_found");
  });

  it("maps LoadAPIKeyError to 503 provider_auth_error", async () => {
    mockRunAgent.mockRejectedValueOnce(
      new LoadAPIKeyError({
        message: "ANTHROPIC_API_KEY environment variable is not set.",
      }),
    );

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(503);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("provider_auth_error");
  });

  it("maps APICallError 401 to 503 provider_auth_error", async () => {
    mockRunAgent.mockRejectedValueOnce(
      new APICallError({
        message: "Unauthorized",
        url: "https://api.example.com/v1/chat",
        requestBodyValues: {},
        statusCode: 401,
      }),
    );

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(503);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("provider_auth_error");
  });

  it("maps APICallError 429 to 503 provider_rate_limit", async () => {
    mockRunAgent.mockRejectedValueOnce(
      new APICallError({
        message: "Rate limit exceeded",
        url: "https://api.example.com/v1/chat",
        requestBodyValues: {},
        statusCode: 429,
      }),
    );

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(503);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("provider_rate_limit");
  });

  it("maps APICallError 408 to 504 provider_timeout", async () => {
    mockRunAgent.mockRejectedValueOnce(
      new APICallError({
        message: "Request timeout",
        url: "https://api.example.com/v1/chat",
        requestBodyValues: {},
        statusCode: 408,
      }),
    );

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(504);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("provider_timeout");
  });

  it("maps APICallError 500 to 502 provider_error", async () => {
    mockRunAgent.mockRejectedValueOnce(
      new APICallError({
        message: "Internal server error",
        url: "https://api.example.com/v1/chat",
        requestBodyValues: {},
        statusCode: 500,
      }),
    );

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(502);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("provider_error");
  });

  // --- Edge case tests ---

  it("collects SQL and data from multiple executeSQL steps", async () => {
    mockRunAgent.mockResolvedValueOnce(
      makeAgentResult({
        text: "Two queries ran.",
        steps: [
          mockStep([
            {
              toolName: "executeSQL",
              input: { sql: "SELECT COUNT(*) FROM users" },
              output: { success: true, columns: ["count"], rows: [{ count: 42 }] },
            },
          ]),
          mockStep([
            {
              toolName: "executeSQL",
              input: { sql: "SELECT name FROM users LIMIT 5" },
              output: {
                success: true,
                columns: ["name"],
                rows: [{ name: "Alice" }, { name: "Bob" }],
              },
            },
          ]),
        ],
        inputTokens: 80,
        outputTokens: 40,
      }),
    );

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.sql).toEqual([
      "SELECT COUNT(*) FROM users",
      "SELECT name FROM users LIMIT 5",
    ]);
    expect(body.data).toEqual([
      { columns: ["count"], rows: [{ count: 42 }] },
      { columns: ["name"], rows: [{ name: "Alice" }, { name: "Bob" }] },
    ]);
    expect(body.steps).toBe(2);
  });

  it("returns empty sql/data and steps=0 for empty steps", async () => {
    mockRunAgent.mockResolvedValueOnce(
      makeAgentResult({
        text: "I could not help with that.",
        steps: [],
        inputTokens: 30,
        outputTokens: 20,
      }),
    );

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.sql).toEqual([]);
    expect(body.data).toEqual([]);
    expect(body.steps).toBe(0);
    expect(body.answer).toBe("I could not help with that.");
  });

  it("maps AbortError to 504 provider_timeout", async () => {
    const abortError = new Error("AbortError");
    abortError.name = "AbortError";
    mockRunAgent.mockRejectedValueOnce(abortError);

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(504);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("provider_timeout");
  });

  it("uses provided conversationId when ownership verified", async () => {
    const convId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    mockGetConversationQuery.mockResolvedValueOnce({
      ok: true,
      data: { id: convId, userId: null, title: "Test", messages: [] },
    });

    const response = await app.fetch(
      makeQueryRequest({ question: "How many users?", conversationId: convId }),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.conversationId).toBe(convId);
    expect(mockCreateConversationQuery).not.toHaveBeenCalled();
  });

  it("creates new conversation when ownership check fails for provided conversationId", async () => {
    const convId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    // getConversation returns not_found — ownership check fails, falls back to new conversation
    mockGetConversationQuery.mockResolvedValueOnce({ ok: false, reason: "not_found" });

    const response = await app.fetch(
      makeQueryRequest({ question: "How many users?", conversationId: convId }),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    // Falls back to creating a new conversation
    expect(body.conversationId).toBe("conv-query-123");
    expect(mockCreateConversationQuery).toHaveBeenCalledTimes(1);
  });

  it("returns 200 without conversationId when persistence throws", async () => {
    mockCreateConversationQuery.mockRejectedValueOnce(new Error("DB down"));
    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.answer).toBeDefined();
    expect(body.conversationId).toBeUndefined();
  });

  it("includes conversationId in response when internal DB is available", async () => {
    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.conversationId).toBe("conv-query-123");
  });

  it("omits conversationId when internal DB is unavailable", async () => {
    delete process.env.DATABASE_URL;

    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.conversationId).toBeUndefined();
  });

  it("includes pendingActions with approve/deny URLs when actions are pending", async () => {
    mockRunAgent.mockResolvedValueOnce(
      makeAgentResult({
        text: "I need your approval to send a notification.",
        steps: [
          mockStep([
            {
              toolName: "sendNotification",
              input: { actionType: "notification", target: "#revenue" },
              output: {
                status: "pending_approval",
                actionId: "act-001",
                summary: "Send notification to #revenue",
                target: "#revenue",
              },
            },
          ]),
        ],
        inputTokens: 80,
        outputTokens: 40,
      }),
    );

    const response = await app.fetch(makeQueryRequest({ question: "send a notification to #revenue" }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.pendingActions).toBeDefined();
    const actions = body.pendingActions as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe("act-001");
    expect(actions[0].summary).toBe("Send notification to #revenue");
    expect(actions[0].approveUrl).toContain("/api/v1/actions/act-001/approve");
    expect(actions[0].denyUrl).toContain("/api/v1/actions/act-001/deny");
  });

  // --- deriveBaseUrl URL derivation tests ---

  describe("pending action URL derivation", () => {
    const origPublicUrl = process.env.ATLAS_PUBLIC_URL;
    const origTrustProxy = process.env.ATLAS_TRUST_PROXY;

    function setupPendingActionAgent() {
      mockRunAgent.mockResolvedValueOnce(
        makeAgentResult({
          text: "I need approval.",
          steps: [
            mockStep([
              {
                toolName: "sendNotification",
                input: { actionType: "notification", target: "#general" },
                output: {
                  status: "pending_approval",
                  actionId: "act-url-test",
                  summary: "Send notification",
                  target: "#general",
                },
              },
            ]),
          ],
          inputTokens: 50,
          outputTokens: 30,
        }),
      );
    }

    afterEach(() => {
      if (origPublicUrl !== undefined) process.env.ATLAS_PUBLIC_URL = origPublicUrl;
      else delete process.env.ATLAS_PUBLIC_URL;
      if (origTrustProxy !== undefined) process.env.ATLAS_TRUST_PROXY = origTrustProxy;
      else delete process.env.ATLAS_TRUST_PROXY;
    });

    it("uses ATLAS_PUBLIC_URL when set", async () => {
      process.env.ATLAS_PUBLIC_URL = "https://api.myapp.com";
      setupPendingActionAgent();

      const response = await app.fetch(makeQueryRequest({ question: "notify" }));
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      const actions = body.pendingActions as Array<Record<string, unknown>>;
      expect(actions).toHaveLength(1);
      expect(actions[0].approveUrl).toBe("https://api.myapp.com/api/v1/actions/act-url-test/approve");
      expect(actions[0].denyUrl).toBe("https://api.myapp.com/api/v1/actions/act-url-test/deny");
    });

    it("strips trailing slash from ATLAS_PUBLIC_URL to avoid double slashes", async () => {
      process.env.ATLAS_PUBLIC_URL = "https://api.myapp.com/";
      setupPendingActionAgent();

      const response = await app.fetch(makeQueryRequest({ question: "notify" }));
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      const actions = body.pendingActions as Array<Record<string, unknown>>;
      expect(actions).toHaveLength(1);
      // No double slash between base URL and /api/v1/...
      expect(actions[0].approveUrl).toBe("https://api.myapp.com/api/v1/actions/act-url-test/approve");
      expect(actions[0].denyUrl).toBe("https://api.myapp.com/api/v1/actions/act-url-test/deny");
    });

    it("derives URL from request when ATLAS_PUBLIC_URL is unset", async () => {
      delete process.env.ATLAS_PUBLIC_URL;
      delete process.env.ATLAS_TRUST_PROXY;
      setupPendingActionAgent();

      const response = await app.fetch(makeQueryRequest({ question: "notify" }));
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      const actions = body.pendingActions as Array<Record<string, unknown>>;
      expect(actions).toHaveLength(1);
      // Falls back to request URL — makeQueryRequest uses http://localhost
      expect(actions[0].approveUrl).toBe("http://localhost/api/v1/actions/act-url-test/approve");
      expect(actions[0].denyUrl).toBe("http://localhost/api/v1/actions/act-url-test/deny");
    });

    it("uses forwarded headers when ATLAS_TRUST_PROXY is true", async () => {
      delete process.env.ATLAS_PUBLIC_URL;
      process.env.ATLAS_TRUST_PROXY = "true";
      setupPendingActionAgent();

      const response = await app.fetch(
        new Request("http://localhost/api/v1/query", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "public.example.com",
          },
          body: JSON.stringify({ question: "notify" }),
        }),
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      const actions = body.pendingActions as Array<Record<string, unknown>>;
      expect(actions).toHaveLength(1);
      expect(actions[0].approveUrl).toBe("https://public.example.com/api/v1/actions/act-url-test/approve");
      expect(actions[0].denyUrl).toBe("https://public.example.com/api/v1/actions/act-url-test/deny");
    });
  });

  it("omits pendingActions when there are no pending actions", async () => {
    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.pendingActions).toBeUndefined();
  });

  it("includes pendingActions alongside SQL data", async () => {
    mockRunAgent.mockResolvedValueOnce(
      makeAgentResult({
        text: "Found 42 users. I need approval to send a report.",
        steps: [
          mockStep([
            {
              toolName: "executeSQL",
              input: { sql: "SELECT COUNT(*) FROM users" },
              output: { success: true, columns: ["count"], rows: [{ count: 42 }] },
            },
          ]),
          mockStep([
            {
              toolName: "sendReport",
              input: { actionType: "send_report", target: "email:team@company.com" },
              output: {
                status: "pending_approval",
                actionId: "act-002",
                summary: "Email report to team@company.com",
                target: "email:team@company.com",
              },
            },
          ]),
        ],
        inputTokens: 100,
        outputTokens: 60,
      }),
    );

    const response = await app.fetch(makeQueryRequest({ question: "count users and email report" }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    // SQL data is present
    expect(body.sql).toEqual(["SELECT COUNT(*) FROM users"]);
    expect(body.data).toEqual([{ columns: ["count"], rows: [{ count: 42 }] }]);
    // Pending actions are also present
    const actions = body.pendingActions as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe("act-002");
  });
});

// --- GET /api/v1/openapi.json ---

describe("GET /api/v1/openapi.json", () => {
  it("returns a valid OpenAPI 3.1 spec", async () => {
    const response = await app.fetch(
      new Request("http://localhost/api/v1/openapi.json"),
    );
    expect(response.status).toBe(200);

    const spec = (await response.json()) as Record<string, unknown>;
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info).toBeDefined();
    expect(spec.paths).toBeDefined();
  });

  it("includes the /api/v1/query path", async () => {
    const response = await app.fetch(
      new Request("http://localhost/api/v1/openapi.json"),
    );
    const spec = (await response.json()) as {
      paths: Record<string, unknown>;
    };
    expect(spec.paths["/api/v1/query"]).toBeDefined();
  });

  it("includes security schemes", async () => {
    const response = await app.fetch(
      new Request("http://localhost/api/v1/openapi.json"),
    );
    const spec = (await response.json()) as {
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
  });
});
