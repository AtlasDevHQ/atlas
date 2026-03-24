/**
 * Tests for admin usage metering API endpoints.
 *
 * Covers: GET /admin/usage, GET /admin/usage/history, GET /admin/usage/breakdown.
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
      mode: "simple-key",
      user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: "org-1" },
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
  detectAuthMode: () => "simple-key",
  resetAuthModeCache: () => {},
}));

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: mock(() => []),
}));

mock.module("@atlas/api/lib/db/connection", () => createConnectionMock());

// --- Metering mock ---

const mockCurrentUsage = {
  queryCount: 42,
  tokenCount: 10000,
  activeUsers: 3,
  periodStart: "2026-03-01T00:00:00.000Z",
  periodEnd: "2026-04-01T00:00:00.000Z",
};

const mockHistorySummaries: unknown[] = [
  { id: "s-1", workspace_id: "org-1", period: "monthly", period_start: "2026-02-01", query_count: 100, token_count: 5000, active_users: 5, storage_bytes: 0, updated_at: "2026-02-28" },
];

const mockBreakdownUsers: unknown[] = [
  { user_id: "u-1", query_count: 30, token_count: 2000, login_count: 5 },
  { user_id: "u-2", query_count: 12, token_count: 800, login_count: 2 },
];

const mockGetCurrentPeriodUsage: Mock<(workspaceId: string) => Promise<unknown>> = mock(
  () => Promise.resolve({ ...mockCurrentUsage }),
);

const mockGetUsageHistory: Mock<(...args: unknown[]) => Promise<unknown[]>> = mock(
  () => Promise.resolve([...mockHistorySummaries]),
);

const mockGetUsageBreakdown: Mock<(...args: unknown[]) => Promise<unknown[]>> = mock(
  () => Promise.resolve([...mockBreakdownUsers]),
);

const mockAggregateUsageSummary: Mock<(...args: unknown[]) => Promise<void>> = mock(
  () => Promise.resolve(),
);

mock.module("@atlas/api/lib/metering", () => ({
  getCurrentPeriodUsage: mockGetCurrentPeriodUsage,
  getUsageHistory: mockGetUsageHistory,
  getUsageBreakdown: mockGetUsageBreakdown,
  aggregateUsageSummary: mockAggregateUsageSummary,
  logUsageEvent: mock(() => {}),
}));

// --- Internal DB mock ---

let mockHasInternalDB = true;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: mock(() => Promise.resolve([])),
  internalExecute: mock(() => {}),
  getInternalDB: mock(() => ({})),
  closeInternalDB: mock(() => Promise.resolve()),
  migrateInternalDB: mock(() => Promise.resolve()),
  loadSavedConnections: mock(() => Promise.resolve(0)),
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
  getWorkspaceStatus: mock(() => Promise.resolve(null)),
  getWorkspaceDetails: mock(() => Promise.resolve(null)),
  updateWorkspaceStatus: mock(() => Promise.resolve(false)),
  updateWorkspacePlanTier: mock(() => Promise.resolve(false)),
  cascadeWorkspaceDelete: mock(() => Promise.resolve({})),
  getWorkspaceHealthSummary: mock(() => Promise.resolve(null)),
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

// --- Import app after mocks ---

const { app } = await import("../index");

// --- Helper ---

function adminRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
  };
  if (body) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

// --- Tests ---

describe("Admin Usage API", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: "org-1" },
      }),
    );
    mockGetCurrentPeriodUsage.mockImplementation(() => Promise.resolve({ ...mockCurrentUsage }));
    mockGetUsageHistory.mockImplementation(() => Promise.resolve([...mockHistorySummaries]));
    mockGetUsageBreakdown.mockImplementation(() => Promise.resolve([...mockBreakdownUsers]));
    mockAggregateUsageSummary.mockImplementation(() => Promise.resolve());
  });

  // --- GET /api/v1/admin/usage ---

  describe("GET /api/v1/admin/usage", () => {
    it("returns current period usage", async () => {
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/usage"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.workspaceId).toBe("org-1");
      expect(body.queryCount).toBe(42);
      expect(body.tokenCount).toBe(10000);
      expect(body.activeUsers).toBe(3);
    });

    it("returns 404 when no internal DB", async () => {
      mockHasInternalDB = false;
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/usage"));
      expect(res.status).toBe(404);
    });

    it("returns 400 when no active org", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin" },
        }),
      );
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/usage"));
      expect(res.status).toBe(400);
    });

    it("returns 403 for non-admin", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "user-1", mode: "simple-key", label: "User", role: "member", activeOrganizationId: "org-1" },
        }),
      );
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/usage"));
      expect(res.status).toBe(403);
    });

    it("returns 500 with requestId on internal error", async () => {
      mockGetCurrentPeriodUsage.mockImplementation(() => Promise.reject(new Error("db down")));
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/usage"));
      expect(res.status).toBe(500);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
      expect(body.requestId).toBeTruthy();
    });
  });

  // --- GET /api/v1/admin/usage/history ---

  describe("GET /api/v1/admin/usage/history", () => {
    it("returns historical summaries", async () => {
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/usage/history?period=monthly"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.workspaceId).toBe("org-1");
      expect(body.period).toBe("monthly");
      expect(Array.isArray(body.summaries)).toBe(true);
    });

    it("defaults to monthly period", async () => {
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/usage/history"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.period).toBe("monthly");
    });

    it("triggers aggregation before returning", async () => {
      await app.fetch(adminRequest("GET", "/api/v1/admin/usage/history"));
      expect(mockAggregateUsageSummary).toHaveBeenCalled();
    });

    it("returns 500 with requestId on internal error", async () => {
      mockGetUsageHistory.mockImplementation(() => Promise.reject(new Error("db down")));
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/usage/history"));
      expect(res.status).toBe(500);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
      expect(body.requestId).toBeTruthy();
    });

    it("returns daily period when requested", async () => {
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/usage/history?period=daily"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.period).toBe("daily");
    });

    it("returns 400 for invalid startDate", async () => {
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/usage/history?startDate=not-a-date"));
      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("invalid_param");
    });

    it("returns 400 for invalid endDate", async () => {
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/usage/history?endDate=garbage"));
      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("invalid_param");
    });

    it("clamps limit to valid range", async () => {
      await app.fetch(adminRequest("GET", "/api/v1/admin/usage/history?limit=999"));
      expect(mockGetUsageHistory).toHaveBeenCalled();
      // limit=999 should be clamped to 365 — getUsageHistory(orgId, period, startDate, endDate, limit)
      const lastCall = mockGetUsageHistory.mock.lastCall as unknown[];
      expect(lastCall[4]).toBe(365);
    });
  });

  // --- GET /api/v1/admin/usage/breakdown ---

  describe("GET /api/v1/admin/usage/breakdown", () => {
    it("returns per-user breakdown", async () => {
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/usage/breakdown"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.workspaceId).toBe("org-1");
      expect(Array.isArray(body.users)).toBe(true);
      const users = body.users as Array<Record<string, unknown>>;
      expect(users).toHaveLength(2);
      expect(users[0].user_id).toBe("u-1");
    });

    it("passes date filters to the breakdown query", async () => {
      await app.fetch(adminRequest("GET", "/api/v1/admin/usage/breakdown?startDate=2026-01-01&endDate=2026-03-01"));
      expect(mockGetUsageBreakdown).toHaveBeenCalledWith("org-1", "2026-01-01", "2026-03-01", 100);
    });

    it("returns 500 with requestId on internal error", async () => {
      mockGetUsageBreakdown.mockImplementation(() => Promise.reject(new Error("db down")));
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/usage/breakdown"));
      expect(res.status).toBe(500);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
      expect(body.requestId).toBeTruthy();
    });

    it("returns 400 for invalid startDate", async () => {
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/usage/breakdown?startDate=not-a-date"));
      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("invalid_param");
    });

    it("clamps limit to valid range", async () => {
      await app.fetch(adminRequest("GET", "/api/v1/admin/usage/breakdown?limit=999"));
      expect(mockGetUsageBreakdown).toHaveBeenCalled();
      // limit=999 should be clamped to 500 — getUsageBreakdown(orgId, startDate, endDate, limit)
      const lastCall = mockGetUsageBreakdown.mock.lastCall as unknown[];
      expect(lastCall[3]).toBe(500);
    });
  });
});
