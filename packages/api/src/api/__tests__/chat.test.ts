/**
 * Unit tests for the Hono chat route.
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

const mockRunAgent = mock(() =>
  Promise.resolve({
    toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
    toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
    text: Promise.resolve("answer"),
  }),
);

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mockRunAgent,
}));

mock.module("@atlas/api/lib/tools/python-stream", () => ({
  setStreamWriter: () => {},
  clearStreamWriter: () => {},
  getStreamWriter: () => undefined,
}));

// Mock modules needed by health and auth routes (loaded via ../index)
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
  explore: { type: "function" },
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "none",
  resetAuthModeCache: () => {},
}));

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mockValidateEnvironment,
  getStartupWarnings: () => [],
}));

// Mock action tools so buildRegistry({ includeActions: true }) works
// without needing JIRA/email credentials or external services.
mock.module("@atlas/api/lib/tools/actions", () => ({
  createJiraTicket: {
    name: "createJiraTicket",
    description: "### Create JIRA Ticket\nMock",
    tool: { type: "function" },
    actionType: "jira:create",
    reversible: true,
    defaultApproval: "manual",
    requiredCredentials: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
  },
  sendEmailReport: {
    name: "sendEmailReport",
    description: "### Send Email Report\nMock",
    tool: { type: "function" },
    actionType: "email:send",
    reversible: false,
    defaultApproval: "admin-only",
    requiredCredentials: ["RESEND_API_KEY"],
  },
}));

const mockCreateConversation = mock((): Promise<{ id: string } | null> =>
  Promise.resolve({ id: "conv-test-123" }),
);
const mockAddMessage = mock(() => {});
const mockGetConversationChat = mock((): Promise<{ ok: boolean; reason?: string; data?: unknown }> => Promise.resolve({ ok: false, reason: "not_found" }));
const mockGenerateTitle = mock((q: string) => q.slice(0, 80));
type ReservationResult =
  | { status: "ok"; totalStepsBefore: number }
  | { status: "exceeded"; totalSteps: number }
  | { status: "no_db" }
  | { status: "error" };
const mockReserveConversationBudget = mock(
  (): Promise<ReservationResult> => Promise.resolve({ status: "ok", totalStepsBefore: 0 }),
);
const mockSettleConversationSteps = mock(() => {});
const mockPersistAssistantSteps = mock(() => {});

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mockCreateConversation,
  addMessage: mockAddMessage,
  persistAssistantSteps: mockPersistAssistantSteps,
  getConversation: mockGetConversationChat,
  generateTitle: mockGenerateTitle,
  reserveConversationBudget: mockReserveConversationBudget,
  settleConversationSteps: mockSettleConversationSteps,
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
}));

const mockGetPluginTools: Mock<() => unknown> = mock(() => undefined);

mock.module("@atlas/api/lib/plugins/tools", () => ({
  getPluginTools: mockGetPluginTools,
  setPluginTools: () => {},
  getContextFragments: () => [],
  setContextFragments: () => {},
  getDialectHints: () => [],
  setDialectHints: () => {},
}));

// Import after mocks are registered
const { app } = await import("../index");

describe("POST /api/v1/chat", () => {
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;
  const origDatabaseUrl = process.env.DATABASE_URL;
  const origActionsEnabled = process.env.ATLAS_ACTIONS_ENABLED;

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
    mockRunAgent.mockResolvedValue({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
      text: Promise.resolve("answer"),
    });
    mockCreateConversation.mockReset();
    mockCreateConversation.mockResolvedValue({ id: "conv-test-123" });
    mockAddMessage.mockReset();
    mockGetConversationChat.mockReset();
    mockGetConversationChat.mockResolvedValue({ ok: false, reason: "not_found" });
    mockReserveConversationBudget.mockReset();
    mockReserveConversationBudget.mockResolvedValue({ status: "ok", totalStepsBefore: 0 });
    mockSettleConversationSteps.mockReset();
    mockPersistAssistantSteps.mockReset();
    delete process.env.ATLAS_ACTIONS_ENABLED;
    delete process.env.ATLAS_CONVERSATION_STEP_CAP;
    mockGetPluginTools.mockReset();
    mockGetPluginTools.mockReturnValue(undefined);
  });

  afterEach(() => {
    if (origDatasource !== undefined)
      process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
    if (origDatabaseUrl !== undefined)
      process.env.DATABASE_URL = origDatabaseUrl;
    else delete process.env.DATABASE_URL;
    if (origActionsEnabled !== undefined)
      process.env.ATLAS_ACTIONS_ENABLED = origActionsEnabled;
    else delete process.env.ATLAS_ACTIONS_ENABLED;
  });

  function makeRequest(body?: unknown): Request {
    return new Request("http://localhost/api/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        body ?? {
          messages: [
            {
              id: "1",
              role: "user",
              parts: [{ type: "text", text: "hello" }],
            },
          ],
        },
      ),
    });
  }

  it("returns 200 stream on success", async () => {
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    // Response is a UI message SSE stream, not plain text
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });

  it("returns 401 when authenticateRequest returns unauthenticated", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({
      authenticated: false as const,
      mode: "simple-key" as const,
      status: 401 as const,
      error: "API key required",
    });

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(401);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("auth_error");
    expect(body.message).toBe("API key required");

    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns 500 when authenticateRequest throws", async () => {
    mockAuthenticateRequest.mockRejectedValueOnce(new Error("DB crashed"));

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(500);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("auth_error");
    expect(body.message).toBe("Authentication system error");

    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when rate limited", async () => {
    mockCheckRateLimit.mockReturnValueOnce({
      allowed: false,
      retryAfterMs: 30000,
    });

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterSeconds).toBe(30);

    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns retryAfterSeconds=60 when retryAfterMs is undefined", async () => {
    mockCheckRateLimit.mockReturnValueOnce({ allowed: false });
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.retryAfterSeconds).toBe(60);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After for pool exhaustion errors", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("sorry, too many clients already"));
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("5");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("rate_limited");
    expect(body.retryable).toBe(true);
    expect(body.retryAfterSeconds).toBe(5);
    expect(body.message).toContain("pool exhausted");
  });

  it("returns 400 when ATLAS_DATASOURCE_URL is not set", async () => {
    delete process.env.ATLAS_DATASOURCE_URL;

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(400);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("no_datasource");
    expect(body.message).toContain("ATLAS_DATASOURCE_URL");

    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns 400 when validateEnvironment reports errors", async () => {
    mockValidateEnvironment.mockResolvedValueOnce([
      { message: "Missing API key" },
    ]);

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(400);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("configuration_error");

    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns x-conversation-id header when conversation is created", async () => {
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-conversation-id")).toBe("conv-test-123");
  });

  it("returns 404 when conversationId does not belong to user", async () => {
    mockGetConversationChat.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "follow up" }] }],
        conversationId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      }),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });

  it("continues existing conversation and persists user message", async () => {
    const convId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    mockGetConversationChat.mockResolvedValueOnce({
      ok: true,
      data: { id: convId, userId: null, title: "Test", messages: [] },
    });

    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "follow up" }] }],
        conversationId: convId,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-conversation-id")).toBe(convId);
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockAddMessage).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // F-77 — per-conversation aggregate step ceiling
  // ---------------------------------------------------------------------

  describe("F-77 — conversation budget ceiling", () => {
    const convId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

    function makeFollowUp(): Request {
      return makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "follow up" }] }],
        conversationId: convId,
      });
    }

    it("rejects with conversation_budget_exceeded when reservation is over the cap", async () => {
      process.env.ATLAS_CONVERSATION_STEP_CAP = "10";
      mockGetConversationChat.mockResolvedValueOnce({
        ok: true,
        data: { id: convId, userId: null, title: "Test", messages: [] },
      });
      // Atomic reservation rejects — the gate is enforced at the row, not
      // at the application. The pre-check failure must short-circuit before
      // the agent runs.
      mockReserveConversationBudget.mockResolvedValueOnce({
        status: "exceeded",
        totalSteps: 10,
      });

      const response = await app.fetch(makeFollowUp());
      expect(response.status).toBe(429);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("conversation_budget_exceeded");
      expect(body.retryable).toBe(false);
      expect(typeof body.requestId).toBe("string");
      // Agent must not have been invoked.
      expect(mockRunAgent).not.toHaveBeenCalled();
      // Settlement should not run on the rejection path.
      expect(mockSettleConversationSteps).not.toHaveBeenCalled();
    });

    it("allows the request when reservation succeeds and settles after the stream", async () => {
      process.env.ATLAS_CONVERSATION_STEP_CAP = "10";
      process.env.ATLAS_AGENT_MAX_STEPS = "5";
      mockGetConversationChat.mockResolvedValueOnce({
        ok: true,
        data: { id: convId, userId: null, title: "Test", messages: [] },
      });
      mockReserveConversationBudget.mockResolvedValueOnce({
        status: "ok",
        totalStepsBefore: 5,
      });
      // Stream resolves with 3 actual steps so settlement refunds 5 - 3 = 2.
      mockRunAgent.mockResolvedValueOnce({
        toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
        toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
        text: Promise.resolve("answer"),
        steps: Promise.resolve([{}, {}, {}]),
      } as unknown as Awaited<ReturnType<typeof mockRunAgent>>);

      const response = await app.fetch(makeFollowUp());
      expect(response.status).toBe(200);
      // Reservation must be charged with the full agent step budget upfront.
      const reserveCalls = mockReserveConversationBudget.mock.calls as unknown as unknown[][];
      expect(reserveCalls.length).toBe(1);
      expect(reserveCalls[0]).toEqual([convId, 5, 10]);
      // Wait for the fire-and-forget settlement promise chain to flush.
      await Promise.resolve();
      await Promise.resolve();
      const settleCalls = mockSettleConversationSteps.mock.calls as unknown as unknown[][];
      expect(settleCalls.length).toBe(1);
      expect(settleCalls[0]).toEqual([convId, 5, 3]);

      delete process.env.ATLAS_AGENT_MAX_STEPS;
    });

    it("disables the gate when ATLAS_CONVERSATION_STEP_CAP=0", async () => {
      process.env.ATLAS_CONVERSATION_STEP_CAP = "0";
      mockGetConversationChat.mockResolvedValueOnce({
        ok: true,
        data: { id: convId, userId: null, title: "Test", messages: [] },
      });

      const response = await app.fetch(makeFollowUp());
      expect(response.status).toBe(200);
      // Reservation must NOT be attempted when the cap is disabled.
      expect(mockReserveConversationBudget).not.toHaveBeenCalled();
    });

    it("fails open when reservation returns no_db (internal DB unavailable)", async () => {
      process.env.ATLAS_CONVERSATION_STEP_CAP = "10";
      mockGetConversationChat.mockResolvedValueOnce({
        ok: true,
        data: { id: convId, userId: null, title: "Test", messages: [] },
      });
      mockReserveConversationBudget.mockResolvedValueOnce({ status: "no_db" });

      // Fail-open: a transient internal-DB glitch must not 429 the chat surface.
      const response = await app.fetch(makeFollowUp());
      expect(response.status).toBe(200);
      // No reservation was charged → no settlement either.
      expect(mockSettleConversationSteps).not.toHaveBeenCalled();
    });

    it("fails open when reservation returns error (read/write threw)", async () => {
      process.env.ATLAS_CONVERSATION_STEP_CAP = "10";
      mockGetConversationChat.mockResolvedValueOnce({
        ok: true,
        data: { id: convId, userId: null, title: "Test", messages: [] },
      });
      mockReserveConversationBudget.mockResolvedValueOnce({ status: "error" });

      const response = await app.fetch(makeFollowUp());
      expect(response.status).toBe(200);
      expect(mockSettleConversationSteps).not.toHaveBeenCalled();
    });

    it("invalid ATLAS_CONVERSATION_STEP_CAP falls back to default 500", async () => {
      process.env.ATLAS_CONVERSATION_STEP_CAP = "abc";
      mockGetConversationChat.mockResolvedValueOnce({
        ok: true,
        data: { id: convId, userId: null, title: "Test", messages: [] },
      });

      const response = await app.fetch(makeFollowUp());
      expect(response.status).toBe(200);
      // Reservation must have been called with the default cap of 500.
      const reserveCalls = mockReserveConversationBudget.mock.calls as unknown as unknown[][];
      expect(reserveCalls.length).toBe(1);
      expect(reserveCalls[0]?.[2]).toBe(500);
    });
  });

  it("returns 200 without x-conversation-id when createConversation fails", async () => {
    mockCreateConversation.mockResolvedValueOnce(null);
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-conversation-id")).toBeNull();
  });

  it("returns 200 when conversation creation throws", async () => {
    mockCreateConversation.mockRejectedValueOnce(new Error("DB crashed"));
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-conversation-id")).toBeNull();
  });

  it("returns 400 for invalid conversationId format", async () => {
    const response = await app.fetch(
      makeRequest({
        messages: [
          { id: "1", role: "user", parts: [{ type: "text", text: "hello" }] },
        ],
        conversationId: "not-a-uuid",
      }),
    );
    // OpenAPIHono's built-in Zod validation returns 400 by default (no defaultHook override)
    expect(response.status).toBe(422);
  });

  it("passes action tools to runAgent when ATLAS_ACTIONS_ENABLED=true", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    const calls = mockRunAgent.mock.calls as unknown as unknown[][];
    const call = calls[0]![0] as { tools?: unknown };
    expect(call.tools).toBeDefined();
  });

  it("does not pass action tools when ATLAS_ACTIONS_ENABLED is unset", async () => {
    delete process.env.ATLAS_ACTIONS_ENABLED;
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    const calls = mockRunAgent.mock.calls as unknown as unknown[][];
    const call = calls[0]![0] as { tools?: unknown };
    expect(call.tools).toBeUndefined();
  });

  it("does not pass action tools when ATLAS_ACTIONS_ENABLED=false", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "false";
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    const calls = mockRunAgent.mock.calls as unknown as unknown[][];
    const call = calls[0]![0] as { tools?: unknown };
    expect(call.tools).toBeUndefined();
  });

  it("passes warnings to runAgent when buildRegistry throws", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    // Trigger buildRegistry failure: ATLAS_PYTHON_ENABLED=true without
    // ATLAS_SANDBOX_URL causes buildRegistry to throw (fatal misconfiguration).
    process.env.ATLAS_PYTHON_ENABLED = "true";
    delete process.env.ATLAS_SANDBOX_URL;

    try {
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(200);
      expect(mockRunAgent).toHaveBeenCalledTimes(1);
      const calls = mockRunAgent.mock.calls as unknown as unknown[][];
      const call = calls[0]![0] as { warnings?: string[] };
      expect(call.warnings).toBeDefined();
      expect(call.warnings!.length).toBe(1);
      expect(call.warnings![0]).toContain("tool registry failed to build");
    } finally {
      delete process.env.ATLAS_PYTHON_ENABLED;
    }
  });

  it("does not pass warnings when actions build succeeds", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    const calls = mockRunAgent.mock.calls as unknown as unknown[][];
    const call = calls[0]![0] as { warnings?: string[] };
    expect(call.warnings).toBeUndefined();
  });

  it("passes warning to runAgent when plugin tools merge throws", async () => {
    mockGetPluginTools.mockImplementation(() => {
      throw new Error("plugin tool has empty name");
    });

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    const calls = mockRunAgent.mock.calls as unknown as unknown[][];
    const call = calls[0]![0] as { warnings?: string[] };
    expect(call.warnings).toBeDefined();
    expect(call.warnings!.length).toBe(1);
    expect(call.warnings![0]).toContain("Plugin tools failed to load");
    expect(call.warnings![0]).toContain("plugin tool has empty name");
  });

  it("handles non-Error throw from plugin tools gracefully", async () => {
    mockGetPluginTools.mockImplementation(() => {
      throw "string error from plugin";
    });

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    const calls = mockRunAgent.mock.calls as unknown as unknown[][];
    const call = calls[0]![0] as { warnings?: string[] };
    expect(call.warnings).toBeDefined();
    expect(call.warnings!.length).toBe(1);
    expect(call.warnings![0]).toContain("string error from plugin");
  });

  it("accumulates warnings when both action registry and plugin tools fail", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_PYTHON_ENABLED = "true";
    delete process.env.ATLAS_SANDBOX_URL;
    mockGetPluginTools.mockImplementation(() => {
      throw new Error("plugin merge failed");
    });

    try {
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(200);
      expect(mockRunAgent).toHaveBeenCalledTimes(1);
      const calls = mockRunAgent.mock.calls as unknown as unknown[][];
      const call = calls[0]![0] as { warnings?: string[] };
      expect(call.warnings).toBeDefined();
      expect(call.warnings!.length).toBe(2);
      expect(call.warnings![0]).toContain("tool registry failed to build");
      expect(call.warnings![1]).toContain("Plugin tools failed to load");
    } finally {
      delete process.env.ATLAS_PYTHON_ENABLED;
    }
  });
});
