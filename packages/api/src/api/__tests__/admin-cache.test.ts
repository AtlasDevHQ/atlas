/**
 * Tests for admin cache management routes.
 *
 * The cache router is mounted under /api/v1/admin/cache via admin.route()
 * and uses createPlatformRouter() — only platform_admin role has access.
 *
 * Endpoints:
 * - GET  /cache/stats  — cache statistics
 * - POST /cache/flush  — flush entire cache
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

const tmpRoot = path.join(process.env.TMPDIR ?? "/tmp", `atlas-cache-test-${Date.now()}`);
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
      mode: "managed",
      user: { id: "platform-admin-1", mode: "managed", label: "platform@test.com", role: "platform_admin", activeOrganizationId: "org-test" },
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
  createConnectionMock({
    connections: {
      get: () => null,
      getDefault: () => null,
      describe: () => [{ id: "default", dbType: "postgres" }],
      healthCheck: mock(() => Promise.resolve({ status: "healthy" })),
      register: mock(() => {}),
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

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  internalQuery: mock(() => Promise.resolve([])),
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
  cascadeWorkspaceDelete: mock(async () => ({ conversations: 0, semanticEntities: 0, learnedPatterns: 0, suggestions: 0, scheduledTasks: 0, settings: 0 })),
  getWorkspaceHealthSummary: mock(async () => null),
  getWorkspaceRegion: mock(async () => null),
  setWorkspaceRegion: mock(async () => ({ assigned: true })),
}));

let mockCacheEnabled = true;
const mockCacheStats = mock(() => ({ hits: 42, misses: 8, entryCount: 15, maxSize: 1000, ttl: 300000 }));
const mockFlushCache = mock(() => {});
const mockGetCache = mock(() => ({
  get: () => null,
  set: () => {},
  delete: () => false,
  flush: () => {},
  stats: mockCacheStats,
}));

const cacheMockFactory = () => ({
  getCache: mockGetCache,
  cacheEnabled: () => mockCacheEnabled,
  setCacheBackend: mock(() => {}),
  flushCache: mockFlushCache,
  getDefaultTtl: mock(() => 300000),
  _resetCache: mock(() => {}),
  buildCacheKey: mock(() => "mock-key"),
});

mock.module("@atlas/api/lib/cache", cacheMockFactory);
// Route handlers use dynamic import("@atlas/api/lib/cache/index")
mock.module("@atlas/api/lib/cache/index", cacheMockFactory);

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
    get: () => null,
    list: () => [],
    getAllHealthy: () => [],
    getByType: () => [],
    size: 0,
  },
  PluginRegistry: class {},
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
  starConversation: async () => false,
  shareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  unshareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  getShareStatus: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  cleanupExpiredShares: mock(() => Promise.resolve(0)),
  getSharedConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  updateNotebookState: mock(() => Promise.resolve({ ok: true })),
  forkConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
}));

mock.module("@atlas/api/lib/auth/types", () => ({
  AUTH_MODES: ["none", "simple-key", "byot", "managed"],
  ATLAS_ROLES: ["member", "admin", "owner"],
  createAtlasUser: (id: string, mode: string, label: string, opts?: Record<string, unknown>) =>
    Object.freeze({ id, mode, label, ...opts }),
}));

mock.module("@atlas/api/lib/security", () => ({
  maskConnectionUrl: (url: string) => url.replace(/\/\/.*@/, "//***@"),
  SENSITIVE_PATTERNS: [],
}));

// --- Import app after mocks ---

const { app } = await import("../index");

// --- Helpers ---

function setPlatformAdmin(): void {
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: { id: "platform-admin-1", mode: "managed", label: "platform@test.com", role: "platform_admin", activeOrganizationId: "org-test" },
    }),
  );
}

function setRegularAdmin(): void {
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: { id: "admin-1", mode: "managed", label: "admin@test.com", role: "admin", activeOrganizationId: "org-test" },
    }),
  );
}

function cacheRequest(urlPath: string, method: "GET" | "POST" = "GET"): Request {
  return new Request(`http://localhost${urlPath}`, {
    method,
    headers: { Authorization: "Bearer test-key" },
  });
}

// --- Cleanup ---

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.ATLAS_SEMANTIC_ROOT;
});

// --- Tests ---

describe("admin cache routes", () => {
  beforeEach(() => {
    mockCacheEnabled = true;
    mockCacheStats.mockClear();
    mockFlushCache.mockClear();
    mockGetCache.mockImplementation(() => ({
      get: () => null,
      set: () => {},
      delete: () => false,
      flush: () => {},
      stats: mockCacheStats,
    }));
    setPlatformAdmin();
  });

  describe("GET /cache/stats", () => {
    it("returns 403 for regular admin (non-platform_admin)", async () => {
      setRegularAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("forbidden_role");
    });

    it("returns cache stats with correct shape for platform admin", async () => {
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.enabled).toBe(true);
      expect(body.hits).toBe(42);
      expect(body.misses).toBe(8);
      // hitRate should be 42/(42+8) = 0.84
      expect(body.hitRate).toBeCloseTo(0.84, 2);
      // missRate should be 8/(42+8) = 0.16
      expect(body.missRate).toBeCloseTo(0.16, 2);
      expect(body.entryCount).toBe(15);
    });

    it("returns hitRate/missRate of 0 when cache is enabled but empty", async () => {
      mockCacheStats.mockReturnValueOnce({ hits: 0, misses: 0, entryCount: 0, maxSize: 1000, ttl: 300000 });
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.enabled).toBe(true);
      expect(body.hitRate).toBe(0);
      expect(body.missRate).toBe(0);
    });

    it("returns fallback response when cache is disabled", async () => {
      mockCacheEnabled = false;
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.enabled).toBe(false);
      expect(body.hits).toBe(0);
      expect(body.misses).toBe(0);
      expect(body.hitRate).toBe(0);
      expect(body.missRate).toBe(0);
      expect(body.entryCount).toBe(0);
    });

    it("returns 500 with requestId when stats() throws", async () => {
      mockGetCache.mockImplementation(() => ({
        get: () => null,
        set: () => {},
        delete: () => false,
        flush: () => {},
        stats: (() => { throw new Error("Redis connection refused"); }) as unknown as typeof mockCacheStats,
      }));
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/stats"));
      expect(res.status).toBe(500);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
      expect(body.requestId).toBeDefined();
    });
  });

  describe("POST /cache/flush", () => {
    it("returns 403 for regular admin (non-platform_admin)", async () => {
      setRegularAdmin();
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(403);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("forbidden_role");
    });

    it("flushes cache successfully for platform admin", async () => {
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.flushed).toBe(15);
      expect(body.message).toBe("Cache flushed");
      expect(mockFlushCache).toHaveBeenCalledTimes(1);
    });

    it("returns disabled response when cache is off", async () => {
      mockCacheEnabled = false;
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
      expect(body.flushed).toBe(0);
      expect(body.message).toBe("Cache is disabled");
      expect(mockFlushCache).not.toHaveBeenCalled();
    });

    it("returns 500 with requestId when flush throws", async () => {
      mockFlushCache.mockImplementation(() => { throw new Error("Redis flush failed"); });
      const res = await app.fetch(cacheRequest("/api/v1/admin/cache/flush", "POST"));
      expect(res.status).toBe(500);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
      expect(body.requestId).toBeDefined();
    });
  });
});
