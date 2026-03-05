/**
 * Unit tests for the conversations REST routes.
 *
 * Uses mock.module() pattern from chat.test.ts / query.test.ts.
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
import type { CrudResult, CrudDataResult } from "@atlas/api/lib/conversations";
import type { ConversationWithMessages } from "@atlas/api/lib/conversation-types";

// --- Mocks ---

const mockAuthenticateRequest: Mock<
  (req: Request) => Promise<AuthResult>
> = mock(() =>
  Promise.resolve({
    authenticated: true as const,
    mode: "simple-key" as const,
    user: { id: "u1", label: "test@test.com", mode: "simple-key" as const },
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

const mockListConversations = mock((): Promise<{ conversations: Record<string, unknown>[]; total: number }> =>
  Promise.resolve({ conversations: [], total: 0 }),
);
const mockGetConversation = mock((): Promise<CrudDataResult<ConversationWithMessages>> => Promise.resolve({ ok: false, reason: "not_found" }));
const mockDeleteConversation = mock((): Promise<CrudResult> => Promise.resolve({ ok: false, reason: "not_found" }));
const mockStarConversation = mock((): Promise<CrudResult> => Promise.resolve({ ok: false, reason: "not_found" }));
const mockCreateConversation = mock(() => Promise.resolve(null));
const mockAddMessage = mock(() => {});
const mockGenerateTitle = mock(() => "Test title");

mock.module("@atlas/api/lib/conversations", () => ({
  listConversations: mockListConversations,
  getConversation: mockGetConversation,
  deleteConversation: mockDeleteConversation,
  starConversation: mockStarConversation,
  createConversation: mockCreateConversation,
  addMessage: mockAddMessage,
  generateTitle: mockGenerateTitle,
  // Type exports (no runtime value — needed so mock.module doesn't break re-exports)
}));

// Mock the agent module needed by chat route (imported via ../index)
mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(() =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      text: Promise.resolve("answer"),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
    }),
  ),
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
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: () => [],
}));

// Import after mocks
const { app } = await import("../index");

// Valid UUID for tests — routes now validate UUID format on :id params
const VALID_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

describe("conversations routes", () => {
  const origDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    // Enable hasInternalDB() by setting DATABASE_URL
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    mockAuthenticateRequest.mockReset();
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true as const,
      mode: "simple-key" as const,
      user: { id: "u1", label: "test@test.com", mode: "simple-key" as const },
    });
    mockCheckRateLimit.mockReset();
    mockCheckRateLimit.mockReturnValue({ allowed: true });
    mockGetClientIP.mockReset();
    mockGetClientIP.mockReturnValue(null);
    mockListConversations.mockReset();
    mockListConversations.mockResolvedValue({ conversations: [], total: 0 });
    mockGetConversation.mockReset();
    mockGetConversation.mockResolvedValue({ ok: false, reason: "not_found" });
    mockDeleteConversation.mockReset();
    mockDeleteConversation.mockResolvedValue({ ok: false, reason: "not_found" });
    mockStarConversation.mockReset();
    mockStarConversation.mockResolvedValue({ ok: false, reason: "not_found" });
  });

  afterEach(() => {
    if (origDatabaseUrl !== undefined) process.env.DATABASE_URL = origDatabaseUrl;
    else delete process.env.DATABASE_URL;
  });

  // -----------------------------------------------------------------------
  // GET /api/v1/conversations
  // -----------------------------------------------------------------------

  describe("GET /api/v1/conversations", () => {
    it("returns 200 with conversations list", async () => {
      mockListConversations.mockResolvedValueOnce({
        conversations: [
          { id: "c1", userId: "u1", title: "Test", surface: "web", connectionId: null, createdAt: "2024-01-01", updatedAt: "2024-01-01" },
        ],
        total: 1,
      });

      const response = await app.fetch(
        new Request("http://localhost/api/v1/conversations"),
      );
      expect(response.status).toBe(200);

      const body = await response.json() as Record<string, unknown>;
      expect(body.total).toBe(1);
      expect((body.conversations as unknown[]).length).toBe(1);
    });

    it("returns 404 when no internal DB", async () => {
      delete process.env.DATABASE_URL;

      const response = await app.fetch(
        new Request("http://localhost/api/v1/conversations"),
      );
      expect(response.status).toBe(404);

      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe("not_available");
    });

    it("returns 401 when unauthenticated", async () => {
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: false as const,
        mode: "simple-key" as const,
        status: 401 as const,
        error: "API key required",
      });

      const response = await app.fetch(
        new Request("http://localhost/api/v1/conversations"),
      );
      expect(response.status).toBe(401);
    });

    it("returns 429 when rate limited", async () => {
      mockCheckRateLimit.mockReturnValueOnce({
        allowed: false,
        retryAfterMs: 30000,
      });

      const response = await app.fetch(
        new Request("http://localhost/api/v1/conversations"),
      );
      expect(response.status).toBe(429);
    });

    it("returns 500 when authenticateRequest throws", async () => {
      mockAuthenticateRequest.mockRejectedValueOnce(new Error("DB crashed"));
      const response = await app.fetch(
        new Request("http://localhost/api/v1/conversations"),
      );
      expect(response.status).toBe(500);
      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe("auth_error");
    });

    it("passes userId from auth to listConversations", async () => {
      await app.fetch(
        new Request("http://localhost/api/v1/conversations"),
      );
      expect(mockListConversations).toHaveBeenCalledTimes(1);
      const call = mockListConversations.mock.calls[0] as unknown as [{ userId?: string }];
      expect(call[0].userId).toBe("u1");
    });

    it("passes limit and offset from query params", async () => {
      await app.fetch(
        new Request("http://localhost/api/v1/conversations?limit=5&offset=10"),
      );
      const call = mockListConversations.mock.calls[0] as unknown as [{ limit?: number; offset?: number }];
      expect(call[0].limit).toBe(5);
      expect(call[0].offset).toBe(10);
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/v1/conversations/:id
  // -----------------------------------------------------------------------

  describe("GET /api/v1/conversations/:id", () => {
    it("returns 200 with conversation", async () => {
      mockGetConversation.mockResolvedValueOnce({
        ok: true,
        data: {
          id: VALID_ID,
          userId: "u1",
          title: "Test",
          surface: "web",
          connectionId: null,
          starred: false,
          createdAt: "2024-01-01",
          updatedAt: "2024-01-01",
          messages: [],
        },
      });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}`),
      );
      expect(response.status).toBe(200);

      const body = await response.json() as Record<string, unknown>;
      expect(body.id).toBe(VALID_ID);
    });

    it("returns 404 when not found", async () => {
      mockGetConversation.mockResolvedValueOnce({ ok: false, reason: "not_found" });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}`),
      );
      expect(response.status).toBe(404);

      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe("not_found");
    });

    it("returns 500 on database error", async () => {
      mockGetConversation.mockResolvedValueOnce({ ok: false, reason: "error" });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}`),
      );
      expect(response.status).toBe(500);

      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
      expect(body.message).toBe("A database error occurred. Please try again.");
    });

    it("returns 404 when no internal DB", async () => {
      delete process.env.DATABASE_URL;

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}`),
      );
      expect(response.status).toBe(404);
    });

    it("passes userId for auth scoping", async () => {
      mockGetConversation.mockResolvedValueOnce({ ok: false, reason: "not_found" });

      await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}`),
      );
      const call = mockGetConversation.mock.calls[0] as unknown as [string, string | undefined];
      expect(call[0]).toBe(VALID_ID);
      expect(call[1]).toBe("u1");
    });

    it("returns 400 for invalid conversation ID format", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/conversations/not-a-uuid"),
      );
      expect(response.status).toBe(400);
      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe("invalid_request");
    });
  });

  // -----------------------------------------------------------------------
  // DELETE /api/v1/conversations/:id
  // -----------------------------------------------------------------------

  describe("DELETE /api/v1/conversations/:id", () => {
    it("returns 204 on successful delete", async () => {
      mockDeleteConversation.mockResolvedValueOnce({ ok: true });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}`, {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(204);
    });

    it("returns 404 when not found", async () => {
      mockDeleteConversation.mockResolvedValueOnce({ ok: false, reason: "not_found" });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}`, {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(404);
    });

    it("returns 500 on database error", async () => {
      mockDeleteConversation.mockResolvedValueOnce({ ok: false, reason: "error" });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}`, {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(500);

      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
      expect(body.message).toBe("A database error occurred. Please try again.");
    });

    it("returns 404 when no internal DB", async () => {
      delete process.env.DATABASE_URL;

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}`, {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(404);
    });

    it("passes userId for auth scoping", async () => {
      mockDeleteConversation.mockResolvedValueOnce({ ok: false, reason: "not_found" });

      await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}`, {
          method: "DELETE",
        }),
      );
      const call = mockDeleteConversation.mock.calls[0] as unknown as [string, string | undefined];
      expect(call[0]).toBe(VALID_ID);
      expect(call[1]).toBe("u1");
    });

    it("returns 400 for invalid conversation ID format", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/conversations/not-a-uuid", {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(400);
      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe("invalid_request");
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/v1/conversations?starred=true
  // -----------------------------------------------------------------------

  describe("GET /api/v1/conversations?starred=true", () => {
    it("passes starred=true filter to listConversations", async () => {
      await app.fetch(
        new Request("http://localhost/api/v1/conversations?starred=true"),
      );
      const call = mockListConversations.mock.calls[0] as unknown as [{ starred?: boolean }];
      expect(call[0].starred).toBe(true);
    });

    it("passes starred=false filter to listConversations", async () => {
      await app.fetch(
        new Request("http://localhost/api/v1/conversations?starred=false"),
      );
      const call = mockListConversations.mock.calls[0] as unknown as [{ starred?: boolean }];
      expect(call[0].starred).toBe(false);
    });

    it("does not set starred when param is absent", async () => {
      await app.fetch(
        new Request("http://localhost/api/v1/conversations"),
      );
      const call = mockListConversations.mock.calls[0] as unknown as [{ starred?: boolean }];
      expect(call[0].starred).toBeUndefined();
    });

    it("ignores non-boolean starred values", async () => {
      await app.fetch(
        new Request("http://localhost/api/v1/conversations?starred=1"),
      );
      const call = mockListConversations.mock.calls[0] as unknown as [{ starred?: boolean }];
      expect(call[0].starred).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // PATCH /api/v1/conversations/:id/star
  // -----------------------------------------------------------------------

  describe("PATCH /api/v1/conversations/:id/star", () => {
    it("returns 200 on successful star", async () => {
      mockStarConversation.mockResolvedValueOnce({ ok: true });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}/star`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ starred: true }),
        }),
      );
      expect(response.status).toBe(200);

      const body = await response.json() as Record<string, unknown>;
      expect(body.id).toBe(VALID_ID);
      expect(body.starred).toBe(true);
    });

    it("returns 200 on successful unstar", async () => {
      mockStarConversation.mockResolvedValueOnce({ ok: true });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}/star`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ starred: false }),
        }),
      );
      expect(response.status).toBe(200);

      const body = await response.json() as Record<string, unknown>;
      expect(body.starred).toBe(false);
    });

    it("returns 404 when conversation not found", async () => {
      mockStarConversation.mockResolvedValueOnce({ ok: false, reason: "not_found" });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}/star`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ starred: true }),
        }),
      );
      expect(response.status).toBe(404);
    });

    it("returns 500 on database error", async () => {
      mockStarConversation.mockResolvedValueOnce({ ok: false, reason: "error" });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}/star`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ starred: true }),
        }),
      );
      expect(response.status).toBe(500);

      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
      expect(body.message).toBe("A database error occurred. Please try again.");
    });

    it("returns 400 for invalid body", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}/star`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ starred: "yes" }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it("returns 400 for missing body", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}/star`, {
          method: "PATCH",
        }),
      );
      expect(response.status).toBe(400);
    });

    it("returns 400 for invalid conversation ID format", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/conversations/not-a-uuid/star", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ starred: true }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it("returns 404 when no internal DB", async () => {
      delete process.env.DATABASE_URL;

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}/star`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ starred: true }),
        }),
      );
      expect(response.status).toBe(404);
    });

    it("passes userId for auth scoping", async () => {
      mockStarConversation.mockResolvedValueOnce({ ok: true });

      await app.fetch(
        new Request(`http://localhost/api/v1/conversations/${VALID_ID}/star`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ starred: true }),
        }),
      );
      const call = mockStarConversation.mock.calls[0] as unknown as [string, boolean, string | undefined];
      expect(call[0]).toBe(VALID_ID);
      expect(call[1]).toBe(true);
      expect(call[2]).toBe("u1");
    });
  });
});
