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

void mock.module("@atlas/api/lib/auth/middleware", () => ({
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
// The resolution verbs own authorization + CAS + executor lookup since the
// ADR-0046 cleanup pass — the route keeps only HTTP mapping, so these mocks
// script OUTCOMES. The verb-level composition (approverId propagation,
// executor fallback, org scoping) is pinned in
// lib/tools/actions/__tests__/resolve-as-user.test.ts.
type ApproveOutcome =
  | { kind: "not_found" }
  | { kind: "forbidden"; reason: "role" | "self_approval" }
  | { kind: "conflict" }
  | { kind: "approved"; entry: ActionLogEntry }
  | { kind: "approved_not_executed"; entry: ActionLogEntry };
type RedispatchOutcome =
  | { kind: "not_found" }
  | { kind: "forbidden"; reason: "role" | "self_approval" }
  | { kind: "conflict" }
  | { kind: "unregistered_type"; entry: ActionLogEntry }
  | { kind: "redispatched"; entry: ActionLogEntry };
type DenyOutcome =
  | Exclude<ApproveOutcome, { kind: "approved" } | { kind: "approved_not_executed" }>
  | { kind: "denied"; entry: ActionLogEntry };
const mockApproveActionAsUser = mock((): Promise<ApproveOutcome> =>
  Promise.resolve({ kind: "conflict" }),
);
const mockDenyActionAsUser = mock((): Promise<DenyOutcome> =>
  Promise.resolve({ kind: "conflict" }),
);
const mockGetActionConfig = mock(
  (): { approval: ActionApprovalMode; timeout?: number; maxPerConversation?: number } => ({
    approval: "manual",
  }),
);
const mockRedispatchActionAsUser = mock((): Promise<RedispatchOutcome> =>
  Promise.resolve({ kind: "conflict" }),
);
const mockRollbackAction = mock((): Promise<ActionLogEntry | null> =>
  Promise.resolve(null),
);

void mock.module("@atlas/api/lib/tools/actions/handler", () => ({
  listPendingActions: mockListPendingActions,
  getAction: mockGetAction,
  approveActionAsUser: mockApproveActionAsUser,
  denyActionAsUser: mockDenyActionAsUser,
  redispatchActionAsUser: mockRedispatchActionAsUser,
  rollbackAction: mockRollbackAction,
  getActionConfig: mockGetActionConfig,
}));

// --- Admin-action audit mock ---
//
// The BARREL, not `lib/audit/admin`: the route imports it that way, and these
// tests set DATABASE_URL to satisfy `hasInternalDB()`, so a real
// `logAdminActionAwait` would try to INSERT against a database that is not
// there. `admin-brain-triage.test.ts` mocks the same seam for the same reason.
const mockLogAdminActionAwait = mock((): Promise<void> => Promise.resolve());

// Spread the real barrel rather than listing two keys: `mock.module` REPLACES
// the module, and the admin app reaches this barrel for `logAdminAction`,
// `ADMIN_ACTIONS` and more. A two-key factory made every one of those a
// missing export — which is what the "mock ALL exports" rule in
// `.claude/rules/testing.md` is about.
const realAudit = await import("@atlas/api/lib/audit");

void mock.module("@atlas/api/lib/audit", () => ({
  ...realAudit,
  logAdminActionAwait: mockLogAdminActionAwait,
}));

// --- Bulk module mocks ---

type BulkResult = {
  updated: string[];
  notFound: string[];
  forbidden: string[];
  errors: Array<{ id: string; error: string }>;
};

const mockBulkApproveActions = mock(
  (): Promise<BulkResult> =>
    Promise.resolve({ updated: [], notFound: [], forbidden: [], errors: [] }),
);
const mockBulkDenyActions = mock(
  (): Promise<BulkResult> =>
    Promise.resolve({ updated: [], notFound: [], forbidden: [], errors: [] }),
);

void mock.module("@atlas/api/lib/tools/actions/bulk", () => ({
  bulkApproveActions: mockBulkApproveActions,
  bulkDenyActions: mockBulkDenyActions,
  BULK_ACTIONS_MAX: 100,
}));

// Mock other modules required by the Hono app (same as conversations.test.ts)

void mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(() =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      text: Promise.resolve("answer"),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
    }),
  ),
}));

