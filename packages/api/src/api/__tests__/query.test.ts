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
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
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
  persistAssistantSteps: mock(() => {}),
  // F-77 step-cap helpers — chat.ts imports both via @atlas/api/lib/conversations.
  reserveConversationBudget: mock(() => Promise.resolve({ status: 'ok' as const, totalStepsBefore: 0 })),
  settleConversationSteps: mock(() => {}),
  getConversation: mockGetConversationQuery,
  generateTitle: mockGenerateTitleQuery,
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  deleteConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  starConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  shareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  unshareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  getShareStatus: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  cleanupExpiredShares: mock(() => Promise.resolve(0)),
  getSharedConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  updateNotebookState: mock(() => Promise.resolve({ ok: true })),
  forkConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  convertToNotebook: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  deleteBranch: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  renameBranch: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  resolveGroupForConnection: mock(() => Promise.resolve(null)),
  verifyGroupBelongsToOrg: mock(() => Promise.resolve("ok")),
  updateConversationRoutingMode: mock(() => Promise.resolve({ ok: true as const })),
  updateConversationRestExcluded: mock(() => Promise.resolve({ ok: true as const })),
  updateConversationRestFocus: mock(() => Promise.resolve({ ok: true as const })),
  updateConversationGroupReach: mock(() => Promise.resolve({ ok: true as const })),
  resolveRoutingMode: mock((m: "auto" | "pin" | "all" | null | undefined = null) => m ?? "pin"),
}));

// #3419/#3420 — the billing seam lives inside `executeAgentQuery`; the
// route's job is mapping `BillingBlockedError` to the HTTP envelope.
// Mock the gate module so tests control the verdict; the stub error
// class mirrors the real one (the route narrows via `instanceof`).
class BillingBlockedErrorStub extends Error {
  override readonly name = "BillingBlockedError";
  readonly errorCode: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly usage: { currentUsage: number; limit: number; metric: string } | undefined;
  constructor(block: {
    errorCode: string;
    errorMessage: string;
    httpStatus: number;
    retryable: boolean;
    retryAfterSeconds?: number;
    usage?: { currentUsage: number; limit: number; metric: string };
  }) {
    super(block.errorMessage);
    this.errorCode = block.errorCode;
    this.httpStatus = block.httpStatus;
    this.retryable = block.retryable;
    this.retryAfterSeconds = block.retryAfterSeconds;
    this.usage = block.usage;
  }
}

type BillingGateVerdict =
  | { allowed: true; warning?: { code: "plan_limit_warning"; message: string; metrics: unknown[] } }
  | {
      allowed: false;
      errorCode: string;
      errorMessage: string;
      httpStatus: number;
      retryable: boolean;
      retryAfterSeconds?: number;
      usage?: { currentUsage: number; limit: number; metric: string };
    };
let billingGateVerdict: BillingGateVerdict = { allowed: true };
const mockCheckAgentBillingGate = mock(async (_orgId: string | undefined) => billingGateVerdict);

mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: mockCheckAgentBillingGate,
  BillingBlockedError: BillingBlockedErrorStub,
}));

// ADR-0018 / #3651 — the claim-gate seam lives inside `executeAgentQuery`; the
// route's job is mapping the typed claim errors to HTTP envelopes (403/503).
// Mock the gate so tests control the verdict; the stub error classes mirror the
// real ones (the route + executeAgentQuery both narrow via `instanceof`, and
// both resolve the class from this same mocked module).
class ClaimRequiredErrorStub extends Error {
  override readonly name = "ClaimRequiredError";
  readonly errorCode = "claim_required" as const;
  readonly httpStatus = 403 as const;
  readonly claimUrl: string;
  constructor(claimUrl: string) {
    super(`Claim required: ${claimUrl}`);
    this.claimUrl = claimUrl;
  }
}
class ClaimCheckFailedErrorStub extends Error {
  override readonly name = "ClaimCheckFailedError";
  readonly errorCode = "claim_check_failed" as const;
  readonly httpStatus = 503 as const;
  readonly retryable = true as const;
  constructor() {
    super("Unable to verify your workspace's claim status. Please try again.");
  }
}
type ClaimGateVerdict =
  | { allowed: true }
  | { allowed: false; reason: "claim_required"; claimUrl: string }
  | { allowed: false; reason: "check_failed" };
let claimGateVerdict: ClaimGateVerdict = { allowed: true };
const mockCheckClaimGate = mock(async (_orgId?: string) => claimGateVerdict);

