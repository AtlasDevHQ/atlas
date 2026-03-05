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
    text: Promise.resolve("answer"),
  }),
);

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mockRunAgent,
}));

// Mock modules needed by health and auth routes (loaded via ../index)
mock.module("@atlas/api/lib/semantic", () => ({
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

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mockCreateConversation,
  addMessage: mockAddMessage,
  getConversation: mockGetConversationChat,
  generateTitle: mockGenerateTitle,
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  deleteConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  starConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
}));

// Import after mocks are registered
const { app } = await import("../index");

describe("POST /api/chat", () => {
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
      text: Promise.resolve("answer"),
    });
    mockCreateConversation.mockReset();
    mockCreateConversation.mockResolvedValue({ id: "conv-test-123" });
    mockAddMessage.mockReset();
    mockGetConversationChat.mockReset();
    mockGetConversationChat.mockResolvedValue({ ok: false, reason: "not_found" });
    delete process.env.ATLAS_ACTIONS_ENABLED;
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
    return new Request("http://localhost/api/chat", {
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
    const text = await response.text();
    expect(text).toBe("stream");
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

  it("returns 422 for invalid conversationId format", async () => {
    const response = await app.fetch(
      makeRequest({
        messages: [
          { id: "1", role: "user", parts: [{ type: "text", text: "hello" }] },
        ],
        conversationId: "not-a-uuid",
      }),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("validation_error");
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
});
