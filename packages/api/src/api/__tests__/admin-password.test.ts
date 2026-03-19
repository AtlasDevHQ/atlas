/**
 * Tests for password-status and password-change endpoints.
 *
 * Covers GET /me/password-status and POST /me/password in admin routes.
 * These endpoints use "light auth" (no admin role required) — any
 * authenticated managed-auth user can access them.
 */

import { createConnectionMock } from "@atlas/api/testing/connection";
import {
  describe,
  it,
  expect,
  beforeEach,
  mock,
  type Mock,
} from "bun:test";

// --- Mocks (before any import that touches the modules) ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: { id: "user-1", mode: "managed", label: "User", role: "member" },
    }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  _stopCleanup: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "managed",
  resetAuthModeCache: () => {},
}));

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: mock(() => []),
}));

mock.module("@atlas/api/lib/db/connection", () => createConnectionMock());

mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(["companies"]),
  getCrossSourceJoins: () => [],
  _resetWhitelists: () => {},
  registerPluginEntities: () => {},
  _resetPluginEntities: () => {},
}));

let mockHasInternalDB = true;
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  () => Promise.resolve([]),
);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: mockInternalQuery,
  internalExecute: mock(() => {}),
  getInternalDB: mock(() => ({})),
  closeInternalDB: mock(async () => {}),
  migrateInternalDB: mock(async () => {}),
  loadSavedConnections: mock(async () => 0),
  _resetPool: mock(() => {}),
  _resetCircuitBreaker: mock(() => {}),
  encryptUrl: (url: string) => url,
  decryptUrl: (url: string) => url,
  getEncryptionKey: () => null,
  isPlaintextUrl: (value: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value),
  _resetEncryptionKeyCache: mock(() => {}),
  findPatternBySQL: async () => null,
  insertLearnedPattern: () => {},
  incrementPatternCount: () => {},
  getApprovedPatterns: mock(async () => []),
  upsertSuggestion: mock(() => Promise.resolve("created")),
  getSuggestionsByTables: mock(() => Promise.resolve([])),
  getPopularSuggestions: mock(() => Promise.resolve([])),
  incrementSuggestionClick: mock(),
  deleteSuggestion: mock(() => Promise.resolve(false)),
  getAuditLogQueries: mock(() => Promise.resolve([])),
}));

mock.module("@atlas/api/lib/learn/pattern-cache", () => ({
  buildLearnedPatternsSection: async () => "",
  getRelevantPatterns: async () => [],
  invalidatePatternCache: () => {},
  extractKeywords: () => new Set(),
  _resetPatternCache: () => {},
}));

mock.module("@atlas/api/lib/db/semantic-entities", () => ({
  listEntities: mock(() => Promise.resolve([])),
  getEntity: mock(() => Promise.resolve(null)),
  upsertEntity: mock(() => Promise.resolve()),
  deleteEntity: mock(() => Promise.resolve(false)),
  countEntities: mock(() => Promise.resolve(0)),
  bulkUpsertEntities: mock(() => Promise.resolve(0)),
}));

mock.module("@atlas/api/lib/plugins/registry", () => ({
  plugins: {
    describe: () => [],
    get: () => undefined,
    getStatus: () => undefined,
    getAllHealthy: () => [],
    getByType: () => [],
    size: 0,
  },
  PluginRegistry: class {},
}));

mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
  explore: { type: "function" },
}));

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(() =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      text: Promise.resolve("answer"),
    }),
  ),
}));

mock.module("@atlas/api/lib/tools/actions", () => ({}));
mock.module("@atlas/api/lib/semantic-diff", () => ({
  runDiff: mock(() => Promise.resolve({})),
  mapSQLType: (t: string) => t,
  parseEntityYAML: () => ({ table: "", columns: new Map(), foreignKeys: new Set() }),
  computeDiff: () => ({ newTables: [], removedTables: [], tableDiffs: [], unchangedCount: 0 }),
  getDBSchema: async () => new Map(),
  getYAMLSnapshots: () => ({ snapshots: new Map(), warnings: [] }),
}));

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mock(() => Promise.resolve(null)),
  addMessage: mock(() => {}),
  getConversation: mock(() => Promise.resolve(null)),
  generateTitle: mock((q: string) => q.slice(0, 80)),
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  deleteConversation: mock(() => Promise.resolve(false)),
  starConversation: async () => false,
  shareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  unshareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  getShareStatus: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  cleanupExpiredShares: mock(() => Promise.resolve(0)),
  getSharedConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  updateNotebookState: mock(() => Promise.resolve({ ok: true })),
  forkConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
}));

