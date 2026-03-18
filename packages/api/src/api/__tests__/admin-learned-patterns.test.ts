/**
 * Tests for admin learned-patterns CRUD API routes.
 *
 * Tests: GET /learned-patterns, GET /learned-patterns/:id,
 *        PATCH /learned-patterns/:id, DELETE /learned-patterns/:id,
 *        POST /learned-patterns/bulk.
 *
 * TDD: these tests are written before the routes exist.
 * They should fail until the routes are implemented (Task 5).
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
  type Mock,
} from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";
import * as fs from "fs";
import * as path from "path";

// --- Temp semantic fixtures ---

const tmpRoot = path.join(process.env.TMPDIR ?? "/tmp", `atlas-lp-test-${Date.now()}`);
fs.mkdirSync(path.join(tmpRoot, "entities"), { recursive: true });
fs.writeFileSync(
  path.join(tmpRoot, "entities", "stub.yml"),
  "table: stub\ndescription: stub\ndimensions:\n  id:\n    type: integer\n",
);
fs.writeFileSync(path.join(tmpRoot, "catalog.yml"), "name: Test\n");
process.env.ATLAS_SEMANTIC_ROOT = tmpRoot;

// --- Mocks (before any import that touches the modules) ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: "org-1" },
    }),
);

const mockCheckRateLimit: Mock<() => { allowed: boolean; retryAfterMs?: number }> = mock(
  () => ({ allowed: true }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mockCheckRateLimit,
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

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      get: () => null,
      getDefault: () => null,
      describe: () => [{ id: "default", dbType: "postgres" }],
      healthCheck: mock(() => Promise.resolve({ status: "healthy" })),
      register: mock(() => {}),
      unregister: mock(() => {}),
      has: mock(() => false),
      getForOrg: () => null,
    },
    resolveDatasourceUrl: () => "postgresql://stub",
  }),
);

mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(["stub"]),
  getCrossSourceJoins: () => [],
  _resetWhitelists: () => {},
  registerPluginEntities: () => {},
  _resetPluginEntities: () => {},
}));

let mockHasInternalDB = true;

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>> = mock(
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

mock.module("@atlas/api/lib/plugins/registry", () => ({
  plugins: {
    describe: () => [],
    get: () => undefined,
    getStatus: () => undefined,
    enable: () => false,
    disable: () => false,
    isEnabled: () => false,
    getAllHealthy: () => [],
    getByType: () => [],
    size: 0,
  },
  PluginRegistry: class {},
}));

mock.module("@atlas/api/lib/plugins/settings", () => ({
  loadPluginSettings: mock(async () => 0),
  savePluginEnabled: mock(async () => {}),
  savePluginConfig: mock(async () => {}),
  getPluginConfig: mock(async () => null),
  getAllPluginSettings: mock(async () => []),
}));

mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: mock(async () => {}),
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

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mock(() => Promise.resolve(null)),
  addMessage: mock(() => {}),
  getConversation: mock(() => Promise.resolve(null)),
  generateTitle: mock((q: string) => q.slice(0, 80)),
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  deleteConversation: mock(() => Promise.resolve(false)),
  starConversation: mock(() => Promise.resolve(false)),
  shareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  unshareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  getShareStatus: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  cleanupExpiredShares: mock(() => Promise.resolve(0)),
  getSharedConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
}));

mock.module("@atlas/api/lib/auth/server", () => ({
  getAuthInstance: () => null,
  listAllUsers: mock(() => Promise.resolve([])),
  setUserRole: mock(async () => {}),
  setBanStatus: mock(async () => {}),
  setPasswordChangeRequired: mock(async () => {}),
  deleteUser: mock(async () => {}),
}));

mock.module("@atlas/api/lib/scheduled-tasks", () => ({
  listScheduledTasks: mock(async () => []),
  getScheduledTask: mock(async () => null),
  createScheduledTask: mock(async () => ({})),
  updateScheduledTask: mock(async () => null),
  deleteScheduledTask: mock(async () => false),
  listScheduledTaskRuns: mock(async () => []),
  getRecentRuns: mock(async () => []),
  scheduledTaskBelongsToUser: mock(async () => false),
}));

mock.module("@atlas/api/lib/scheduler", () => ({
  getSchedulerEngine: mock(() => null),
}));

mock.module("@atlas/api/lib/scheduler/preview", () => ({
  previewSchedule: () => [],
}));

// --- Import the app AFTER mocks ---

const { app } = await import("../index");

// --- Helpers ---

function req(method: string, urlPath: string, body?: unknown) {
  const url = `http://localhost/api/v1/admin/learned-patterns${urlPath}`;
  const init: RequestInit = { method, headers: { Authorization: "Bearer test" } };
  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  return app.fetch(new Request(url, init));
}

function mockRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "pat-1",
    org_id: "org-1",
    pattern_sql: "SELECT COUNT(*) FROM orders",
    description: "Order count",
    source_entity: "orders",
    source_queries: ["audit-1"],
    confidence: 0.8,
    repetition_count: 5,
    status: "pending",
    proposed_by: "agent",
    reviewed_by: null,
    created_at: "2026-03-18T00:00:00Z",
    updated_at: "2026-03-18T00:00:00Z",
    reviewed_at: null,
    ...overrides,
  };
}

// --- Cleanup ---

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.ATLAS_SEMANTIC_ROOT;
});

// --- Reset mocks between tests ---

beforeEach(() => {
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: "org-1" },
    }),
  );
  mockHasInternalDB = true;
  mockInternalQuery.mockReset();
  mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  mockCheckRateLimit.mockImplementation(() => ({ allowed: true }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("admin learned-patterns routes", () => {
  // ─── Auth gating ──────────────────────────────────────────────────

  describe("auth gating", () => {
    it("returns 403 for non-admin user", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "user-1", mode: "simple-key", label: "User", role: "member", activeOrganizationId: "org-1" },
        }),
      );
      const res = await req("GET", "/");
      expect(res.status).toBe(403);
    });

    it("returns 401 for unauthenticated", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: false,
          error: "Invalid token",
          status: 401,
        }),
      );
      const res = await req("GET", "/");
      expect(res.status).toBe(401);
    });
  });

  // ─── Rate limiting ────────────────────────────────────────────────

  describe("rate limiting", () => {
    it("returns 429 when rate limited", async () => {
      mockCheckRateLimit.mockImplementation(() => ({ allowed: false, retryAfterMs: 60000 }));
      const res = await req("GET", "/");
      expect(res.status).toBe(429);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.retryAfterSeconds).toBeDefined();
    });
  });

  // ─── No internal DB ───────────────────────────────────────────────

  describe("no internal DB", () => {
    it("returns 404 when no internal DB", async () => {
      mockHasInternalDB = false;
      const res = await req("GET", "/");
      expect(res.status).toBe(404);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("not_available");
    });
  });

  // ─── GET / (list) ─────────────────────────────────────────────────

  describe("GET /", () => {
    it("returns patterns with pagination", async () => {
      let callCount = 0;
      mockInternalQuery.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([{ count: "2" }]);
        }
        return Promise.resolve([mockRow(), mockRow({ id: "pat-2" })]);
      });

      const res = await req("GET", "/");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.patterns).toBeArray();
      expect(body.total).toBe(2);
      expect(body.limit).toBeDefined();
      expect(body.offset).toBeDefined();
      // Verify patterns are camelCased
      if (body.patterns.length > 0) {
        expect(body.patterns[0].patternSql).toBe("SELECT COUNT(*) FROM orders");
        expect(body.patterns[0].sourceEntity).toBe("orders");
        expect(body.patterns[0].sourceQueries).toEqual(["audit-1"]);
        expect(body.patterns[0].repetitionCount).toBe(5);
        expect(body.patterns[0].proposedBy).toBe("agent");
        expect(body.patterns[0].reviewedBy).toBeNull();
        expect(body.patterns[0].createdAt).toBe("2026-03-18T00:00:00Z");
        expect(body.patterns[0].updatedAt).toBe("2026-03-18T00:00:00Z");
        expect(body.patterns[0].reviewedAt).toBeNull();
      }
    });

    it("defaults limit to 50 and offset to 0", async () => {
      mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/");
      // Check that the query was called with limit=50 and offset=0
      const calls = mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      // The SELECT query (second call) should have LIMIT and OFFSET params of 50 and 0
      const lastCall = calls[calls.length - 1];
      const params = lastCall[1] as unknown[];
      expect(params).toContain(50);
      expect(params).toContain(0);
    });

    it("caps limit at 200", async () => {
      mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/?limit=500");
      const calls = mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      // The limit param should be capped at 200
      const lastCall = calls[calls.length - 1];
      const params = lastCall[1] as unknown[];
      expect(params).toContain(200);
    });

    it("applies status filter", async () => {
      mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/?status=approved");
      const calls = mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      // Verify that SQL contains status filter and params include "approved"
      const firstCall = calls[0];
      const sql = firstCall[0] as string;
      const params = firstCall[1] as unknown[];
      expect(sql).toContain("status");
      expect(params).toContain("approved");
    });

    it("applies source_entity filter", async () => {
      mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/?source_entity=orders");
      const calls = mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const firstCall = calls[0];
      const sql = firstCall[0] as string;
      const params = firstCall[1] as unknown[];
      expect(sql).toContain("source_entity");
      expect(params).toContain("orders");
    });

    it("applies confidence range", async () => {
      mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/?min_confidence=0.5&max_confidence=0.9");
      const calls = mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const firstCall = calls[0];
      const sql = firstCall[0] as string;
      const params = firstCall[1] as unknown[];
      expect(sql).toContain("confidence");
      expect(params).toContain(0.5);
      expect(params).toContain(0.9);
    });

    it("applies combined filters", async () => {
      mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/?status=pending&source_entity=orders&min_confidence=0.5");
      const calls = mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const firstCall = calls[0];
      const sql = firstCall[0] as string;
      const params = firstCall[1] as unknown[];
      expect(sql).toContain("status");
      expect(sql).toContain("source_entity");
      expect(sql).toContain("confidence");
      expect(params).toContain("pending");
      expect(params).toContain("orders");
      expect(params).toContain(0.5);
    });
  });

  // ─── GET /:id ─────────────────────────────────────────────────────

  describe("GET /:id", () => {
    it("returns single pattern", async () => {
      mockInternalQuery.mockImplementation(() => Promise.resolve([mockRow()]));
      const res = await req("GET", "/pat-1");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.id).toBe("pat-1");
      expect(body.patternSql).toBe("SELECT COUNT(*) FROM orders");
      expect(body.description).toBe("Order count");
      expect(body.sourceEntity).toBe("orders");
      expect(body.confidence).toBe(0.8);
      expect(body.status).toBe("pending");
    });

    it("returns 404 for missing pattern", async () => {
      mockInternalQuery.mockImplementation(() => Promise.resolve([]));
      const res = await req("GET", "/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  // ─── PATCH /:id ───────────────────────────────────────────────────

  describe("PATCH /:id", () => {
    it("updates description", async () => {
      let callCount = 0;
      mockInternalQuery.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // SELECT to verify existence
          return Promise.resolve([mockRow()]);
        }
        // UPDATE returning the updated row
        return Promise.resolve([mockRow({ description: "Updated" })]);
      });

      const res = await req("PATCH", "/pat-1", { description: "Updated" });
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.description).toBe("Updated");
    });

    it("updates status with reviewed_by and reviewed_at", async () => {
      let callCount = 0;
      mockInternalQuery.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([mockRow()]);
        }
        return Promise.resolve([mockRow({ status: "approved", reviewed_by: "admin-1", reviewed_at: "2026-03-18T00:00:00Z" })]);
      });

      const res = await req("PATCH", "/pat-1", { status: "approved" });
      expect(res.status).toBe(200);

      // Verify the UPDATE SQL includes reviewed_by and reviewed_at params
      const calls = mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      const updateCall = calls[1];
      const sql = updateCall[0] as string;
      expect(sql).toContain("reviewed_by");
      expect(sql).toContain("reviewed_at");
    });

    it("returns 400 for invalid status", async () => {
      mockInternalQuery.mockImplementation(() => Promise.resolve([mockRow()]));
      const res = await req("PATCH", "/pat-1", { status: "invalid" });
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing pattern", async () => {
      mockInternalQuery.mockImplementation(() => Promise.resolve([]));
      const res = await req("PATCH", "/pat-1", { description: "Updated" });
      expect(res.status).toBe(404);
    });
  });

  // ─── DELETE /:id ──────────────────────────────────────────────────

  describe("DELETE /:id", () => {
    it("deletes pattern", async () => {
      let callCount = 0;
      mockInternalQuery.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([mockRow()]);
        }
        return Promise.resolve([]);
      });

      const res = await req("DELETE", "/pat-1");
      expect(res.status).toBe(200);
    });

    it("returns 404 for missing pattern", async () => {
      mockInternalQuery.mockImplementation(() => Promise.resolve([]));
      const res = await req("DELETE", "/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  // ─── POST /bulk ───────────────────────────────────────────────────

  describe("POST /bulk", () => {
    it("bulk approves patterns", async () => {
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT")) {
          return Promise.resolve([{ id: "pat-1" }]);
        }
        return Promise.resolve([mockRow({ status: "approved" })]);
      });

      const res = await req("POST", "/bulk", { ids: ["pat-1", "pat-2"], status: "approved" });
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.updated).toBeArray();
      expect(body.notFound).toBeArray();
    });

    it("returns partial results for mixed ids", async () => {
      let selectCallCount = 0;
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT")) {
          selectCallCount++;
          if (selectCallCount === 1) {
            return Promise.resolve([mockRow({ id: "pat-1" })]);
          }
          return Promise.resolve([]);
        }
        return Promise.resolve([mockRow({ id: "pat-1", status: "approved" })]);
      });

      const res = await req("POST", "/bulk", { ids: ["pat-1", "pat-missing"], status: "approved" });
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.updated).toContain("pat-1");
      expect(body.notFound).toContain("pat-missing");
    });

    it("returns 400 for empty ids", async () => {
      const res = await req("POST", "/bulk", { ids: [], status: "approved" });
      expect(res.status).toBe(400);
    });

    it("returns 400 for too many ids", async () => {
      const res = await req("POST", "/bulk", { ids: Array(101).fill("x"), status: "approved" });
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid status", async () => {
      const res = await req("POST", "/bulk", { ids: ["pat-1"], status: "pending" });
      expect(res.status).toBe(400);
    });
  });

  // ─── Org-scoping ──────────────────────────────────────────────────

  describe("org-scoping", () => {
    it("filters by org_id from session", async () => {
      mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/");
      const calls = mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const firstCall = calls[0];
      const sql = firstCall[0] as string;
      const params = firstCall[1] as unknown[];
      expect(sql).toContain("org_id");
      expect(params).toContain("org-1");
    });

    it("filters by org_id IS NULL in single-tenant", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin" },
        }),
      );
      mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/");
      const calls = mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const firstCall = calls[0];
      const sql = firstCall[0] as string;
      expect(sql).toContain("org_id IS NULL");
    });
  });

  // ─── Error handling ───────────────────────────────────────────────

  describe("error handling", () => {
    it("returns 500 with requestId on DB error", async () => {
      mockInternalQuery.mockImplementation(() => Promise.reject(new Error("DB connection failed")));
      const res = await req("GET", "/");
      expect(res.status).toBe(500);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("internal_error");
      expect(typeof body.requestId).toBe("string");
    });
  });
});