mock.module("@atlas/api/lib/billing/claim-gate", () => ({
  checkClaimGate: mockCheckClaimGate,
  ClaimRequiredError: ClaimRequiredErrorStub,
  ClaimCheckFailedError: ClaimCheckFailedErrorStub,
  buildClaimUrl: (email?: string) =>
    `https://app.useatlas.dev/signup${email ? `?email=${email}` : ""}`,
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
    billingGateVerdict = { allowed: true };
    mockCheckAgentBillingGate.mockClear();
    claimGateVerdict = { allowed: true };
    mockCheckClaimGate.mockClear();
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

  // ADR-0018 / #3651 — route-level mapping of the claim-gate's typed errors.
  // The block-vs-allow matrix is tested at the gate (billing/claim-gate.test.ts)
  // and seam (agent-query-claim-gate.test.ts) levels; these pin the HTTP
  // envelope the route emits, which nothing else exercised.
  it("maps a claim-gate block to a 403 claim_required envelope carrying the claim URL", async () => {
    claimGateVerdict = {
      allowed: false,
      reason: "claim_required",
      claimUrl: "https://app.useatlas.dev/signup?email=owner@acme.com",
    };
    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("claim_required");
    expect(body.claimUrl).toBe(
      "https://app.useatlas.dev/signup?email=owner@acme.com",
    );
    expect(body.retryable).toBe(false);
    expect(body.requestId).toBeTruthy();
    // A withheld query must not spend Atlas tokens.
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("maps an unverifiable claim status to a retryable 503 (fails closed, no claim URL, no token spend)", async () => {
    claimGateVerdict = { allowed: false, reason: "check_failed" };
    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("claim_check_failed");
    expect(body.retryable).toBe(true);
    // 503/check_failed is NOT a claim prompt — no claimUrl on this arm.
    expect(body.claimUrl).toBeUndefined();
    expect(body.requestId).toBeTruthy();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  // ── #3419/#3420: billing blocks from the seam map to the HTTP envelope ──

  it("maps a trial_expired billing block to a 403 envelope with requestId", async () => {
    billingGateVerdict = {
      allowed: false,
      errorCode: "trial_expired",
      errorMessage: "Your free trial has expired. Upgrade to a paid plan to continue using Atlas.",
      httpStatus: 403,
      retryable: false,
    };
    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("trial_expired");
    expect(body.message).toContain("trial has expired");
    expect(body.retryable).toBe(false);
    expect(typeof body.requestId).toBe("string");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("maps an abuse-throttle billing block to 429 with a Retry-After header", async () => {
    billingGateVerdict = {
      allowed: false,
      errorCode: "workspace_throttled",
      errorMessage: "Workspace is temporarily throttled due to high usage. Please retry shortly.",
      httpStatus: 429,
      retryable: true,
      retryAfterSeconds: 5,
    };
    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("5");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("workspace_throttled");
    expect(body.retryable).toBe(true);
    expect(body.retryAfterSeconds).toBe(5);
  });

  it("maps a hard-cap billing block to 429 with usage details", async () => {
    billingGateVerdict = {
      allowed: false,
      errorCode: "plan_limit_exceeded",
      errorMessage: "You have exceeded your plan's token budget.",
      httpStatus: 429,
      retryable: false,
      usage: { currentUsage: 23, limit: 20, metric: "usd" },
    };
    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(429);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("plan_limit_exceeded");
    expect(body.usage).toEqual({ currentUsage: 23, limit: 20, metric: "usd" });
  });

  it("attaches the approaching-credit planWarning to a successful response without blocking", async () => {
    billingGateVerdict = {
      allowed: true,
      warning: {
        code: "plan_limit_warning",
        message: "You are approaching your included usage credit",
        metrics: [],
      },
    };
    const response = await app.fetch(makeQueryRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect((body.planWarning as Record<string, unknown>).code).toBe("plan_limit_warning");
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
                status: "pending",
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
                  status: "pending",
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
                status: "pending",
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

  it("includes both auto-generated and static paths", async () => {
    const response = await app.fetch(
      new Request("http://localhost/api/v1/openapi.json"),
    );
    const spec = (await response.json()) as {
      paths: Record<string, unknown>;
    };
    // Auto-generated path (from OpenAPIHono createRoute)
    expect(spec.paths["/api/v1/query"]).toBeDefined();
    // Static path (from openapi.ts staticPaths — auth proxy)
    expect(spec.paths["/api/auth/sign-up/email"]).toBeDefined();
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
