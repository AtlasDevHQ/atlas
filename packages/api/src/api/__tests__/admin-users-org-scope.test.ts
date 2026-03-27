/**
 * Tests for org-scoped user write operations (#983).
 *
 * Verifies that workspace admins can only modify (role change, ban, unban,
 * delete, revoke sessions) users within their own organization. Platform
 * admins bypass the check. Returns 404 (not 403) when the target user is
 * not in the caller's org to avoid revealing existence across tenants.
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
      user: { id: "admin-1", mode: "managed", label: "Admin", role: "admin", activeOrganizationId: "org-1" },
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

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock(),
);

mock.module("@atlas/api/lib/cache", () => ({
  getCache: mock(() => ({ get: () => null, set: () => {}, delete: () => false, flush: () => {}, stats: () => ({}) })),
  cacheEnabled: mock(() => true),
  setCacheBackend: mock(() => {}),
  flushCache: mock(() => {}),
  getDefaultTtl: mock(() => 300000),
  _resetCache: mock(() => {}),
  buildCacheKey: mock(() => "mock-key"),
}));

mock.module("@atlas/api/lib/workspace", () => ({
  checkWorkspaceStatus: mock(async () => ({ allowed: true })),
}));

// --- Internal DB mock ---

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
  getWorkspaceStatus: mock(async () => "active"),
  getWorkspaceDetails: mock(async () => null),
  updateWorkspaceStatus: mock(async () => true),
  updateWorkspacePlanTier: mock(async () => true),
  cascadeWorkspaceDelete: mock(async () => ({ conversations: 0, semanticEntities: 0, learnedPatterns: 0, suggestions: 0, scheduledTasks: 0 })),
  getWorkspaceHealthSummary: mock(async () => null),
}));

mock.module("@atlas/api/lib/learn/pattern-cache", () => ({
  buildLearnedPatternsSection: async () => "",
  getRelevantPatterns: async () => [],
  invalidatePatternCache: () => {},
  extractKeywords: () => new Set(),
  _resetPatternCache: () => {},
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
  getCrossSourceJoins: () => [],
  _resetWhitelists: () => {},
  registerPluginEntities: () => {},
  _resetPluginEntities: () => {},
}));

mock.module("@atlas/api/lib/semantic/entities", () => ({
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
  runAgent: mock(() => Promise.resolve({ text: "answer" })),
}));

mock.module("@atlas/api/lib/tools/actions", () => ({}));

mock.module("@atlas/api/lib/security", () => ({
  maskConnectionUrl: (_url: string) => "***masked***",
  SENSITIVE_PATTERNS: [],
}));

mock.module("@atlas/api/lib/settings", () => ({
  getSettingsForAdmin: mock(() => []),
  getSettingsRegistry: mock(() => []),
  setSetting: mock(async () => {}),
  deleteSetting: mock(async () => {}),
  getSetting: mock(() => undefined),
  loadSettings: mock(async () => 0),
  getAllSettingOverrides: mock(async () => []),
  _resetSettingsCache: mock(() => {}),
}));

mock.module("@atlas/api/lib/plugins/settings", () => ({
  savePluginEnabled: mock(async () => {}),
  savePluginConfig: mock(async () => {}),
  getPluginConfig: mock(async () => null),
}));

mock.module("@atlas/api/lib/semantic/diff", () => ({
  runDiff: mock(async () => ({ connection: "default", newTables: [], removedTables: [], tableDiffs: [] })),
}));

// Mock Better Auth admin API
const mockSetRole: Mock<(opts: unknown) => Promise<unknown>> = mock(() => Promise.resolve({}));
const mockBanUser: Mock<(opts: unknown) => Promise<unknown>> = mock(() => Promise.resolve({}));
const mockUnbanUser: Mock<(opts: unknown) => Promise<unknown>> = mock(() => Promise.resolve({}));
const mockRemoveUser: Mock<(opts: unknown) => Promise<unknown>> = mock(() => Promise.resolve({}));
const mockRevokeSessions: Mock<(opts: unknown) => Promise<unknown>> = mock(() => Promise.resolve({}));

mock.module("@atlas/api/lib/auth/server", () => ({
  getAuthInstance: () => ({
    api: {
      listUsers: mock(() => Promise.resolve({ users: [], total: 0 })),
      setRole: mockSetRole,
      banUser: mockBanUser,
      unbanUser: mockUnbanUser,
      removeUser: mockRemoveUser,
      revokeSessions: mockRevokeSessions,
    },
  }),
}));

// --- Import app after mocks ---

const { app } = await import("../index");

// --- Helpers ---

function adminRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
  };
  if (body) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

/** Set auth to a workspace admin in org-1 (non-platform). */
function setWorkspaceAdmin(orgId = "org-1"): void {
  mockAuthenticateRequest.mockResolvedValue({
    authenticated: true,
    mode: "managed",
    user: { id: "admin-1", mode: "managed", label: "Admin", role: "admin", activeOrganizationId: orgId },
  });
}

/** Set auth to a platform admin (no org boundary). */
function setPlatformAdmin(): void {
  mockAuthenticateRequest.mockResolvedValue({
    authenticated: true,
    mode: "managed",
    user: { id: "platform-1", mode: "managed", label: "Platform Admin", role: "platform_admin" },
  });
}

/**
 * Configure mockInternalQuery to return membership results.
 * When the member lookup query is called for `allowedUserId` in org, it returns a row.
 * All other member lookups return empty (user not in org).
 */