// Mock auth/server for the password-change dynamic import
const mockChangePassword: Mock<(opts: unknown) => Promise<unknown>> = mock(() =>
  Promise.resolve({}),
);

mock.module("@atlas/api/lib/auth/server", () => ({
  getAuthInstance: () => ({
    api: { changePassword: mockChangePassword },
  }),
  resetAuthInstance: mock(() => {}),
  _setAuthInstance: mock(() => {}),
}));

// Import app after all mocks are registered
const { app } = await import("../index");

// --- Helpers ---

function req(urlPath: string, method = "GET", body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: { Authorization: "Bearer test-key" },
  };
  if (body) {
    opts.headers = { ...opts.headers, "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${urlPath}`, opts);
}

function setManagedUser(overrides?: Record<string, unknown>): void {
  mockAuthenticateRequest.mockResolvedValue({
    authenticated: true,
    mode: "managed",
    user: { id: "user-1", mode: "managed", label: "User", role: "member", ...overrides },
  });
}

// ---------------------------------------------------------------------------
// GET /me/password-status
// ---------------------------------------------------------------------------

describe("GET /api/v1/admin/me/password-status", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    mockInternalQuery.mockReset();
    mockHasInternalDB = true;
    setManagedUser();
  });

  it("returns true when password_change_required is set", async () => {
    mockInternalQuery.mockResolvedValue([{ password_change_required: true }]);

    const res = await app.fetch(req("/api/v1/admin/me/password-status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { passwordChangeRequired: boolean };
    expect(body.passwordChangeRequired).toBe(true);
  });

  it("returns false when password_change_required is not set", async () => {
    mockInternalQuery.mockResolvedValue([{ password_change_required: false }]);

    const res = await app.fetch(req("/api/v1/admin/me/password-status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { passwordChangeRequired: boolean };
    expect(body.passwordChangeRequired).toBe(false);
  });

  it("returns false for non-managed auth (simple-key mode)", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true,
      mode: "simple-key",
      user: { id: "user-1", mode: "simple-key", label: "User", role: "member" },
    });

    const res = await app.fetch(req("/api/v1/admin/me/password-status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { passwordChangeRequired: boolean };
    expect(body.passwordChangeRequired).toBe(false);
  });

  it("returns false when no internal DB is available", async () => {
    mockHasInternalDB = false;

    const res = await app.fetch(req("/api/v1/admin/me/password-status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { passwordChangeRequired: boolean };
    expect(body.passwordChangeRequired).toBe(false);
  });

  it("returns false when user row not found in DB", async () => {
    mockInternalQuery.mockResolvedValue([]);

    const res = await app.fetch(req("/api/v1/admin/me/password-status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { passwordChangeRequired: boolean };
    expect(body.passwordChangeRequired).toBe(false);
  });

  it("returns 500 on DB error (security fix: never silently bypass)", async () => {
    mockInternalQuery.mockRejectedValue(new Error("connection refused"));

    const res = await app.fetch(req("/api/v1/admin/me/password-status"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_error");
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: false,
      mode: "managed",
      status: 401,
      error: "No session found",
    });

    const res = await app.fetch(req("/api/v1/admin/me/password-status"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("auth_error");
    expect(body.message).toBe("No session found");
  });

  it("returns 500 when authenticateRequest throws", async () => {
    mockAuthenticateRequest.mockRejectedValue(new Error("auth system down"));

    const res = await app.fetch(req("/api/v1/admin/me/password-status"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("auth_error");
  });
});

// ---------------------------------------------------------------------------
// POST /me/password
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/me/password", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    mockInternalQuery.mockReset();
    mockChangePassword.mockReset();
    mockHasInternalDB = true;
    setManagedUser();
    mockChangePassword.mockResolvedValue({});
    mockInternalQuery.mockResolvedValue([]);
  });

  it("changes password and clears flag on success", async () => {
    const res = await app.fetch(
      req("/api/v1/admin/me/password", "POST", {
        currentPassword: "OldPass123",
        newPassword: "NewPass456",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    // Verify changePassword was called with the right args
    expect(mockChangePassword).toHaveBeenCalledTimes(1);
    const callArgs = (mockChangePassword.mock.calls as unknown[][])[0]?.[0] as Record<string, unknown>;
    expect((callArgs.body as Record<string, string>).currentPassword).toBe("OldPass123");
    expect((callArgs.body as Record<string, string>).newPassword).toBe("NewPass456");

    // Verify the password_change_required flag was cleared
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const sqlCall = (mockInternalQuery.mock.calls as unknown[][])[0];
    expect((sqlCall?.[0] as string)).toContain("password_change_required = false");
  });

  it("returns 400 when current password is wrong", async () => {
    mockChangePassword.mockRejectedValue(new Error("incorrect password"));

    const res = await app.fetch(
      req("/api/v1/admin/me/password", "POST", {
        currentPassword: "WrongPass",
        newPassword: "NewPass456",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_request");
    expect(body.message).toBe("Current password is incorrect.");
  });

  it("returns 400 when fields are missing", async () => {
    const res = await app.fetch(
      req("/api/v1/admin/me/password", "POST", { currentPassword: "OldPass123" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("returns 400 when body is empty", async () => {
    const res = await app.fetch(req("/api/v1/admin/me/password", "POST", {}));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("returns 400 when new password is too short", async () => {
    const res = await app.fetch(
      req("/api/v1/admin/me/password", "POST", {
        currentPassword: "OldPass123",
        newPassword: "short",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_request");
    expect(body.message).toContain("8 characters");
  });

  it("returns 404 for non-managed auth mode", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true,
      mode: "simple-key",
      user: { id: "user-1", mode: "simple-key", label: "User", role: "member" },
    });

    const res = await app.fetch(
      req("/api/v1/admin/me/password", "POST", {
        currentPassword: "OldPass123",
        newPassword: "NewPass456",
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_available");
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: false,
      mode: "managed",
      status: 401,
      error: "No session found",
    });

    const res = await app.fetch(
      req("/api/v1/admin/me/password", "POST", {
        currentPassword: "OldPass123",
        newPassword: "NewPass456",
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("auth_error");
    expect(body.message).toBe("No session found");
  });

  it("returns 500 on non-password-related changePassword error", async () => {
    mockChangePassword.mockRejectedValue(new Error("database connection failed"));

    const res = await app.fetch(
      req("/api/v1/admin/me/password", "POST", {
        currentPassword: "OldPass123",
        newPassword: "NewPass456",
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_error");
  });

  it("succeeds even without internal DB (flag clear skipped)", async () => {
    mockHasInternalDB = false;

    const res = await app.fetch(
      req("/api/v1/admin/me/password", "POST", {
        currentPassword: "OldPass123",
        newPassword: "NewPass456",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    // internalQuery should NOT be called when no internal DB
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns 400 on malformed JSON body", async () => {
    const request = new Request("http://localhost/api/v1/admin/me/password", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: "not json",
    });

    const res = await app.fetch(request);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("returns 500 when authenticateRequest throws", async () => {
    mockAuthenticateRequest.mockRejectedValue(new Error("auth system down"));

    const res = await app.fetch(
      req("/api/v1/admin/me/password", "POST", {
        currentPassword: "OldPass123",
        newPassword: "NewPass456",
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("auth_error");
  });

  it("returns 500 if flag-clear fails after successful password change", async () => {
    mockInternalQuery.mockRejectedValue(new Error("disk full"));

    const res = await app.fetch(
      req("/api/v1/admin/me/password", "POST", {
        currentPassword: "OldPass123",
        newPassword: "NewPass456",
      }),
    );
    // Password was changed in auth system but flag clear failed
    expect(mockChangePassword).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_error");
  });

  it("returns 400 when error contains 'invalid' keyword", async () => {
    mockChangePassword.mockRejectedValue(new Error("invalid credentials"));

    const res = await app.fetch(
      req("/api/v1/admin/me/password", "POST", {
        currentPassword: "WrongPass",
        newPassword: "NewPass456",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.message).toBe("Current password is incorrect.");
  });
});