void mock.module("@atlas/api/lib/conversations", () => ({
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  getConversation: mock(() => Promise.resolve(null)),
  deleteConversation: mock(() => Promise.resolve(false)),
  createConversation: mock(() => Promise.resolve(null)),
  addMessage: mock(() => {}),
  persistAssistantSteps: mock(() => {}),
  // F-77 step-cap helpers — chat.ts imports both via @atlas/api/lib/conversations.
  reserveConversationBudget: mock(() => Promise.resolve({ status: 'ok' as const, totalStepsBefore: 0 })),
  settleConversationSteps: mock(() => {}),
  generateTitle: mock(() => "Test title"),
  starConversation: async () => false,
  shareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  unshareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  getShareStatus: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  cleanupExpiredShares: mock(() => Promise.resolve(0)),
  getSharedConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  resolveGroupForConnection: mock(() => Promise.resolve(null)),
  verifyGroupBelongsToOrg: mock(() => Promise.resolve("ok")),
  // #4351 — the single conversation-scope write path. No-op success by
  // default; tests that exercise a picker toggle override locally.
  updateConversationScope: mock(() => Promise.resolve({ ok: true as const })),
}));

void mock.module("@atlas/api/lib/semantic", () => ({
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

void mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
}));

void mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "none",
  resetAuthModeCache: () => {},
}));

void mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: () => [],
}));

// EE IP-allowlist middleware runs when auth mock sets `activeOrganizationId`.
// Stub with `{ allowed: true }` so route tests can assert orgId propagation
// without hitting a real postgres.
import { Effect as _EffectForAllowlistMock } from "effect";
void mock.module("@atlas/ee/auth/ip-allowlist", () => ({
  checkIPAllowlist: () => _EffectForAllowlistMock.succeed({ allowed: true as const }),
}));

