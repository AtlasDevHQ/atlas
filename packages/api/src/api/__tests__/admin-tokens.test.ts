/**
 * Tests for admin token usage API routes.
 *
 * Mocks everything needed by the Hono app to test the three token endpoints:
 * /tokens/summary, /tokens/by-user, /tokens/trends.
 *
 * All endpoints are org-scoped: queries filter on token_usage.org_id matching
 * the caller's active organization.
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

const tmpRoot = path.join(process.env.TMPDIR ?? "/tmp", `atlas-token-test-${Date.now()}`);
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
      user: { id: "admin-1", mode: "managed", label: "admin@test.com", role: "admin", activeOrganizationId: "org-test" },
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
  cascadeWorkspaceDelete: mock(async () => ({ conversations: 0, semanticEntities: 0, learnedPatterns: 0, suggestions: 0, scheduledTasks: 0, settings: 0 })),
  getWorkspaceHealthSummary: mock(async () => null),
  getWorkspaceRegion: mock(async () => null),
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

function setOrgAdmin(orgId: string): void {
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: { id: "admin-1", mode: "managed", label: "admin@test.com", role: "admin", activeOrganizationId: orgId },
    }),
  );
}

function adminRequest(urlPath: string): Request {
  return new Request(`http://localhost${urlPath}`, {
    method: "GET",
    headers: { Authorization: "Bearer test-key" },
  });
}

// --- Cleanup ---

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.ATLAS_SEMANTIC_ROOT;
});

// --- Tests ---

describe("admin token usage routes", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockInternalQuery.mockReset();
    setOrgAdmin("org-test");
  });

  describe("GET /tokens/summary", () => {
    it("returns token summary with org_id filter", async () => {
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([
          { total_prompt: "15000", total_completion: "5000", total_requests: "10" },
        ]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/summary"));
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience for JSON response body
      const body = await res.json() as any;
      expect(body.totalPromptTokens).toBe(15000);
      expect(body.totalCompletionTokens).toBe(5000);
      expect(body.totalTokens).toBe(20000);
      expect(body.totalRequests).toBe(10);

      // Verify org-scoping: SQL must include org_id filter and pass orgId as param
      const lastCall = mockInternalQuery.mock.calls.at(-1);
      expect(lastCall).toBeDefined();
      const [sql, params] = lastCall!;
      expect(sql).toContain("org_id");
      expect(params).toContain("org-test");
    });

    it("returns 404 when no internal DB", async () => {
      mockHasInternalDB = false;
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/summary"));
      expect(res.status).toBe(404);
    });

    it("returns 403 for non-admin", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "managed",
          user: { id: "user-1", mode: "managed", label: "User", role: "member", activeOrganizationId: "org-test" },
        }),
      );
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/summary"));
      expect(res.status).toBe(403);
    });

    it("accepts date range parameters", async () => {
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([{ total_prompt: "0", total_completion: "0", total_requests: "0" }]);
      });
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/summary?from=2026-01-01&to=2026-03-01"));
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience for JSON response body
      const body = await res.json() as any;
      expect(body.from).toBe("2026-01-01");
      expect(body.to).toBe("2026-03-01");
    });

    it("returns 400 for invalid date format", async () => {
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([]);
      });
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/summary?from=not-a-date"));
      expect(res.status).toBe(400);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience for JSON response body
      const body = await res.json() as any;
      expect(body.error).toBe("invalid_request");
      expect(body.requestId).toBeDefined();
    });

    it("returns 500 when DB query fails", async () => {
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.reject(new Error("connection refused"));
      });
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/summary"));
      expect(res.status).toBe(500);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience for JSON response body
      const body = await res.json() as any;
      expect(body.error).toBe("internal_error");
      expect(body.requestId).toBeDefined();
    });

    it("returns 400 when no active organization", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "managed",
          user: { id: "admin-1", mode: "managed", label: "Admin", role: "admin" },
        }),
      );
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/summary"));
      expect(res.status).toBe(400);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience for JSON response body
      const body = await res.json() as any;
      expect(body.error).toBe("bad_request");
    });
  });

  describe("GET /tokens/by-user", () => {
    it("returns user token breakdown with org_id filter", async () => {
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([
          {
            user_id: "user-1",
            total_prompt: "8000",
            total_completion: "3000",
            total_tokens: "11000",
            request_count: "5",
          },
          {
            user_id: "user-2",
            total_prompt: "4000",
            total_completion: "1500",
            total_tokens: "5500",
            request_count: "3",
          },
        ]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/by-user"));
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience for JSON response body
      const body = await res.json() as any;
      expect(body.users).toHaveLength(2);
      expect(body.users[0].userId).toBe("user-1");
      expect(body.users[0].totalTokens).toBe(11000);
      expect(body.users[1].requestCount).toBe(3);

      // Verify org-scoping
      const lastCall = mockInternalQuery.mock.calls.at(-1);
      expect(lastCall).toBeDefined();
      const [sql, params] = lastCall!;
      expect(sql).toContain("org_id");
      expect(params).toContain("org-test");
    });

    it("returns 404 when no internal DB", async () => {
      mockHasInternalDB = false;
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/by-user"));
      expect(res.status).toBe(404);
    });
  });

  describe("GET /tokens/trends", () => {
    it("returns daily trends with org_id filter", async () => {
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([
          { day: "2026-03-08", prompt_tokens: "5000", completion_tokens: "2000", request_count: "3" },
          { day: "2026-03-09", prompt_tokens: "7000", completion_tokens: "3000", request_count: "5" },
        ]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/trends"));
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience for JSON response body
      const body = await res.json() as any;
      expect(body.trends).toHaveLength(2);
      expect(body.trends[0].day).toBe("2026-03-08");
      expect(body.trends[0].promptTokens).toBe(5000);
      expect(body.trends[0].totalTokens).toBe(7000);
      expect(body.trends[1].requestCount).toBe(5);

      // Verify org-scoping
      const lastCall = mockInternalQuery.mock.calls.at(-1);
      expect(lastCall).toBeDefined();
      const [sql, params] = lastCall!;
      expect(sql).toContain("org_id");
      expect(params).toContain("org-test");
    });

    it("returns 404 when no internal DB", async () => {
      mockHasInternalDB = false;
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/trends"));
      expect(res.status).toBe(404);
    });

    it("returns empty array when no data", async () => {
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([]);
      });
      const res = await app.fetch(adminRequest("/api/v1/admin/tokens/trends"));
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience for JSON response body
      const body = await res.json() as any;
      expect(body.trends).toEqual([]);
    });
  });
});
