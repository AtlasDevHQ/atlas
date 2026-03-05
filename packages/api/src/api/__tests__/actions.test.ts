/**
 * Unit tests for the actions REST routes.
 *
 * Uses mock.module() pattern from conversations.test.ts.
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
import type { ActionLogEntry, ActionApprovalMode } from "@atlas/api/lib/action-types";

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

// --- Action handler mocks ---

const mockListPendingActions = mock((): Promise<ActionLogEntry[]> =>
  Promise.resolve([]),
);
const mockGetAction = mock((): Promise<ActionLogEntry | null> =>
  Promise.resolve(null),
);
const mockApproveAction = mock((): Promise<ActionLogEntry | null> =>
  Promise.resolve(null),
);
const mockDenyAction = mock((): Promise<ActionLogEntry | null> =>
  Promise.resolve(null),
);
const mockGetActionExecutor = mock((): undefined => undefined);
const mockGetActionConfig = mock(
  (): { approval: ActionApprovalMode; timeout?: number; maxPerConversation?: number } => ({
    approval: "manual",
  }),
);

mock.module("@atlas/api/lib/tools/actions/handler", () => ({
  listPendingActions: mockListPendingActions,
  getAction: mockGetAction,
  approveAction: mockApproveAction,
  denyAction: mockDenyAction,
  getActionExecutor: mockGetActionExecutor,
  getActionConfig: mockGetActionConfig,
}));

// Mock other modules required by the Hono app (same as conversations.test.ts)

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

mock.module("@atlas/api/lib/conversations", () => ({
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  getConversation: mock(() => Promise.resolve(null)),
  deleteConversation: mock(() => Promise.resolve(false)),
  createConversation: mock(() => Promise.resolve(null)),
  addMessage: mock(() => {}),
  generateTitle: mock(() => "Test title"),
  starConversation: async () => false,
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

// Enable actions route before importing the app — the route mounts conditionally
process.env.ATLAS_ACTIONS_ENABLED = "true";

// Import after mocks
const { app } = await import("../index");

// Valid UUID for tests — routes validate UUID format on :id params
const VALID_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function makeAction(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return {
    id: VALID_ID,
    requested_at: "2024-06-01T00:00:00Z",
    resolved_at: null,
    executed_at: null,
    requested_by: "u1",
    approved_by: null,
    auth_mode: "simple-key",
    action_type: "send_email",
    target: "user@example.com",
    summary: "Send email to user",
    payload: { to: "user@example.com", body: "Hello" },
    status: "pending",
    result: null,
    error: null,
    rollback_info: null,
    conversation_id: null,
    request_id: null,
    ...overrides,
  };
}

describe("actions routes", () => {
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
    mockListPendingActions.mockReset();
    mockListPendingActions.mockResolvedValue([]);
    mockGetAction.mockReset();
    mockGetAction.mockResolvedValue(null);
    mockApproveAction.mockReset();
    mockApproveAction.mockResolvedValue(null);
    mockDenyAction.mockReset();
    mockDenyAction.mockResolvedValue(null);
    mockGetActionExecutor.mockReset();
    mockGetActionExecutor.mockReturnValue(undefined);
    mockGetActionConfig.mockReset();
    mockGetActionConfig.mockReturnValue({ approval: "manual" });
  });

  afterEach(() => {
    if (origDatabaseUrl !== undefined) process.env.DATABASE_URL = origDatabaseUrl;
    else delete process.env.DATABASE_URL;
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/actions
  // -------------------------------------------------------------------------

  describe("GET /api/v1/actions", () => {
    it("returns 200 with actions list", async () => {
      const action = makeAction();
      mockListPendingActions.mockResolvedValueOnce([action]);

      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions"),
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as { actions: unknown[] };
      expect(body.actions.length).toBe(1);
    });

    it("returns 200 with empty list when no actions", async () => {
      mockListPendingActions.mockResolvedValueOnce([]);

      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions"),
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as { actions: unknown[] };
      expect(body.actions.length).toBe(0);
    });

    it("returns 404 when no internal DB", async () => {
      delete process.env.DATABASE_URL;

      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions"),
      );
      expect(response.status).toBe(404);

      const body = (await response.json()) as Record<string, unknown>;
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
        new Request("http://localhost/api/v1/actions"),
      );
      expect(response.status).toBe(401);
    });

    it("returns 429 when rate limited", async () => {
      mockCheckRateLimit.mockReturnValueOnce({
        allowed: false,
        retryAfterMs: 30000,
      });

      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions"),
      );
      expect(response.status).toBe(429);
    });

    it("returns 500 when authenticateRequest throws", async () => {
      mockAuthenticateRequest.mockRejectedValueOnce(new Error("DB crashed"));
      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions"),
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("auth_error");
    });

    it("passes userId from auth to listPendingActions", async () => {
      await app.fetch(
        new Request("http://localhost/api/v1/actions"),
      );
      expect(mockListPendingActions).toHaveBeenCalledTimes(1);
      const call = mockListPendingActions.mock.calls[0] as unknown as [{ userId?: string }];
      expect(call[0].userId).toBe("u1");
    });

    it("passes status query param", async () => {
      await app.fetch(
        new Request("http://localhost/api/v1/actions?status=approved"),
      );
      expect(mockListPendingActions).toHaveBeenCalledTimes(1);
      const call = mockListPendingActions.mock.calls[0] as unknown as [{ status?: string }];
      expect(call[0].status).toBe("approved");
    });

    it("passes limit query param", async () => {
      await app.fetch(
        new Request("http://localhost/api/v1/actions?limit=10"),
      );
      const call = mockListPendingActions.mock.calls[0] as unknown as [{ limit?: number }];
      expect(call[0].limit).toBe(10);
    });

    it("returns 500 when listPendingActions throws", async () => {
      mockListPendingActions.mockRejectedValueOnce(new Error("DB connection lost"));

      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions"),
      );
      expect(response.status).toBe(500);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
    });

    it("?limit=0 defaults to 50", async () => {
      await app.fetch(
        new Request("http://localhost/api/v1/actions?limit=0"),
      );
      expect(mockListPendingActions).toHaveBeenCalledTimes(1);
      const call = mockListPendingActions.mock.calls[0] as unknown as [{ limit?: number }];
      expect(call[0].limit).toBe(50);
    });

    it("?limit=200 caps at 100", async () => {
      await app.fetch(
        new Request("http://localhost/api/v1/actions?limit=200"),
      );
      expect(mockListPendingActions).toHaveBeenCalledTimes(1);
      const call = mockListPendingActions.mock.calls[0] as unknown as [{ limit?: number }];
      expect(call[0].limit).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/actions/:id
  // -------------------------------------------------------------------------

  describe("GET /api/v1/actions/:id", () => {
    it("returns 200 with action", async () => {
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}`),
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.id).toBe(VALID_ID);
      expect(body.action_type).toBe("send_email");
    });

    it("returns 404 when not found", async () => {
      mockGetAction.mockResolvedValueOnce(null);

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}`),
      );
      expect(response.status).toBe(404);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("not_found");
    });

    it("returns 400 for invalid UUID", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions/not-a-uuid"),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_request");
    });

    it("returns 404 when no internal DB", async () => {
      delete process.env.DATABASE_URL;

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}`),
      );
      expect(response.status).toBe(404);
    });

    it("returns 404 when action belongs to different user (IDOR)", async () => {
      const action = makeAction({ requested_by: "other-user" });
      mockGetAction.mockResolvedValueOnce(action);

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}`),
      );
      expect(response.status).toBe(404);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("not_found");
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/actions/:id/approve
  // -------------------------------------------------------------------------

  describe("POST /api/v1/actions/:id/approve", () => {
    it("returns 200 on successful approval", async () => {
      const action = makeAction();
      const approvedAction = makeAction({
        status: "approved",
        resolved_at: "2024-06-01T01:00:00Z",
        approved_by: "u1",
      });
      mockGetAction.mockResolvedValueOnce(action);
      mockApproveAction.mockResolvedValueOnce(approvedAction);

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.status).toBe("approved");
      expect(body.approved_by).toBe("u1");
    });

    it("returns 409 when action already resolved", async () => {
      const action = makeAction({ status: "approved" });
      mockGetAction.mockResolvedValueOnce(action);
      mockApproveAction.mockResolvedValueOnce(null);

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(409);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("conflict");
    });

    it("returns 400 for invalid UUID", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions/not-a-uuid/approve", {
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_request");
    });

    it("returns 404 when action not found", async () => {
      mockGetAction.mockResolvedValueOnce(null);

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(404);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("not_found");
    });

    it("returns 404 when no internal DB", async () => {
      delete process.env.DATABASE_URL;

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(404);
    });

    it("passes approverId from auth user", async () => {
      const action = makeAction();
      const approvedAction = makeAction({ status: "approved", approved_by: "u1" });
      mockGetAction.mockResolvedValueOnce(action);
      mockApproveAction.mockResolvedValueOnce(approvedAction);

      await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );

      expect(mockApproveAction).toHaveBeenCalledTimes(1);
      const call = mockApproveAction.mock.calls[0] as unknown as [string, string, unknown];
      expect(call[0]).toBe(VALID_ID);
      expect(call[1]).toBe("u1");
    });

    it("looks up executor via getActionExecutor with action ID", async () => {
      const action = makeAction({ action_type: "send_email" });
      const approvedAction = makeAction({ status: "approved" });
      mockGetAction.mockResolvedValueOnce(action);
      mockGetActionExecutor.mockReturnValueOnce(undefined);
      mockApproveAction.mockResolvedValueOnce(approvedAction);

      await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );

      expect(mockGetActionExecutor).toHaveBeenCalledWith(VALID_ID);
    });

    it("returns 403 for admin-only action when approver is the requester", async () => {
      const action = makeAction({ requested_by: "u1", action_type: "admin:action" });
      mockGetAction.mockResolvedValueOnce(action);
      mockGetActionConfig.mockReturnValueOnce({ approval: "admin-only" });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("forbidden");
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/actions/:id/deny
  // -------------------------------------------------------------------------

  describe("POST /api/v1/actions/:id/deny", () => {
    it("returns 200 on successful denial", async () => {
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);
      const deniedAction = makeAction({
        status: "denied",
        resolved_at: "2024-06-01T01:00:00Z",
        approved_by: "u1",
      });
      mockDenyAction.mockResolvedValueOnce(deniedAction);

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.status).toBe("denied");
    });

    it("returns 404 when action not found", async () => {
      mockGetAction.mockResolvedValueOnce(null);

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(404);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("not_found");
    });

    it("returns 409 when action already resolved", async () => {
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);
      mockDenyAction.mockResolvedValueOnce(null);

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(409);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("conflict");
    });

    it("returns 400 for invalid UUID", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions/not-a-uuid/deny", {
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_request");
    });

    it("returns 404 when no internal DB", async () => {
      delete process.env.DATABASE_URL;

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(404);
    });

    it("accepts reason in body", async () => {
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);
      const deniedAction = makeAction({
        status: "denied",
        error: "Not appropriate",
      });
      mockDenyAction.mockResolvedValueOnce(deniedAction);

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Not appropriate" }),
        }),
      );
      expect(response.status).toBe(200);

      expect(mockDenyAction).toHaveBeenCalledTimes(1);
      const call = mockDenyAction.mock.calls[0] as unknown as [string, string, string | undefined];
      expect(call[0]).toBe(VALID_ID);
      expect(call[1]).toBe("u1");
      expect(call[2]).toBe("Not appropriate");
    });

    it("works without a body (reason is optional)", async () => {
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);
      const deniedAction = makeAction({ status: "denied" });
      mockDenyAction.mockResolvedValueOnce(deniedAction);

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);

      const call = mockDenyAction.mock.calls[0] as unknown as [string, string, string | undefined];
      expect(call[2]).toBeUndefined();
    });

    it("passes denierId from auth user", async () => {
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);
      const deniedAction = makeAction({ status: "denied", approved_by: "u1" });
      mockDenyAction.mockResolvedValueOnce(deniedAction);

      await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
        }),
      );

      const call = mockDenyAction.mock.calls[0] as unknown as [string, string, string | undefined];
      expect(call[0]).toBe(VALID_ID);
      expect(call[1]).toBe("u1");
    });

    it("returns 403 for admin-only action when denier is the requester", async () => {
      const action = makeAction({ requested_by: "u1", action_type: "admin:action" });
      mockGetAction.mockResolvedValueOnce(action);
      mockGetActionConfig.mockReturnValueOnce({ approval: "admin-only" });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("forbidden");
    });

    it("returns 400 when Content-Type is application/json but body is invalid JSON", async () => {
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not valid json{",
        }),
      );
      expect(response.status).toBe(400);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_request");
    });
  });
});
