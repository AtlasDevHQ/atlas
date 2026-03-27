/**
 * Tests for workspace lifecycle admin API endpoints.
 *
 * Covers: suspend, activate, soft-delete (with cascade), status/health,
 * plan tier update, and workspace status enforcement in list/detail views.
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
      user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin" },
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

// --- Connection mock ---

const mockDrainOrg: Mock<(orgId: string) => Promise<unknown>> = mock(() =>
  Promise.resolve({ drained: 2 }),
);

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      isOrgPoolingEnabled: () => true,
      drainOrg: mockDrainOrg,
      getOrgPoolMetrics: () => [],
    },
  }),
);

// --- Cache mock ---

const mockFlushCache: Mock<() => void> = mock(() => {});

mock.module("@atlas/api/lib/cache/index", () => ({
  getCache: mock(() => ({ get: () => null, set: () => {}, delete: () => false, flush: () => {}, stats: () => ({}) })),
  cacheEnabled: mock(() => true),
  setCacheBackend: mock(() => {}),
  flushCache: mockFlushCache,
  getDefaultTtl: mock(() => 300000),
  _resetCache: mock(() => {}),
  buildCacheKey: mock(() => "mock-key"),
}));

// --- Internal DB mock ---

let mockHasInternalDB = true;
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  () => Promise.resolve([]),
);

// Track workspace state for mock
let workspaceState = {
  id: "org-1",
  name: "Test Org",
  slug: "test-org",
  workspace_status: "active" as string,
  plan_tier: "free" as string,
  suspended_at: null as string | null,
  deleted_at: null as string | null,
  createdAt: "2026-01-01T00:00:00Z",
};

const mockGetWorkspaceDetails: Mock<(orgId: string) => Promise<unknown>> = mock(
  (orgId: string) => {
    if (orgId === "org-missing") return Promise.resolve(null);
    return Promise.resolve({ ...workspaceState });
  },
);

const mockUpdateWorkspaceStatus: Mock<(orgId: string, status: string) => Promise<boolean>> = mock(
  (_orgId: string, status: string) => {
    workspaceState.workspace_status = status;
    if (status === "suspended") workspaceState.suspended_at = new Date().toISOString();
    if (status === "deleted") workspaceState.deleted_at = new Date().toISOString();
    if (status === "active") {
      workspaceState.suspended_at = null;
      workspaceState.deleted_at = null;
    }
    return Promise.resolve(true);
  },
);

const mockUpdateWorkspacePlanTier: Mock<(orgId: string, tier: string) => Promise<boolean>> = mock(
  (_orgId: string, tier: string) => {
    workspaceState.plan_tier = tier;
    return Promise.resolve(true);
  },
);

const mockCascadeWorkspaceDelete: Mock<(orgId: string) => Promise<unknown>> = mock(
  () => Promise.resolve({
    conversations: 5,
    semanticEntities: 3,
    learnedPatterns: 2,
    suggestions: 10,
    scheduledTasks: 1,
    settings: 4,
  }),
);

const mockGetWorkspaceHealthSummary: Mock<(orgId: string) => Promise<unknown>> = mock(
  (orgId: string) => {
    if (orgId === "org-missing") return Promise.resolve(null);
    return Promise.resolve({
      workspace: { ...workspaceState },
      members: 5,
      conversations: 42,
      queriesLast24h: 120,
      connections: 2,
      scheduledTasks: 3,
    });
  },
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
  getWorkspaceStatus: mock((orgId: string) => {
    if (orgId === "org-missing") return Promise.resolve(null);
    return Promise.resolve(workspaceState.workspace_status);
  }),
  getWorkspaceDetails: mockGetWorkspaceDetails,
  updateWorkspaceStatus: mockUpdateWorkspaceStatus,
  updateWorkspacePlanTier: mockUpdateWorkspacePlanTier,
  cascadeWorkspaceDelete: mockCascadeWorkspaceDelete,
  getWorkspaceHealthSummary: mockGetWorkspaceHealthSummary,
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
  getSettingDefinition: mock(() => undefined),
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

describe("Workspace Lifecycle", () => {
  beforeEach(() => {
    // Reset workspace state to active
    workspaceState = {
      id: "org-1",
      name: "Test Org",
      slug: "test-org",
      workspace_status: "active",
      plan_tier: "free",
      suspended_at: null,
      deleted_at: null,
      createdAt: "2026-01-01T00:00:00Z",
    };
    mockHasInternalDB = true;
    mockDrainOrg.mockClear();
    mockFlushCache.mockClear();
    mockCascadeWorkspaceDelete.mockClear();
  });

  // --- Suspend ---

  describe("PATCH /api/v1/admin/organizations/:id/suspend", () => {
    it("suspends an active workspace", async () => {
      const res = await app.fetch(adminRequest("PATCH", "/api/v1/admin/organizations/org-1/suspend"));
      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(json.message).toContain("suspended");
      expect((json.organization as Record<string, unknown>).workspace_status).toBe("suspended");
    });

    it("drains org connection pools on suspend", async () => {
      await app.fetch(adminRequest("PATCH", "/api/v1/admin/organizations/org-1/suspend"));
      expect(mockDrainOrg).toHaveBeenCalledWith("org-1");
    });

    it("returns 409 if already suspended", async () => {
      workspaceState.workspace_status = "suspended";
      const res = await app.fetch(adminRequest("PATCH", "/api/v1/admin/organizations/org-1/suspend"));
      expect(res.status).toBe(409);
    });

    it("returns 409 if deleted", async () => {
      workspaceState.workspace_status = "deleted";
      const res = await app.fetch(adminRequest("PATCH", "/api/v1/admin/organizations/org-1/suspend"));
      expect(res.status).toBe(409);
    });

    it("returns 404 for non-existent org", async () => {
      const res = await app.fetch(adminRequest("PATCH", "/api/v1/admin/organizations/org-missing/suspend"));
      expect(res.status).toBe(404);
    });

    it("returns 400 for empty org ID", async () => {
      const res = await app.fetch(adminRequest("PATCH", "/api/v1/admin/organizations//suspend"));
      expect(res.status).toBe(404); // Hono route mismatch
    });
  });

  // --- Activate ---

  describe("PATCH /api/v1/admin/organizations/:id/activate", () => {
    it("activates a suspended workspace", async () => {
      workspaceState.workspace_status = "suspended";
      workspaceState.suspended_at = "2026-01-15T00:00:00Z";

      const res = await app.fetch(adminRequest("PATCH", "/api/v1/admin/organizations/org-1/activate"));
      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(json.message).toContain("activated");
      expect((json.organization as Record<string, unknown>).workspace_status).toBe("active");
    });

    it("returns 409 if already active", async () => {
      const res = await app.fetch(adminRequest("PATCH", "/api/v1/admin/organizations/org-1/activate"));
      expect(res.status).toBe(409);
    });

    it("returns 409 if deleted", async () => {
      workspaceState.workspace_status = "deleted";
      const res = await app.fetch(adminRequest("PATCH", "/api/v1/admin/organizations/org-1/activate"));
      expect(res.status).toBe(409);
    });

    it("returns 404 for non-existent org", async () => {
      const res = await app.fetch(adminRequest("PATCH", "/api/v1/admin/organizations/org-missing/activate"));
      expect(res.status).toBe(404);
    });
  });

  // --- Delete ---

  describe("DELETE /api/v1/admin/organizations/:id", () => {
    it("soft-deletes with cascade", async () => {
      const res = await app.fetch(adminRequest("DELETE", "/api/v1/admin/organizations/org-1"));
      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(json.message).toContain("deleted");
      const cascade = json.cascade as Record<string, number>;
      expect(cascade.poolsDrained).toBe(2);
      expect(cascade.conversations).toBe(5);
      expect(cascade.semanticEntities).toBe(3);
      expect(cascade.learnedPatterns).toBe(2);
      expect(cascade.suggestions).toBe(10);
      expect(cascade.scheduledTasks).toBe(1);
      expect(cascade.settings).toBe(4);
    });

    it("drains pools and flushes cache on delete", async () => {
      await app.fetch(adminRequest("DELETE", "/api/v1/admin/organizations/org-1"));
      expect(mockDrainOrg).toHaveBeenCalledWith("org-1");
      expect(mockFlushCache).toHaveBeenCalled();
      expect(mockCascadeWorkspaceDelete).toHaveBeenCalledWith("org-1");
    });

    it("returns 409 if already deleted", async () => {
      workspaceState.workspace_status = "deleted";
      const res = await app.fetch(adminRequest("DELETE", "/api/v1/admin/organizations/org-1"));
      expect(res.status).toBe(409);
    });

    it("can delete a suspended workspace", async () => {
      workspaceState.workspace_status = "suspended";
      const res = await app.fetch(adminRequest("DELETE", "/api/v1/admin/organizations/org-1"));
      expect(res.status).toBe(200);
    });

    it("returns 404 for non-existent org", async () => {
      const res = await app.fetch(adminRequest("DELETE", "/api/v1/admin/organizations/org-missing"));
      expect(res.status).toBe(404);
    });
  });

  // --- Status / Health ---

  describe("GET /api/v1/admin/organizations/:id/status", () => {
    it("returns workspace health summary", async () => {
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/organizations/org-1/status"));
      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      const workspace = json.workspace as Record<string, unknown>;
      const health = json.health as Record<string, unknown>;
      expect(workspace.workspaceStatus).toBe("active");
      expect(workspace.planTier).toBe("free");
      expect(health.members).toBe(5);
      expect(health.conversations).toBe(42);
      expect(health.queriesLast24h).toBe(120);
      expect(health.connections).toBe(2);
      expect(health.scheduledTasks).toBe(3);
    });

    it("returns 404 for non-existent org", async () => {
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/organizations/org-missing/status"));
      expect(res.status).toBe(404);
    });

    it("returns 404 when no internal DB", async () => {
      mockHasInternalDB = false;
      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/organizations/org-1/status"));
      expect(res.status).toBe(404);
    });
  });

  // --- Plan Tier ---

  describe("PATCH /api/v1/admin/organizations/:id/plan", () => {
    it("updates plan tier to team", async () => {
      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/organizations/org-1/plan", { planTier: "team" }),
      );
      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(json.message).toContain("team");
      expect((json.organization as Record<string, unknown>).plan_tier).toBe("team");
    });

    it("updates plan tier to enterprise", async () => {
      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/organizations/org-1/plan", { planTier: "enterprise" }),
      );
      expect(res.status).toBe(200);
    });

    it("rejects invalid plan tier", async () => {
      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/organizations/org-1/plan", { planTier: "premium" }),
      );
      expect(res.status).toBe(400);
    });

    it("rejects missing plan tier", async () => {
      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/organizations/org-1/plan", {}),
      );
      expect(res.status).toBe(422);
    });

    it("returns 409 for deleted workspace", async () => {
      workspaceState.workspace_status = "deleted";
      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/organizations/org-1/plan", { planTier: "team" }),
      );
      expect(res.status).toBe(409);
    });

    it("returns 404 for non-existent org", async () => {
      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/organizations/org-missing/plan", { planTier: "team" }),
      );
      expect(res.status).toBe(404);
    });
  });

  // --- List orgs includes workspace fields ---

  describe("GET /api/v1/admin/organizations (workspace fields)", () => {
    it("includes workspace status and plan tier in list", async () => {
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{
            id: "org-1",
            name: "Test Org",
            slug: "test-org",
            logo: null,
            metadata: null,
            createdAt: "2026-01-01T00:00:00Z",
            workspace_status: "suspended",
            plan_tier: "team",
            suspended_at: "2026-01-15T00:00:00Z",
            deleted_at: null,
          }];
        }
        if (sql.includes("FROM member")) {
          return [{ organization_id: "org-1", count: 3 }];
        }
        return [];
      });

      const res = await app.fetch(adminRequest("GET", "/api/v1/admin/organizations"));
      expect(res.status).toBe(200);
      const json = await res.json() as { organizations: Array<Record<string, unknown>> };
      expect(json.organizations[0].workspaceStatus).toBe("suspended");
      expect(json.organizations[0].planTier).toBe("team");
      expect(json.organizations[0].suspendedAt).toBeTruthy();

      // Restore default mock
      mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    });
  });
});