// Enable actions route before importing the app — the route mounts conditionally
// Module-top env setup — must be set before the dynamic imports below
// (the imported modules read env at module-load time). `??=` keeps the
// assignment hoisted; cross-file leakage under `bun test --parallel`
// (1.5.4 #2797) is bounded — the first file to load wins, no sibling
// overwrites. Files that need to restore env do so in their own
// afterAll; the `??=` here is the module-load contract, not teardown.
process.env.ATLAS_ACTIONS_ENABLED ??= "true";

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
    org_id: null,
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
      user: {
        id: "u1",
        label: "test@test.com",
        mode: "simple-key" as const,
        activeOrganizationId: "org-u1",
      },
    });
    mockCheckRateLimit.mockReset();
    mockCheckRateLimit.mockReturnValue({ allowed: true });
    mockGetClientIP.mockReset();
    mockGetClientIP.mockReturnValue(null);
    mockListPendingActions.mockReset();
    mockListPendingActions.mockResolvedValue([]);
    mockGetAction.mockReset();
    mockGetAction.mockResolvedValue(null);
    mockApproveActionAsUser.mockReset();
    mockApproveActionAsUser.mockResolvedValue({ kind: "conflict" });
    mockDenyActionAsUser.mockReset();
    mockDenyActionAsUser.mockResolvedValue({ kind: "conflict" });
    mockGetActionConfig.mockReset();
    mockGetActionConfig.mockReturnValue({ approval: "manual" });
    mockRedispatchActionAsUser.mockReset();
    mockRedispatchActionAsUser.mockResolvedValue({ kind: "conflict" });
    mockLogAdminActionAwait.mockReset();
    mockLogAdminActionAwait.mockResolvedValue(undefined);
    mockRollbackAction.mockReset();
    mockRollbackAction.mockResolvedValue(null);
    mockBulkApproveActions.mockReset();
    mockBulkApproveActions.mockResolvedValue({
      updated: [],
      notFound: [],
      forbidden: [],
      errors: [],
    });
    mockBulkDenyActions.mockReset();
    mockBulkDenyActions.mockResolvedValue({
      updated: [],
      notFound: [],
      forbidden: [],
      errors: [],
    });
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
      const approvedAction = makeAction({
        status: "approved",
        resolved_at: "2024-06-01T01:00:00Z",
        approved_by: "u1",
      });
      mockApproveActionAsUser.mockResolvedValueOnce({ kind: "approved", entry: approvedAction });

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
      mockApproveActionAsUser.mockResolvedValueOnce({ kind: "conflict" });

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
      mockApproveActionAsUser.mockResolvedValueOnce({ kind: "not_found" });

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

    it("passes the acting user and their org to the verb", async () => {
      const approvedAction = makeAction({ status: "approved", approved_by: "u1" });
      mockApproveActionAsUser.mockResolvedValueOnce({ kind: "approved", entry: approvedAction });

      await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );

      expect(mockApproveActionAsUser).toHaveBeenCalledTimes(1);
      const call = mockApproveActionAsUser.mock.calls[0] as unknown as [
        string,
        { user?: { id?: string }; orgId?: string | null },
      ];
      expect(call[0]).toBe(VALID_ID);
      expect(call[1].user?.id).toBe("u1");
      expect(call[1].orgId).toBe("org-u1");
    });

    it("maps approved_not_executed to the same 200 wire shape — the entry's status carries the truth", async () => {
      // The tagged kind exists so no CALLER conflates the silent-drop state
      // with success in code; on the wire the entry's own status ("approved",
      // never advanced) is the disclosure, unchanged from before the verbs.
      const stranded = makeAction({ status: "approved", approved_by: "u1" });
      mockApproveActionAsUser.mockResolvedValueOnce({ kind: "approved_not_executed", entry: stranded });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.status).toBe("approved");
    });

    it("returns 403 for admin-only action when approver is the requester", async () => {
      mockApproveActionAsUser.mockResolvedValueOnce({ kind: "forbidden", reason: "self_approval" });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("forbidden");
      expect(body.message).toContain("cannot be approved by the requester");
    });

    it("returns 403 with the role message for a role refusal", async () => {
      mockApproveActionAsUser.mockResolvedValueOnce({ kind: "forbidden", reason: "role" });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.message).toContain("Insufficient role to approve");
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/actions/:id/deny
  // -------------------------------------------------------------------------

  describe("POST /api/v1/actions/:id/deny", () => {
    it("returns 200 on successful denial", async () => {
      const deniedAction = makeAction({
        status: "denied",
        resolved_at: "2024-06-01T01:00:00Z",
        approved_by: "u1",
      });
      mockDenyActionAsUser.mockResolvedValueOnce({ kind: "denied", entry: deniedAction });

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
      mockDenyActionAsUser.mockResolvedValueOnce({ kind: "not_found" });

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
      mockDenyActionAsUser.mockResolvedValueOnce({ kind: "conflict" });

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
      const deniedAction = makeAction({
        status: "denied",
        error: "Not appropriate",
      });
      mockDenyActionAsUser.mockResolvedValueOnce({ kind: "denied", entry: deniedAction });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Not appropriate" }),
        }),
      );
      expect(response.status).toBe(200);

      expect(mockDenyActionAsUser).toHaveBeenCalledTimes(1);
      const call = mockDenyActionAsUser.mock.calls[0] as unknown as [
        string,
        { user?: { id?: string }; orgId?: string | null },
        string | undefined,
      ];
      expect(call[0]).toBe(VALID_ID);
      expect(call[1].user?.id).toBe("u1");
      expect(call[2]).toBe("Not appropriate");
    });

    it("a malformed JSON body answers 400 before the verb runs — route validation, unchanged by the verb refactor", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not json {",
        }),
      );
      expect(response.status).toBe(400);
      expect(mockDenyActionAsUser).not.toHaveBeenCalled();
    });

    it("works without a body (reason is optional)", async () => {
      const deniedAction = makeAction({ status: "denied" });
      mockDenyActionAsUser.mockResolvedValueOnce({ kind: "denied", entry: deniedAction });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);

      const call = mockDenyActionAsUser.mock.calls[0] as unknown as [string, unknown, string | undefined];
      expect(call[2]).toBeUndefined();
    });

    it("passes denierId from auth user", async () => {
      const deniedAction = makeAction({ status: "denied", approved_by: "u1" });
      mockDenyActionAsUser.mockResolvedValueOnce({ kind: "denied", entry: deniedAction });

      await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
        }),
      );

      const call = mockDenyActionAsUser.mock.calls[0] as unknown as [string, { user?: { id?: string } }];
      expect(call[0]).toBe(VALID_ID);
      expect(call[1].user?.id).toBe("u1");
    });

    it("returns 403 for admin-only action when denier is the requester", async () => {
      mockDenyActionAsUser.mockResolvedValueOnce({ kind: "forbidden", reason: "self_approval" });

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

  // -------------------------------------------------------------------------
  // POST /api/v1/actions/:id/rollback
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // POST /:id/redispatch (#5570)
  // -------------------------------------------------------------------------

  describe("POST /api/v1/actions/:id/redispatch", () => {
    it("returns 200 with the executed entry", async () => {
      const executed = makeAction({ status: "executed", approved_by: "u2" });
      mockRedispatchActionAsUser.mockResolvedValueOnce({ kind: "redispatched", entry: executed });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/redispatch`, { method: "POST" }),
      );

      expect(response.status).toBe(200);
      expect((await response.json() as Record<string, unknown>).status).toBe("executed");
    });

    it("passes the caller and their active workspace to the verb", async () => {
      mockRedispatchActionAsUser.mockResolvedValueOnce({
        kind: "redispatched",
        entry: makeAction({ status: "executed" }),
      });

      await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/redispatch`, { method: "POST" }),
      );

      const call = mockRedispatchActionAsUser.mock.calls[0] as unknown as [
        string,
        { user?: { id?: string }; orgId?: string | null },
      ];
      expect(call[0]).toBe(VALID_ID);
      expect(call[1].user?.id).toBe("u1");
      expect(call[1].orgId).toBe("org-u1");
    });

    it("⭐ audits the re-dispatch with the ACTION's workspace, not the caller's", async () => {
      // The row's `org_id` is where the side effect landed (ADR-0046) and the
      // caller's active org is where the decision was taken. Recording the
      // former is the whole reason this audit row exists — the action log's
      // own `executed` line names the ORIGINAL approver, so nothing else says
      // who set it in motion, or against whom.
      const executed = makeAction({ status: "executed", approved_by: "u2", org_id: "org-requester" });
      mockRedispatchActionAsUser.mockResolvedValueOnce({ kind: "redispatched", entry: executed });

      await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/redispatch`, { method: "POST" }),
      );

      expect(mockLogAdminActionAwait).toHaveBeenCalledTimes(1);
      const entry = (mockLogAdminActionAwait.mock.calls[0] as unknown as [
        { actionType: string; targetId: string; metadata: Record<string, unknown>; status?: string },
      ])[0];
      expect(entry.actionType).toBe("approval.redispatch");
      expect(entry.targetId).toBe(VALID_ID);
      expect(entry.metadata.actionOrgId).toBe("org-requester");
      expect(entry.metadata.originalApprover).toBe("u2");
      expect(entry.metadata.resultStatus).toBe("executed");
    });

    it("audits a dispatch that RAN AND FAILED, marked as a failure", async () => {
      // Still a re-dispatch that happened. Recording it is what stops the next
      // admin repeating it, and `status: failure` is what makes it findable.
      const failed = makeAction({ status: "failed", error: "target rejected it" });
      mockRedispatchActionAsUser.mockResolvedValueOnce({ kind: "redispatched", entry: failed });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/redispatch`, { method: "POST" }),
      );

      expect(response.status).toBe(200);
      const entry = (mockLogAdminActionAwait.mock.calls[0] as unknown as [
        { status?: string; metadata: Record<string, unknown> },
      ])[0];
      expect(entry.status).toBe("failure");
      expect(entry.metadata.resultStatus).toBe("failed");
    });

    it("⭐ returns 500 telling the caller NOT to retry when the audit write fails", async () => {
      // The side effect already happened and a retry is refused as a conflict,
      // so the one thing this response must not imply is "it didn't run".
      mockRedispatchActionAsUser.mockResolvedValueOnce({
        kind: "redispatched",
        entry: makeAction({ status: "executed" }),
      });
      mockLogAdminActionAwait.mockRejectedValueOnce(new Error("audit table unreachable"));

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/redispatch`, { method: "POST" }),
      );

      expect(response.status).toBe(500);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("audit_write_failed");
      expect(String(body.message)).toContain("Do NOT retry");
      expect(body.requestId).toBeDefined();
    });

    it("⭐ returns 503 — not 409 — when this instance cannot execute the type", async () => {
      // Nothing is wrong with the request and the row is untouched; this
      // DEPLOY cannot run it. A 409 would tell the caller the action had moved
      // on, which is the opposite of true.
      mockRedispatchActionAsUser.mockResolvedValueOnce({
        kind: "unregistered_type",
        entry: makeAction({ status: "approved", action_type: "webhook:post" }),
      });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/redispatch`, { method: "POST" }),
      );

      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("action_type_unavailable");
      expect(String(body.message)).toContain("webhook:post");
      // Nothing ran, so nothing to audit.
      expect(mockLogAdminActionAwait).not.toHaveBeenCalled();
    });

    it("returns 409 when the action is not awaiting dispatch, and does NOT say \"already resolved\"", async () => {
      // A re-dispatch conflict is not the approve/deny one: the row may be
      // pending (never resolved at all), or claimed by a concurrent
      // dispatcher. Reusing "already resolved" would send an admin looking for
      // a resolution that has not happened.
      mockRedispatchActionAsUser.mockResolvedValueOnce({ kind: "conflict" });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/redispatch`, { method: "POST" }),
      );

      expect(response.status).toBe(409);
      const body = (await response.json()) as Record<string, unknown>;
      expect(String(body.message)).toContain("not awaiting dispatch");
      expect(mockLogAdminActionAwait).not.toHaveBeenCalled();
    });

    it("returns 403 when the caller does not clear the approve bar", async () => {
      mockRedispatchActionAsUser.mockResolvedValueOnce({ kind: "forbidden", reason: "role" });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/redispatch`, { method: "POST" }),
      );

      expect(response.status).toBe(403);
    });

    it("returns 403 when the requester tries to re-dispatch their own admin-only action", async () => {
      mockRedispatchActionAsUser.mockResolvedValueOnce({ kind: "forbidden", reason: "self_approval" });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/redispatch`, { method: "POST" }),
      );

      expect(response.status).toBe(403);
      // The verb in the message is this route's, not the approve route's.
      const body = (await response.json()) as Record<string, unknown>;
      expect(String(body.message)).toContain("re-dispatched");
    });

    it("returns 404 for an unknown action", async () => {
      mockRedispatchActionAsUser.mockResolvedValueOnce({ kind: "not_found" });

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/redispatch`, { method: "POST" }),
      );

      expect(response.status).toBe(404);
    });

    it("returns 400 for a malformed id, without reaching the verb", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions/not-a-uuid/redispatch", { method: "POST" }),
      );

      expect(response.status).toBe(400);
      expect(mockRedispatchActionAsUser).not.toHaveBeenCalled();
    });

    it("returns 404 when no internal database is configured", async () => {
      delete process.env.DATABASE_URL;

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/redispatch`, { method: "POST" }),
      );

      expect(response.status).toBe(404);
      expect(mockRedispatchActionAsUser).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/actions/:id/rollback", () => {
    it("returns 200 on successful rollback", async () => {
      const action = makeAction({
        status: "executed",
        rollback_info: { method: "transition", params: { issueKey: "PROJ-1" } },
      });
      const rolledBack = makeAction({
        status: "rolled_back" as ActionLogEntry["status"],
        resolved_at: "2024-06-01T02:00:00Z",
        rollback_info: { method: "transition", params: { issueKey: "PROJ-1" } },
      });
      mockGetAction.mockResolvedValueOnce(action);
      mockRollbackAction.mockResolvedValueOnce(rolledBack);

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/rollback`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.status).toBe("rolled_back");
    });

    it("returns 409 when action has no rollback_info", async () => {
      const action = makeAction({ status: "executed", rollback_info: null });
      mockGetAction.mockResolvedValueOnce(action);

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/rollback`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(409);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("conflict");
    });

    it("returns 409 when rollbackAction returns null (wrong state)", async () => {
      const action = makeAction({
        status: "executed",
        rollback_info: { method: "transition", params: { issueKey: "PROJ-1" } },
      });
      mockGetAction.mockResolvedValueOnce(action);
      mockRollbackAction.mockResolvedValueOnce(null);

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/rollback`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(409);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("conflict");
    });

    it("returns 404 when action not found", async () => {
      mockGetAction.mockResolvedValueOnce(null);

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/rollback`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(404);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("not_found");
    });

    it("returns 400 for invalid UUID", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions/not-a-uuid/rollback", {
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
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/rollback`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(404);
    });

    it("returns 403 when user lacks permission", async () => {
      const action = makeAction({
        status: "executed",
        rollback_info: { method: "transition", params: { issueKey: "PROJ-1" } },
      });
      mockGetAction.mockResolvedValueOnce(action);
      mockGetActionConfig.mockReturnValueOnce({ approval: "admin-only" });

      // User with simple-key mode defaults to admin role, which can't approve admin-only (requires owner)
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/rollback`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(403);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("forbidden");
    });

    it("passes rollbackerId from auth user to rollbackAction", async () => {
      const action = makeAction({
        status: "executed",
        rollback_info: { method: "transition", params: { issueKey: "PROJ-1" } },
      });
      const rolledBack = makeAction({ status: "rolled_back" as ActionLogEntry["status"] });
      mockGetAction.mockResolvedValueOnce(action);
      mockRollbackAction.mockResolvedValueOnce(rolledBack);

      await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/rollback`, {
          method: "POST",
        }),
      );

      expect(mockRollbackAction).toHaveBeenCalledTimes(1);
      const call = mockRollbackAction.mock.calls[0] as unknown as [string, string];
      expect(call[0]).toBe(VALID_ID);
      expect(call[1]).toBe("u1");
    });

    it("returns 500 when rollbackAction throws", async () => {
      const action = makeAction({
        status: "executed",
        rollback_info: { method: "transition", params: { issueKey: "PROJ-1" } },
      });
      mockGetAction.mockResolvedValueOnce(action);
      mockRollbackAction.mockRejectedValueOnce(new Error("DB crashed"));

      const response = await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/rollback`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(500);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/actions/bulk
  // -------------------------------------------------------------------------

  describe("POST /api/v1/actions/bulk", () => {
    const VALID_ID_2 = "b2c3d4e5-f6a7-8901-bcde-f23456789012";

    it("returns 200 with aggregated buckets on successful approve", async () => {
      mockBulkApproveActions.mockResolvedValueOnce({
        updated: [VALID_ID, VALID_ID_2],
        notFound: [],
        forbidden: [],
        errors: [],
      });

      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [VALID_ID, VALID_ID_2], action: "approve" }),
        }),
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as BulkResult;
      expect(body.updated).toEqual([VALID_ID, VALID_ID_2]);
      expect(body.notFound).toEqual([]);
      expect(body.forbidden).toEqual([]);
      expect(body.errors).toEqual([]);
    });

    it("returns 200 with partial-failure buckets for deny", async () => {
      mockBulkDenyActions.mockResolvedValueOnce({
        updated: [VALID_ID],
        notFound: [VALID_ID_2],
        forbidden: [],
        errors: [],
      });

      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ids: [VALID_ID, VALID_ID_2],
            action: "deny",
            reason: "Not approved",
          }),
        }),
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as BulkResult;
      expect(body.updated).toEqual([VALID_ID]);
      expect(body.notFound).toEqual([VALID_ID_2]);
      expect(mockBulkDenyActions).toHaveBeenCalledTimes(1);

      const call = mockBulkDenyActions.mock.calls[0] as unknown as [{ ids: string[]; reason?: string; user?: { id: string }; requestId?: string }];
      expect(call[0].ids).toEqual([VALID_ID, VALID_ID_2]);
      expect(call[0].reason).toBe("Not approved");
      expect(call[0].user?.id).toBe("u1");
      expect(call[0].requestId).toEqual(expect.any(String));
    });

    it("dispatches to bulkApproveActions when action is 'approve'", async () => {
      await app.fetch(
        new Request("http://localhost/api/v1/actions/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [VALID_ID], action: "approve" }),
        }),
      );
      expect(mockBulkApproveActions).toHaveBeenCalledTimes(1);
      expect(mockBulkDenyActions).not.toHaveBeenCalled();
    });

    it("returns 400 when ids is empty", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [], action: "approve" }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it("returns 400 when ids exceeds the bulk cap", async () => {
      const tooMany = Array.from({ length: 101 }, (_, i) => {
        const hex = i.toString(16).padStart(12, "0");
        return `00000000-0000-0000-0000-${hex}`;
      });

      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: tooMany, action: "approve" }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it("returns 400 when any id is malformed", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: ["not-a-uuid"], action: "approve" }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it("returns 400 when reason exceeds the length cap", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ids: [VALID_ID],
            action: "deny",
            reason: "x".repeat(1001),
          }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it("returns 400 when action value is invalid", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [VALID_ID], action: "wiggle" }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it("returns 400 when body is malformed JSON", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{ not valid",
        }),
      );
      expect(response.status).toBe(400);
    });

    it("returns 404 when no internal DB", async () => {
      delete process.env.DATABASE_URL;

      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [VALID_ID], action: "approve" }),
        }),
      );
      expect(response.status).toBe(404);
    });

    it("returns 401 when unauthenticated", async () => {
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: false as const,
        mode: "simple-key" as const,
        status: 401 as const,
        error: "API key required",
      });

      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [VALID_ID], action: "approve" }),
        }),
      );
      expect(response.status).toBe(401);
    });

    it("returns 500 with requestId when the service throws", async () => {
      mockBulkApproveActions.mockRejectedValueOnce(new Error("DB blew up"));

      const response = await app.fetch(
        new Request("http://localhost/api/v1/actions/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [VALID_ID], action: "approve" }),
        }),
      );
      expect(response.status).toBe(500);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
      expect(body.requestId).toEqual(expect.any(String));
    });

    it("passes orgId from auth.activeOrganizationId to the service", async () => {
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: true as const,
        mode: "simple-key" as const,
        user: {
          id: "u1",
          label: "test@test.com",
          mode: "simple-key" as const,
          activeOrganizationId: "org-42",
        },
      });

      await app.fetch(
        new Request("http://localhost/api/v1/actions/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [VALID_ID], action: "approve" }),
        }),
      );

      const call = mockBulkApproveActions.mock.calls[0] as unknown as [{ orgId?: string | null }];
      expect(call[0].orgId).toBe("org-42");
    });
  });

  // -----------------------------------------------------------------------
  // Route-layer orgId scoping (F-12) — regression guard for the single-action
  // endpoints. A refactor that drops `user?.activeOrganizationId` at any call
  // site silently regresses the security invariant; these tests catch it.
  // -----------------------------------------------------------------------

  describe("route-layer orgId scoping (F-12)", () => {
    it("GET / forwards orgId to listPendingActions", async () => {
      await app.fetch(new Request("http://localhost/api/v1/actions?status=pending"));
      const call = mockListPendingActions.mock.calls[0] as unknown as [{ orgId?: string | null }];
      expect(call[0].orgId).toBe("org-u1");
    });

    it("GET /:id forwards orgId to getAction", async () => {
      mockGetAction.mockResolvedValueOnce(makeAction({ requested_by: "u1" }));
      await app.fetch(new Request(`http://localhost/api/v1/actions/${VALID_ID}`));
      const call = mockGetAction.mock.calls[0] as unknown as [string, string | undefined];
      expect(call[0]).toBe(VALID_ID);
      expect(call[1]).toBe("org-u1");
    });

    it("POST /:id/approve forwards orgId to the verb", async () => {
      mockApproveActionAsUser.mockResolvedValueOnce({
        kind: "approved",
        entry: makeAction({ status: "executed" }),
      });

      await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/approve`, {
          method: "POST",
        }),
      );
      const call = mockApproveActionAsUser.mock.calls[0] as unknown as [string, { orgId?: string | null }];
      expect(call[1].orgId).toBe("org-u1");
    });

    it("POST /:id/deny forwards orgId to the verb", async () => {
      mockDenyActionAsUser.mockResolvedValueOnce({ kind: "denied", entry: makeAction({ status: "denied" }) });

      await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/deny`, {
          method: "POST",
        }),
      );
      const denyCall = mockDenyActionAsUser.mock.calls[0] as unknown as [string, { orgId?: string | null }];
      expect(denyCall[1].orgId).toBe("org-u1");
    });

    it("POST /:id/rollback forwards orgId to getAction and rollbackAction", async () => {
      mockGetAction.mockResolvedValueOnce(
        makeAction({
          status: "executed",
          rollback_info: { method: "test", params: {} },
          requested_by: "other-user",
        }),
      );
      mockRollbackAction.mockResolvedValueOnce(makeAction({ status: "rolled_back" }));

      await app.fetch(
        new Request(`http://localhost/api/v1/actions/${VALID_ID}/rollback`, {
          method: "POST",
        }),
      );
      const getCall = mockGetAction.mock.calls[0] as unknown as [string, string | undefined];
      expect(getCall[1]).toBe("org-u1");
      const rollbackCall = mockRollbackAction.mock.calls[0] as unknown as [string, string, string | undefined];
      expect(rollbackCall[2]).toBe("org-u1");
    });
  });
});
