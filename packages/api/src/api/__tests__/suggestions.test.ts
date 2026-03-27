/**
 * Tests for user-facing suggestion API routes.
 *
 * Tests: GET /suggestions?table=..., GET /suggestions/popular,
 *        POST /suggestions/:id/click.
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

const tmpRoot = path.join(process.env.TMPDIR ?? "/tmp", `atlas-suggestions-test-${Date.now()}`);
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
      user: { id: "user-1", mode: "simple-key", label: "User", role: "member", activeOrganizationId: "org-1" },
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

const mockGetSuggestionsByTables: Mock<() => Promise<unknown[]>> = mock(() => Promise.resolve([]));
const mockGetPopularSuggestions: Mock<() => Promise<unknown[]>> = mock(() => Promise.resolve([]));
const mockIncrementSuggestionClick: Mock<() => void> = mock(() => {});

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: mock(() => ({})),
  closeInternalDB: mock(async () => {}),
  _resetPool: mock(() => {}),
  _resetCircuitBreaker: mock(() => {}),
  internalQuery: mock(async () => []),
  internalExecute: mock(() => {}),
  migrateInternalDB: mock(async () => {}),
  loadSavedConnections: mock(async () => 0),
  getEncryptionKey: () => null,
  _resetEncryptionKeyCache: mock(() => {}),
  encryptUrl: (url: string) => url,
  decryptUrl: (url: string) => url,
  isPlaintextUrl: (value: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value),
  findPatternBySQL: async () => null,
  insertLearnedPattern: () => {},
  incrementPatternCount: () => {},
  getApprovedPatterns: mock(async () => []),
  upsertSuggestion: mock(async () => "skipped"),
  getSuggestionsByTables: mockGetSuggestionsByTables,
  getPopularSuggestions: mockGetPopularSuggestions,
  incrementSuggestionClick: mockIncrementSuggestionClick,
  deleteSuggestion: mock(async () => false),
  getAuditLogQueries: mock(async () => []),
  getWorkspaceStatus: mock(async () => "active"),
  getWorkspaceDetails: mock(async () => null),
  updateWorkspaceStatus: mock(async () => true),
  updateWorkspacePlanTier: mock(async () => true),
  cascadeWorkspaceDelete: mock(async () => ({ conversations: 0, semanticEntities: 0, learnedPatterns: 0, suggestions: 0, scheduledTasks: 0, settings: 0 })),
  getWorkspaceHealthSummary: mock(async () => null),
}));

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
  updateNotebookState: mock(() => Promise.resolve({ ok: true })),
  forkConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
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
  const url = `http://localhost/api/v1/suggestions${urlPath}`;
  const init: RequestInit = { method, headers: { Authorization: "Bearer test" } };
  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  return app.fetch(new Request(url, init));
}

function mockSuggestionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "sug-1",
    org_id: "org-1",
    description: "Count orders by status",
    pattern_sql: "SELECT status, COUNT(*) FROM orders GROUP BY status",
    normalized_hash: "abc123",
    tables_involved: JSON.stringify(["orders"]),
    primary_table: "orders",
    frequency: 10,
    clicked_count: 3,
    score: 8.5,
    last_seen_at: "2026-03-18T00:00:00Z",
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-18T00:00:00Z",
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
      user: { id: "user-1", mode: "simple-key", label: "User", role: "member", activeOrganizationId: "org-1" },
    }),
  );
  mockHasInternalDB = true;
  mockGetSuggestionsByTables.mockReset();
  mockGetSuggestionsByTables.mockImplementation(() => Promise.resolve([]));
  mockGetPopularSuggestions.mockReset();
  mockGetPopularSuggestions.mockImplementation(() => Promise.resolve([]));
  mockIncrementSuggestionClick.mockReset();
  mockCheckRateLimit.mockImplementation(() => ({ allowed: true }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("suggestions routes", () => {
  // ─── Auth gating ──────────────────────────────────────────────────

  describe("auth gating", () => {
    it("returns 401 for unauthenticated", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: false,
          error: "Invalid token",
          status: 401,
        }),
      );
      const res = await req("GET", "/?table=orders");
      expect(res.status).toBe(401);
    });
  });

  // ─── Rate limiting ────────────────────────────────────────────────

  describe("rate limiting", () => {
    it("returns 429 when rate limited on GET /", async () => {
      mockCheckRateLimit.mockImplementation(() => ({ allowed: false, retryAfterMs: 60000 }));
      const res = await req("GET", "/?table=orders");
      expect(res.status).toBe(429);
    });

    it("returns 429 when rate limited on GET /popular", async () => {
      mockCheckRateLimit.mockImplementation(() => ({ allowed: false, retryAfterMs: 60000 }));
      const res = await req("GET", "/popular");
      expect(res.status).toBe(429);
    });
  });

  // ─── No internal DB ───────────────────────────────────────────────

  describe("no internal DB", () => {
    it("returns empty list when no internal DB on GET /", async () => {
      mockHasInternalDB = false;
      const res = await req("GET", "/?table=orders");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.suggestions).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("returns empty list when no internal DB on GET /popular", async () => {
      mockHasInternalDB = false;
      const res = await req("GET", "/popular");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.suggestions).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  // ─── GET / ────────────────────────────────────────────────────────

  describe("GET /?table=orders", () => {
    it("returns matching suggestions, 200", async () => {
      mockGetSuggestionsByTables.mockImplementation(() =>
        Promise.resolve([mockSuggestionRow(), mockSuggestionRow({ id: "sug-2" })]),
      );

      const res = await req("GET", "/?table=orders");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.suggestions).toBeArray();
      expect(body.total).toBe(2);
      // Verify camelCased shape
      expect(body.suggestions[0].id).toBe("sug-1");
      expect(body.suggestions[0].description).toBe("Count orders by status");
      expect(body.suggestions[0].patternSql).toBe("SELECT status, COUNT(*) FROM orders GROUP BY status");
      expect(body.suggestions[0].normalizedHash).toBe("abc123");
      expect(body.suggestions[0].tablesInvolved).toEqual(["orders"]);
      expect(body.suggestions[0].primaryTable).toBe("orders");
      expect(body.suggestions[0].frequency).toBe(10);
      expect(body.suggestions[0].clickedCount).toBe(3);
      expect(body.suggestions[0].score).toBe(8.5);
    });

    it("returns 400 when no table param", async () => {
      const res = await req("GET", "/");
      expect(res.status).toBe(400);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toContain("table");
    });

    it("supports multiple table params", async () => {
      mockGetSuggestionsByTables.mockImplementation(() => Promise.resolve([]));
      const res = await req("GET", "/?table=orders&table=products");
      expect(res.status).toBe(200);
      expect(mockGetSuggestionsByTables.mock.calls.length).toBe(1);
      const callArgs = mockGetSuggestionsByTables.mock.calls[0] as unknown[];
      expect(callArgs[1]).toEqual(["orders", "products"]);
    });

    it("caps limit at 50", async () => {
      mockGetSuggestionsByTables.mockImplementation(() => Promise.resolve([]));
      const res = await req("GET", "/?table=orders&limit=999");
      expect(res.status).toBe(200);
      const callArgs = mockGetSuggestionsByTables.mock.calls[0] as unknown[];
      expect(callArgs[2]).toBe(50);
    });

    it("passes orgId from session", async () => {
      mockGetSuggestionsByTables.mockImplementation(() => Promise.resolve([]));
      await req("GET", "/?table=orders");
      const callArgs = mockGetSuggestionsByTables.mock.calls[0] as unknown[];
      expect(callArgs[0]).toBe("org-1");
    });
  });

  // ─── GET /popular ─────────────────────────────────────────────────

  describe("GET /popular", () => {
    it("returns suggestions, 200", async () => {
      mockGetPopularSuggestions.mockImplementation(() =>
        Promise.resolve([mockSuggestionRow(), mockSuggestionRow({ id: "sug-2", score: 5.0 })]),
      );

      const res = await req("GET", "/popular");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.suggestions).toBeArray();
      expect(body.total).toBe(2);
      expect(body.suggestions[0].id).toBe("sug-1");
    });

    it("caps limit at 50", async () => {
      mockGetPopularSuggestions.mockImplementation(() => Promise.resolve([]));
      const res = await req("GET", "/popular?limit=100");
      expect(res.status).toBe(200);
      const callArgs = mockGetPopularSuggestions.mock.calls[0] as unknown[];
      expect(callArgs[1]).toBe(50);
    });

    it("passes orgId from session", async () => {
      mockGetPopularSuggestions.mockImplementation(() => Promise.resolve([]));
      await req("GET", "/popular");
      const callArgs = mockGetPopularSuggestions.mock.calls[0] as unknown[];
      expect(callArgs[0]).toBe("org-1");
    });
  });

  // ─── POST /:id/click ──────────────────────────────────────────────

  describe("POST /:id/click", () => {
    it("returns 204", async () => {
      const res = await req("POST", "/sug-1/click");
      expect(res.status).toBe(204);
    });

    it("calls incrementSuggestionClick with id and orgId", async () => {
      await req("POST", "/sug-42/click");
      expect(mockIncrementSuggestionClick.mock.calls.length).toBe(1);
      const callArgs = mockIncrementSuggestionClick.mock.calls[0] as unknown[];
      expect(callArgs[0]).toBe("sug-42");
      expect(callArgs[1]).toBe("org-1");
    });

    it("returns 204 even if incrementSuggestionClick throws", async () => {
      mockIncrementSuggestionClick.mockImplementation(() => {
        throw new Error("DB error");
      });
      const res = await req("POST", "/sug-1/click");
      expect(res.status).toBe(204);
    });

    it("returns 401 for unauthenticated", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: false,
          error: "Invalid token",
          status: 401,
        }),
      );
      const res = await req("POST", "/sug-1/click");
      expect(res.status).toBe(401);
    });
  });

  // ─── Org-scoping (null org) ────────────────────────────────────────

  describe("org-scoping", () => {
    it("passes null orgId when user has no activeOrganizationId", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "user-1", mode: "simple-key", label: "User", role: "member" },
        }),
      );
      mockGetPopularSuggestions.mockImplementation(() => Promise.resolve([]));
      await req("GET", "/popular");
      const callArgs = mockGetPopularSuggestions.mock.calls[0] as unknown[];
      expect(callArgs[0]).toBeNull();
    });
  });
});