function mockMembershipFor(allowedUserId: string): void {
  mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    // Match the verifyOrgMembership query
    if (sql.includes("member") && sql.includes("userId") && sql.includes("organizationId")) {
      const targetId = params?.[0];
      if (targetId === allowedUserId) {
        return [{ userId: allowedUserId }];
      }
      return [];
    }
    // Default: return empty for any other query (IP allowlist, admin count, etc.)
    return [];
  });
}

// --- Tests ---

describe("Org-scoped user write operations (#983)", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    mockInternalQuery.mockReset();
    mockInternalQuery.mockResolvedValue([]);
    mockSetRole.mockClear();
    mockBanUser.mockClear();
    mockUnbanUser.mockClear();
    mockRemoveUser.mockClear();
    mockRevokeSessions.mockClear();
    mockHasInternalDB = true;
  });

  describe("PATCH /api/v1/admin/users/:id/role", () => {
    it("returns 404 when target user is not in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/user-in-org-2/role", { role: "member" }),
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("not_found");
      expect(mockSetRole).not.toHaveBeenCalled();
    });

    it("allows role change when target user is in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/user-in-org-1/role", { role: "member" }),
      );
      expect(res.status).toBe(200);
      expect(mockSetRole).toHaveBeenCalled();
    });

    it("platform admin can change role for any user regardless of org", async () => {
      setPlatformAdmin();

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/user-in-any-org/role", { role: "member" }),
      );
      expect(res.status).toBe(200);
      expect(mockSetRole).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/admin/users/:id/ban", () => {
    it("returns 404 when target user is not in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-org-2/ban", {}),
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("not_found");
      expect(mockBanUser).not.toHaveBeenCalled();
    });

    it("allows ban when target user is in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-org-1/ban", {}),
      );
      expect(res.status).toBe(200);
      expect(mockBanUser).toHaveBeenCalled();
    });

    it("platform admin can ban any user", async () => {
      setPlatformAdmin();

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-any-org/ban", {}),
      );
      expect(res.status).toBe(200);
      expect(mockBanUser).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/admin/users/:id/unban", () => {
    it("returns 404 when target user is not in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-org-2/unban", {}),
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("not_found");
      expect(mockUnbanUser).not.toHaveBeenCalled();
    });

    it("allows unban when target user is in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-org-1/unban", {}),
      );
      expect(res.status).toBe(200);
      expect(mockUnbanUser).toHaveBeenCalled();
    });

    it("platform admin can unban any user", async () => {
      setPlatformAdmin();

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-any-org/unban", {}),
      );
      expect(res.status).toBe(200);
      expect(mockUnbanUser).toHaveBeenCalled();
    });
  });

  describe("DELETE /api/v1/admin/users/:id", () => {
    it("returns 404 when target user is not in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/user-in-org-2"),
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("not_found");
      expect(mockRemoveUser).not.toHaveBeenCalled();
    });

    it("allows delete when target user is in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/user-in-org-1"),
      );
      expect(res.status).toBe(200);
      expect(mockRemoveUser).toHaveBeenCalled();
    });

    it("platform admin can delete any user", async () => {
      setPlatformAdmin();

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/user-in-any-org"),
      );
      expect(res.status).toBe(200);
      expect(mockRemoveUser).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/admin/users/:id/revoke", () => {
    it("returns 404 when target user is not in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-org-2/revoke"),
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("not_found");
      expect(mockRevokeSessions).not.toHaveBeenCalled();
    });

    it("allows session revocation when target user is in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-org-1/revoke"),
      );
      expect(res.status).toBe(200);
      expect(mockRevokeSessions).toHaveBeenCalled();
    });

    it("platform admin can revoke sessions for any user", async () => {
      setPlatformAdmin();

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-any-org/revoke"),
      );
      expect(res.status).toBe(200);
      expect(mockRevokeSessions).toHaveBeenCalled();
    });
  });

  describe("DELETE /api/v1/admin/sessions/user/:userId", () => {
    it("returns 404 when target user is not in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/sessions/user/user-in-org-2"),
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("not_found");
    });

    it("allows session deletion when target user is in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/sessions/user/user-in-org-1"),
      );
      // 200 or 404 (no sessions found) — both are acceptable, not a cross-org leak
      expect([200, 404]).toContain(res.status);
    });
  });

  describe("self-hosted (no org context)", () => {
    it("allows role change without org scoping when no activeOrganizationId", async () => {
      // Self-hosted: no org context
      mockAuthenticateRequest.mockResolvedValue({
        authenticated: true,
        mode: "managed",
        user: { id: "admin-1", mode: "managed", label: "Admin", role: "admin" },
      });

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/any-user/role", { role: "member" }),
      );
      expect(res.status).toBe(200);
      expect(mockSetRole).toHaveBeenCalled();
    });
  });

  describe("DB error in membership check", () => {
    it("returns 500 when internalQuery throws during org membership check", async () => {
      setWorkspaceAdmin("org-1");
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("member") && sql.includes("userId") && sql.includes("organizationId")) {
          throw new Error("DB connection timeout");
        }
        return [];
      });

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/any-user/role", { role: "member" }),
      );
      // Should fail closed — 500, not 200
      expect(res.status).toBe(500);
      expect(mockSetRole).not.toHaveBeenCalled();
    });
  });

  describe("hasInternalDB = false bypass", () => {
    it("bypasses membership check when no internal DB is available", async () => {
      setWorkspaceAdmin("org-1");
      mockHasInternalDB = false;

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/any-user/role", { role: "member" }),
      );
      expect(res.status).toBe(200);
      expect(mockSetRole).toHaveBeenCalled();
    });
  });
});
