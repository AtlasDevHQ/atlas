/**
 * Integration tests for action permissions.
 *
 * Tests the interaction between the permission system and the action handler/routes:
 * - Role-based gating on approve/deny endpoints
 * - Simple-key ATLAS_API_KEY_ROLE override
 * - BYOT JWT role claim extraction
 * - Config requiredRole field
 * - Viewer cannot approve any actions
 * - Analyst can approve manual, blocked from admin-only
 * - Admin can approve all
 *
 * Uses mock.module() to isolate from real auth and DB.
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
import type { AuthResult, AtlasUser, AtlasRole } from "@atlas/api/lib/auth/types";
import type { ActionLogEntry, ActionApprovalMode } from "@atlas/api/lib/action-types";

// --- Mocks ---

// Track which user the mock auth returns — tests change this
let currentUser: AtlasUser | undefined = {
  id: "u1",
  label: "test@test.com",
  mode: "simple-key",
  role: "admin",
};

const mockAuthenticateRequest: Mock<
  (req: Request) => Promise<AuthResult>
> = mock(() =>
  Promise.resolve(
    currentUser
      ? {
          authenticated: true as const,
          mode: currentUser.mode,
          user: currentUser,
        }
      : {
          authenticated: true as const,
          mode: "none" as const,
          user: undefined,
        },
  ),
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
const mockRollbackAction = mock((): Promise<ActionLogEntry | null> =>
  Promise.resolve(null),
);

let currentActionConfig: { approval: ActionApprovalMode; requiredRole?: AtlasRole } = {
  approval: "manual",
};

const mockGetActionConfig = mock(
  () => currentActionConfig,
);

mock.module("@atlas/api/lib/tools/actions/handler", () => ({
  listPendingActions: mockListPendingActions,
  getAction: mockGetAction,
  approveAction: mockApproveAction,
  denyAction: mockDenyAction,
  rollbackAction: mockRollbackAction,
  getActionExecutor: mockGetActionExecutor,
  getActionConfig: mockGetActionConfig,
}));

// Mock other modules required by the Hono app

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
  shareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  unshareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  getShareStatus: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  cleanupExpiredShares: mock(() => Promise.resolve(0)),
  getSharedConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
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
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: () => [],
}));

// Enable actions route before importing the app
process.env.ATLAS_ACTIONS_ENABLED = "true";

// Import after mocks
const { app } = await import("../../../api/index");

const VALID_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function makeAction(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return {
    id: VALID_ID,
    requested_at: "2024-06-01T00:00:00Z",
    resolved_at: null,
    executed_at: null,
    requested_by: "other-user", // Default: different user than the approver
    approved_by: null,
    auth_mode: "simple-key",
    action_type: "test:action",
    target: "test-target",
    summary: "Test action",
    payload: { key: "value" },
    status: "pending",
    result: null,
    error: null,
    rollback_info: null,
    conversation_id: null,
    request_id: null,
    ...overrides,
  };
}

function setUser(mode: "simple-key" | "managed" | "byot", role?: AtlasRole) {
  currentUser = {
    id: "u1",
    label: `${mode}-user`,
    mode,
    ...(role ? { role } : {}),
  };
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true as const,
      mode: currentUser!.mode,
      user: currentUser!,
    }),
  );
}

function setNoUser() {
  currentUser = undefined;
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true as const,
      mode: "none" as const,
      user: undefined,
    }),
  );
}

describe("action permissions integration", () => {
  const origDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    currentActionConfig = { approval: "manual" };

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
    mockGetActionConfig.mockImplementation(() => currentActionConfig);
  });

  afterEach(() => {
    if (origDatabaseUrl !== undefined) process.env.DATABASE_URL = origDatabaseUrl;
    else delete process.env.DATABASE_URL;
  });

  // -------------------------------------------------------------------------
  // Viewer cannot approve any actions
  // -------------------------------------------------------------------------

  describe("member role", () => {
    beforeEach(() => {
      setUser("managed", "member");
    });

    it("cannot approve manual actions", async () => {
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);
      currentActionConfig = { approval: "manual" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("forbidden");
      expect(body.message).toContain("Insufficient role");
    });

    it("cannot approve admin-only actions", async () => {
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);
      currentActionConfig = { approval: "admin-only" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);
    });

    it("cannot deny manual actions", async () => {
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);
      currentActionConfig = { approval: "manual" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);
    });

    it("cannot deny admin-only actions", async () => {
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);
      currentActionConfig = { approval: "admin-only" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Admin can approve manual, blocked from admin-only (owner-only)
  // -------------------------------------------------------------------------

  describe("admin role (approval)", () => {
    beforeEach(() => {
      setUser("simple-key", "admin");
    });

    it("can approve manual actions", async () => {
      const action = makeAction();
      const approved = makeAction({ status: "approved", approved_by: "u1" });
      mockGetAction.mockResolvedValueOnce(action);
      mockApproveAction.mockResolvedValueOnce(approved);
      currentActionConfig = { approval: "manual" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
    });

    it("cannot approve admin-only actions", async () => {
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);
      currentActionConfig = { approval: "admin-only" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("forbidden");
    });

    it("can deny manual actions", async () => {
      const action = makeAction();
      const denied = makeAction({ status: "denied", approved_by: "u1" });
      mockGetAction.mockResolvedValueOnce(action);
      mockDenyAction.mockResolvedValueOnce(denied);
      currentActionConfig = { approval: "manual" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
    });

    it("cannot deny admin-only actions", async () => {
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);
      currentActionConfig = { approval: "admin-only" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Admin can approve all actions
  // -------------------------------------------------------------------------

  describe("admin role", () => {
    beforeEach(() => {
      setUser("byot", "admin");
    });

    it("can approve manual actions", async () => {
      const action = makeAction();
      const approved = makeAction({ status: "approved", approved_by: "u1" });
      mockGetAction.mockResolvedValueOnce(action);
      mockApproveAction.mockResolvedValueOnce(approved);
      currentActionConfig = { approval: "manual" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
    });

    it("cannot approve admin-only (owner-only) actions", async () => {
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);
      currentActionConfig = { approval: "admin-only" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Owner role — full permissions including admin-only
  // -------------------------------------------------------------------------

  describe("owner role", () => {
    beforeEach(() => {
      setUser("managed", "owner");
    });

    it("can approve admin-only actions", async () => {
      const action = makeAction();
      const approved = makeAction({ status: "approved", approved_by: "u1" });
      mockGetAction.mockResolvedValueOnce(action);
      mockApproveAction.mockResolvedValueOnce(approved);
      currentActionConfig = { approval: "admin-only" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
    });

    it("can deny admin-only actions", async () => {
      const action = makeAction();
      const denied = makeAction({ status: "denied", approved_by: "u1" });
      mockGetAction.mockResolvedValueOnce(action);
      mockDenyAction.mockResolvedValueOnce(denied);
      currentActionConfig = { approval: "admin-only" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Simple-key mode defaults
  // -------------------------------------------------------------------------

  describe("simple-key default role", () => {
    it("defaults to admin — can approve manual", async () => {
      setUser("simple-key"); // no explicit role — defaults to admin
      const action = makeAction();
      const approved = makeAction({ status: "approved", approved_by: "u1" });
      mockGetAction.mockResolvedValueOnce(action);
      mockApproveAction.mockResolvedValueOnce(approved);
      currentActionConfig = { approval: "manual" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
    });

    it("defaults to admin — blocked from admin-only (owner-only)", async () => {
      setUser("simple-key"); // no explicit role — defaults to admin
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);
      currentActionConfig = { approval: "admin-only" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Per-action requiredRole config override
  // -------------------------------------------------------------------------

  describe("per-action requiredRole override", () => {
    it("requiredRole=owner blocks admin on manual action", async () => {
      setUser("simple-key", "admin");
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);
      currentActionConfig = { approval: "manual", requiredRole: "owner" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);
    });

    it("requiredRole=admin allows admin on manual action", async () => {
      setUser("byot", "admin");
      const action = makeAction();
      const approved = makeAction({ status: "approved", approved_by: "u1" });
      mockGetAction.mockResolvedValueOnce(action);
      mockApproveAction.mockResolvedValueOnce(approved);
      currentActionConfig = { approval: "manual", requiredRole: "admin" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
    });

    it("requiredRole=member allows member on manual action", async () => {
      setUser("managed", "member");
      const action = makeAction();
      const approved = makeAction({ status: "approved", approved_by: "u1" });
      mockGetAction.mockResolvedValueOnce(action);
      mockApproveAction.mockResolvedValueOnce(approved);
      currentActionConfig = { approval: "manual", requiredRole: "member" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // No-auth mode (none)
  // -------------------------------------------------------------------------

  describe("no-auth mode (user is undefined)", () => {
    beforeEach(() => {
      setNoUser();
    });

    it("cannot approve manual actions", async () => {
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);
      currentActionConfig = { approval: "manual" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);
    });

    it("cannot deny manual actions", async () => {
      const action = makeAction();
      mockGetAction.mockResolvedValueOnce(action);
      currentActionConfig = { approval: "manual" };

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Auth mode x role x approval mode matrix (all 3 auth modes)
  // -------------------------------------------------------------------------

  describe("cross-auth-mode matrix", () => {
    const modes = ["simple-key", "managed", "byot"] as const;
    const scenarios: Array<{
      role: AtlasRole;
      approval: ActionApprovalMode;
      expectStatus: 200 | 403;
    }> = [
      // member: blocked from manual and admin-only
      { role: "member", approval: "manual", expectStatus: 403 },
      { role: "member", approval: "admin-only", expectStatus: 403 },
      // admin: can approve manual, blocked from admin-only (owner-only)
      { role: "admin", approval: "manual", expectStatus: 200 },
      { role: "admin", approval: "admin-only", expectStatus: 403 },
      // owner: can approve all
      { role: "owner", approval: "manual", expectStatus: 200 },
      { role: "owner", approval: "admin-only", expectStatus: 200 },
    ];

    for (const mode of modes) {
      for (const { role, approval, expectStatus } of scenarios) {
        it(`${mode}/${role} + ${approval} => ${expectStatus}`, async () => {
          setUser(mode, role);
          const action = makeAction();

          if (expectStatus === 200) {
            const approved = makeAction({ status: "approved", approved_by: "u1" });
            mockGetAction.mockResolvedValueOnce(action);
            mockApproveAction.mockResolvedValueOnce(approved);
          } else {
            mockGetAction.mockResolvedValueOnce(action);
          }

          currentActionConfig = { approval };

          const response = await app.fetch(
            new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
              method: "POST",
            }),
          );
          expect(response.status).toBe(expectStatus);
        });
      }
    }
  });
});
