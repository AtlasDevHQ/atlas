/**
 * Tests for admin abuse prevention API endpoints.
 *
 * Covers: GET /admin/abuse, POST /admin/abuse/:id/reinstate, GET /admin/abuse/config.
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

// --- Abuse mock ---

const mockListFlagged: Mock<() => unknown[]> = mock(() => []);
const mockReinstateWorkspace: Mock<(wsId: string, actorId: string) => boolean> = mock(() => true);
const mockGetAbuseEvents: Mock<(wsId: string, limit?: number) => Promise<unknown[]>> = mock(async () => []);
const mockGetAbuseConfig: Mock<() => unknown> = mock(() => ({
  queryRateLimit: 200,
  queryRateWindowSeconds: 300,
  errorRateThreshold: 0.5,
  uniqueTablesLimit: 50,
  throttleDelayMs: 2000,
}));

mock.module("@atlas/api/lib/security/abuse", () => ({
  listFlaggedWorkspaces: mockListFlagged,
  reinstateWorkspace: mockReinstateWorkspace,
  getAbuseEvents: mockGetAbuseEvents,
  getAbuseConfig: mockGetAbuseConfig,
  checkAbuseStatus: mock(() => ({ level: "none" })),
  recordQueryEvent: mock(() => {}),
  restoreAbuseState: mock(async () => {}),
  _resetAbuseState: mock(() => {}),
  _stopCleanup: mock(() => {}),
}));

// --- Internal DB mock ---

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
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

mock.module("@atlas/api/lib/semantic-diff", () => ({
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

describe("Admin Abuse API", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: "org-1" },
      }),
    );
    mockListFlagged.mockImplementation(() => []);
    mockReinstateWorkspace.mockImplementation(() => true);
    mockGetAbuseEvents.mockImplementation(async () => []);
  });

  // --- GET /api/v1/admin/abuse ---

  describe("GET /api/v1/admin/abuse", () => {
    it("returns empty list when no workspaces flagged", async () => {
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/abuse"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.workspaces).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("returns flagged workspaces", async () => {
      mockListFlagged.mockImplementation(() => [
        {
          workspaceId: "org-1",
          workspaceName: null,
          level: "warning",
          trigger: "query_rate",
          message: "Excessive queries",
          updatedAt: "2026-03-23T00:00:00.000Z",
          events: [],
        },
      ]);
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/abuse"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect((body.workspaces as unknown[]).length).toBe(1);
      expect(body.total).toBe(1);
    });

    it("returns 403 for non-admin", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "user-1", mode: "simple-key", label: "User", role: "member", activeOrganizationId: "org-1" },
        }),
      );
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/abuse"));
      expect(res.status).toBe(403);
    });
  });

  // --- POST /api/v1/admin/abuse/:id/reinstate ---

  describe("POST /api/v1/admin/abuse/:id/reinstate", () => {
    it("reinstates a flagged workspace", async () => {
      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/abuse/org-1/reinstate"),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.workspaceId).toBe("org-1");
    });

    it("returns 400 when workspace not flagged", async () => {
      mockReinstateWorkspace.mockImplementation(() => false);
      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/abuse/org-clean/reinstate"),
      );
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
      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/abuse/org-1/reinstate"),
      );
      expect(res.status).toBe(403);
    });
  });

  // --- GET /api/v1/admin/abuse/config ---

  describe("GET /api/v1/admin/abuse/config", () => {
    it("returns current threshold configuration", async () => {
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/abuse/config"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.queryRateLimit).toBe(200);
      expect(body.queryRateWindowSeconds).toBe(300);
      expect(body.errorRateThreshold).toBe(0.5);
      expect(body.uniqueTablesLimit).toBe(50);
      expect(body.throttleDelayMs).toBe(2000);
    });

    it("returns 403 for non-admin", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "user-1", mode: "simple-key", label: "User", role: "member", activeOrganizationId: "org-1" },
        }),
      );
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/abuse/config"));
      expect(res.status).toBe(403);
    });
  });
});
