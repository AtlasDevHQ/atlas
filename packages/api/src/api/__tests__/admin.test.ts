/**
 * Tests for admin API routes.
 *
 * Mocks: auth middleware, connection registry, internal DB, plugin registry,
 * and transitive dependencies (explore, agent, semantic, conversations, etc.).
 * Uses a real temp directory with fixture YAML files for semantic layer tests.
 * Verifies admin role enforcement and endpoint response shapes.
 */

import { createConnectionMock } from "@atlas/api/testing/connection";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  afterEach,
  mock,
  type Mock,
} from "bun:test";
import * as fs from "fs";
import * as path from "path";

// --- Create temp semantic fixtures before mocks ---

const tmpRoot = path.join(process.env.TMPDIR ?? "/tmp", `atlas-admin-test-${Date.now()}`);

function setupFixtures(): void {
  fs.mkdirSync(path.join(tmpRoot, "entities"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "metrics"), { recursive: true });
  // Per-source subdirectory for multi-source testing
  fs.mkdirSync(path.join(tmpRoot, "warehouse", "entities"), { recursive: true });

  fs.writeFileSync(
    path.join(tmpRoot, "entities", "companies.yml"),
    `table: companies
description: All company records
dimensions:
  id:
    type: integer
    description: Primary key
  name:
    type: text
    description: Company name
  industry:
    type: text
    description: Industry sector
joins:
  to_accounts:
    description: companies.id -> accounts.company_id
measures:
  total_companies:
    sql: "COUNT(DISTINCT id)"
`,
  );

  fs.writeFileSync(
    path.join(tmpRoot, "warehouse", "entities", "orders.yml"),
    `table: orders
description: Warehouse orders
connection: warehouse
dimensions:
  id:
    type: integer
  total:
    type: numeric
`,
  );

  fs.writeFileSync(
    path.join(tmpRoot, "metrics", "total_companies.yml"),
    `name: total_companies
table: companies
sql: "SELECT COUNT(*) FROM companies"
`,
  );

  fs.writeFileSync(
    path.join(tmpRoot, "glossary.yml"),
    `terms:
  - term: ARR
    definition: Annual Recurring Revenue
    ambiguous: false
  - term: churn
    definition: Customer cancellation rate
    ambiguous: true
`,
  );

  fs.writeFileSync(
    path.join(tmpRoot, "catalog.yml"),
    `name: Test Catalog
description: Test catalog for admin tests
`,
  );
}

setupFixtures();

// Point admin routes to our temp directory
process.env.ATLAS_SEMANTIC_ROOT = tmpRoot;

// --- Mocks (before any import that touches the modules) ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin" },
    }),
);

const mockCheckRateLimit: Mock<(key: string) => { allowed: boolean; retryAfterMs?: number }> = mock(
  () => ({ allowed: true }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mockCheckRateLimit,
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  rateLimitCleanupTick: mock(() => {}),
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

const mockDBConnection = {
  query: async () => ({ columns: ["?column?"], rows: [{ "?column?": 1 }] }),
  close: async () => {},
};

const mockHealthCheck: Mock<(id: string) => Promise<unknown>> = mock(() =>
  Promise.resolve({
    status: "healthy",
    latencyMs: 5,
    checkedAt: new Date(),
  }),
);

const mockGetOrgPoolMetrics: Mock<(orgId?: string) => unknown[]> = mock(() => []);
const mockGetOrgPoolConfig: Mock<() => unknown> = mock(() => ({
  enabled: true,
  maxConnections: 5,
  idleTimeoutMs: 30000,
  maxOrgs: 50,
  warmupProbes: 2,
  drainThreshold: 5,
}));
const mockListOrgs: Mock<() => string[]> = mock(() => []);
const mockDrainOrg: Mock<(orgId: string) => Promise<unknown>> = mock(() =>
  Promise.resolve({ drained: 2 }),
);
const mockGetPoolWarnings: Mock<() => string[]> = mock(() => []);
const mockRegister: Mock<(id: string, opts: unknown) => void> = mock(() => {});
const mockUnregister: Mock<(id: string) => void> = mock(() => {});

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => mockDBConnection,
    connections: {
      get: () => mockDBConnection,
      getDefault: () => mockDBConnection,
      describe: () => [
        { id: "default", dbType: "postgres", description: "Test DB" },
      ],
      healthCheck: mockHealthCheck,
      register: mockRegister,
      unregister: mockUnregister,
      getOrgPoolMetrics: mockGetOrgPoolMetrics,
      getOrgPoolConfig: mockGetOrgPoolConfig,
      listOrgs: mockListOrgs,
      drainOrg: mockDrainOrg,
      getPoolWarnings: mockGetPoolWarnings,
      getForOrg: () => mockDBConnection,
    },
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
  getWorkspaceStatus: mock(async () => "active"),
  getWorkspaceDetails: mock(async () => null),
  updateWorkspaceStatus: mock(async () => true),
  updateWorkspacePlanTier: mock(async () => true),
  cascadeWorkspaceDelete: mock(async () => ({ conversations: 0, semanticEntities: 0, learnedPatterns: 0, suggestions: 0, scheduledTasks: 0, settings: 0 })),
  getWorkspaceHealthSummary: mock(async () => null),
  getWorkspaceRegion: mock(async () => null),
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
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

// Org-scoped semantic entities mock
const mockListEntitiesAdmin: Mock<(orgId: string, type?: string) => Promise<unknown[]>> = mock(() => Promise.resolve([]));
const mockGetEntityAdmin: Mock<(orgId: string, type: string, name: string) => Promise<unknown>> = mock(() => Promise.resolve(null));
const mockUpsertEntityAdmin: Mock<(...args: unknown[]) => Promise<void>> = mock(() => Promise.resolve());
const mockDeleteEntityAdmin: Mock<(orgId: string, type: string, name: string) => Promise<boolean>> = mock(() => Promise.resolve(false));
const mockUpsertDraftEntityAdmin: Mock<(...args: unknown[]) => Promise<void>> = mock(() => Promise.resolve());
const mockUpsertTombstoneAdmin: Mock<(...args: unknown[]) => Promise<void>> = mock(() => Promise.resolve());
const mockDeleteDraftEntityAdmin: Mock<(...args: unknown[]) => Promise<boolean>> = mock(() => Promise.resolve(true));
const mockCreateVersion: Mock<(...args: unknown[]) => Promise<string>> = mock(() => Promise.resolve("version-1"));
const mockListVersions: Mock<(...args: unknown[]) => Promise<{ versions: unknown[]; total: number }>> = mock(() => Promise.resolve({ versions: [], total: 0 }));
const mockGetVersion: Mock<(...args: unknown[]) => Promise<unknown>> = mock(() => Promise.resolve(null));
const mockGenerateChangeSummary: Mock<(oldYaml: string | null, newYaml: string) => Promise<string | null>> = mock(() => Promise.resolve("Initial version"));

mock.module("@atlas/api/lib/semantic/entities", () => ({
  listEntities: mockListEntitiesAdmin,
  getEntity: mockGetEntityAdmin,
  upsertEntity: mockUpsertEntityAdmin,
  deleteEntity: mockDeleteEntityAdmin,
  upsertDraftEntity: mockUpsertDraftEntityAdmin,
  upsertTombstone: mockUpsertTombstoneAdmin,
  deleteDraftEntity: mockDeleteDraftEntityAdmin,
  countEntities: mock(() => Promise.resolve(0)),
  bulkUpsertEntities: mock(() => Promise.resolve(0)),
  createVersion: mockCreateVersion,
  listVersions: mockListVersions,
  getVersion: mockGetVersion,
  generateChangeSummary: mockGenerateChangeSummary,
}));

const mockSyncEntityToDisk: Mock<(...args: unknown[]) => Promise<void>> = mock(() => Promise.resolve());
const mockSyncEntityDeleteFromDisk: Mock<(...args: unknown[]) => Promise<void>> = mock(() => Promise.resolve());

mock.module("@atlas/api/lib/semantic/sync", () => ({
  syncEntityToDisk: mockSyncEntityToDisk,
  syncEntityDeleteFromDisk: mockSyncEntityDeleteFromDisk,
  syncAllEntitiesToDisk: mock(() => Promise.resolve(0)),
  importFromDisk: mock(() => Promise.resolve({ imported: 0, skipped: 0, errors: [], total: 0 })),
  reconcileAllOrgs: mock(() => Promise.resolve()),
  cleanupOrgDirectory: mock(() => Promise.resolve()),
  getSemanticRoot: mock(() => "/tmp/test"),
}));

const mockPluginHealthCheck: Mock<() => Promise<unknown>> = mock(() =>
  Promise.resolve({ healthy: true, message: "OK" }),
);

mock.module("@atlas/api/lib/plugins/registry", () => ({
  plugins: {
    describe: () => [
      { id: "test-plugin", types: ["context"], version: "1.0.0", name: "Test Plugin", status: "healthy" },
    ],
    get: (id: string) => {
      if (id === "test-plugin") {
        return {
          id: "test-plugin",
          types: ["context"],
          version: "1.0.0",
          name: "Test Plugin",
          healthCheck: mockPluginHealthCheck,
        };
      }
      if (id === "no-health-plugin") {
        return {
          id: "no-health-plugin",
          types: ["action"],
          version: "0.1.0",
          name: "No Health Plugin",
        };
      }
      return undefined;
    },
    getStatus: (id: string) => {
      if (id === "test-plugin") return "healthy";
      if (id === "no-health-plugin") return "registered";
      return undefined;
    },
    getAllHealthy: () => [],
    getByType: () => [],
    size: 1,
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

mock.module("@atlas/api/lib/tools/actions", () => ({
  createJiraTicket: {
    name: "createJiraTicket",
    description: "Mock",
    tool: { type: "function" },
    actionType: "jira:create",
    reversible: true,
    defaultApproval: "manual",
    requiredCredentials: ["JIRA_BASE_URL"],
  },
  sendEmailReport: {
    name: "sendEmailReport",
    description: "Mock",
    tool: { type: "function" },
    actionType: "email:send",
    reversible: false,
    defaultApproval: "admin-only",
    requiredCredentials: ["RESEND_API_KEY"],
  },
}));

const mockRunDiff: Mock<(connectionId?: string) => Promise<unknown>> = mock(() =>
  Promise.resolve({
    connection: "default",
    newTables: ["new_table"],
    removedTables: ["old_table"],
    tableDiffs: [
      {
        table: "users",
        addedColumns: [{ name: "email", type: "string" }],
        removedColumns: [],
        typeChanges: [{ name: "status", yamlType: "string", dbType: "number" }],
      },
    ],
    unchangedCount: 2,
    summary: { total: 5, new: 1, removed: 1, changed: 1, unchanged: 2 },
  }),
);

mock.module("@atlas/api/lib/semantic/diff", () => ({
  runDiff: mockRunDiff,
  mapSQLType: (t: string) => t,
  parseEntityYAML: () => ({ table: "", columns: new Map(), foreignKeys: new Set() }),
  computeDiff: () => ({ newTables: [], removedTables: [], tableDiffs: [], unchangedCount: 0 }),
  getDBSchema: async () => new Map(),
  getYAMLSnapshots: () => ({ snapshots: new Map(), warnings: [] }),
}));

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mock(() => Promise.resolve(null)),
  addMessage: mock(() => {}),
  persistAssistantSteps: mock(() => {}),
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
  convertToNotebook: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  deleteBranch: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  renameBranch: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
}));

// Import app after all mocks are registered
const { app } = await import("../index");

// --- Helpers ---

function adminRequest(urlPath: string, method = "GET", body?: unknown): Request {
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

function setAdmin(): void {
  mockAuthenticateRequest.mockResolvedValue({
    authenticated: true,
    mode: "simple-key",
    user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin" },
  });
  mockCheckRateLimit.mockReturnValue({ allowed: true });
}

/** Admin with org context — required for org-scoped sub-routers (connections, invitations, etc.). */
function setOrgScopedAdmin(orgId = "org-test-1"): void {
  mockAuthenticateRequest.mockResolvedValue({
    authenticated: true,
    mode: "simple-key",
    user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: orgId },
  });
  mockCheckRateLimit.mockReturnValue({ allowed: true });
}

/** Platform admin — required for platform-only sub-routers (plugins, cache). */
function setPlatformAdmin(): void {
  mockAuthenticateRequest.mockResolvedValue({
    authenticated: true,
    mode: "simple-key",
    user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "platform_admin" },
  });
  mockCheckRateLimit.mockReturnValue({ allowed: true });
}

// --- Cleanup ---

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.ATLAS_SEMANTIC_ROOT;
});

// --- Tests ---

describe("Admin routes — auth enforcement", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    mockCheckRateLimit.mockReset();
    mockCheckRateLimit.mockReturnValue({ allowed: true });
  });

  it("returns 403 when user has member role", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true,
      mode: "simple-key",
      user: { id: "user-1", mode: "simple-key", label: "Member", role: "member" },
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("forbidden_role");
  });

  it("returns 403 when user has no role", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true,
      mode: "simple-key",
      user: { id: "user-1", mode: "simple-key", label: "User" },
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(403);
  });

  it("returns 401 when authentication fails", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: false,
      mode: "simple-key",
      status: 401,
      error: "Invalid API key",
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("auth_error");
  });

  it("returns session_expired when auth error indicates expiry", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: false,
      mode: "managed",
      status: 401,
      error: "Session expired (idle timeout)",
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("session_expired");
  });

  it("allows access when auth mode is none (implicit admin in dev)", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true,
      mode: "none",
      user: undefined,
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(200);
  });

  it("returns 500 when authenticateRequest throws", async () => {
    mockAuthenticateRequest.mockRejectedValue(new Error("DB crashed"));

    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("auth_error");
  });

  it("returns 429 when rate limited", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin" },
    });
    mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });

    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("rate_limited");
  });

  it("enforces admin role on POST endpoints too", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true,
      mode: "simple-key",
      user: { id: "user-1", mode: "simple-key", label: "Member", role: "member" },
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/connections/default/test", "POST"));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/admin/overview", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setAdmin();
  });

  it("returns overview data with correct shape", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.connections).toBe(1);
    // 2 entities: companies (default) + orders (warehouse)
    expect(body.entities).toBe(2);
    expect(body.metrics).toBe(1);
    expect(body.glossaryTerms).toBe(2);
    expect(body.plugins).toBe(1);
    expect(Array.isArray(body.pluginHealth)).toBe(true);
  });

  it("omits poolWarnings when none", async () => {
    mockGetPoolWarnings.mockReturnValue([]);
    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.poolWarnings).toBeUndefined();
  });

  it("includes poolWarnings when capacity is over-provisioned", async () => {
    mockGetPoolWarnings.mockReturnValue([
      "Org pool capacity (50 orgs × 5 conns × 1 datasources = 250 slots) exceeds maxTotalConnections (100) by 2.5×.",
    ]);
    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.poolWarnings)).toBe(true);
    expect((body.poolWarnings as string[]).length).toBe(1);
    expect((body.poolWarnings as string[])[0]).toContain("exceeds maxTotalConnections");
  });
});

describe("GET /api/v1/admin/semantic/entities", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setAdmin();
  });

  it("lists entities from default and per-source directories", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { entities: Array<Record<string, unknown>> };
    expect(body.entities.length).toBe(2);

    const companies = body.entities.find((e) => e.table === "companies");
    expect(companies).toBeDefined();
    expect(companies!.columnCount).toBe(3);
    expect(companies!.joinCount).toBe(1);
    expect(companies!.measureCount).toBe(1);
    expect(companies!.source).toBe("default");

    const orders = body.entities.find((e) => e.table === "orders");
    expect(orders).toBeDefined();
    expect(orders!.source).toBe("warehouse");
    expect(orders!.connection).toBe("warehouse");
  });
});

describe("GET /api/v1/admin/semantic/entities/:name", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setAdmin();
  });

  it("returns full entity detail", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/companies"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { entity: Record<string, unknown> };
    expect(body.entity.table).toBe("companies");
    expect(body.entity.description).toBeDefined();
    expect(body.entity.dimensions).toBeDefined();
  });

  it("returns 404 for non-existent entity", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/nonexistent"));
    expect(res.status).toBe(404);
  });

  it("returns 400 for path traversal attempts", async () => {
    const traversalNames = [
      "../../etc/passwd",
      "..%2F..%2Fetc%2Fpasswd",
      "../.env",
      "foo/bar",
      "foo\\bar",
    ];
    for (const name of traversalNames) {
      const res = await app.fetch(adminRequest(`/api/v1/admin/semantic/entities/${encodeURIComponent(name)}`));
      expect(res.status).toBe(400);
    }
  });

  it("finds entities in per-source subdirectories", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/orders"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { entity: Record<string, unknown> };
    expect(body.entity.table).toBe("orders");
  });
});

describe("GET /api/v1/admin/semantic/metrics", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setAdmin();
  });

  it("lists metrics", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/metrics"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { metrics: unknown[] };
    expect(body.metrics.length).toBe(1);
  });
});

describe("GET /api/v1/admin/semantic/glossary", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setAdmin();
  });

  it("returns glossary data", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/glossary"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { glossary: unknown[] };
    expect(body.glossary.length).toBeGreaterThan(0);
  });
});

describe("GET /api/v1/admin/semantic/catalog", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setAdmin();
  });

  it("returns catalog data", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/catalog"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { catalog: Record<string, unknown> };
    expect(body.catalog).toBeDefined();
    expect(body.catalog.name).toBe("Test Catalog");
  });

  it("returns null when catalog.yml does not exist", async () => {
    // Temporarily rename the catalog file
    const catalogPath = path.join(tmpRoot, "catalog.yml");
    const tempPath = path.join(tmpRoot, "catalog.yml.bak");
    fs.renameSync(catalogPath, tempPath);

    try {
      const res = await app.fetch(adminRequest("/api/v1/admin/semantic/catalog"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { catalog: unknown };
      expect(body.catalog).toBeNull();
    } finally {
      fs.renameSync(tempPath, catalogPath);
    }
  });
});

describe("GET /api/v1/admin/semantic/stats", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setAdmin();
  });

  it("returns aggregate stats including multi-source entities", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/stats"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    // 2 entities: companies (3 cols) + orders (2 cols) = 5 total columns
    expect(body.totalEntities).toBe(2);
    expect(body.totalColumns).toBe(5);
    expect(body.totalJoins).toBe(1);
    expect(body.totalMeasures).toBe(1);
    expect(body.coverageGaps).toBeDefined();
  });
});

describe("GET /api/v1/admin/connections", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setOrgScopedAdmin();
  });

  it("lists connections", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { connections: unknown[] };
    expect(body.connections.length).toBe(1);
  });
});

describe("GET /api/v1/admin/connections/:id", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setOrgScopedAdmin();
    mockInternalQuery.mockReset();
    mockInternalQuery.mockResolvedValue([]);
  });

  it("returns connection detail for registered connection", async () => {
    mockInternalQuery.mockResolvedValue([{ url: "postgresql://localhost/db", schema_name: "public" }]);
    const res = await app.fetch(adminRequest("/api/v1/admin/connections/default"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe("default");
    expect(body.managed).toBe(true);
  });

  it("returns 404 for non-existent connection", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/connections/nonexistent"));
    expect(res.status).toBe(404);
  });

  it("returns 500 when internal DB query fails", async () => {
    mockHasInternalDB = true;
    mockInternalQuery.mockRejectedValue(new Error("DB connection lost"));

    const res = await app.fetch(adminRequest("/api/v1/admin/connections/default"));
    expect(res.status).toBe(500);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("internal_error");
    expect(body.requestId).toBeTruthy();
  });
});

describe("PUT /api/v1/admin/connections/:id — rollback escalation", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setOrgScopedAdmin();
    mockInternalQuery.mockReset();
    mockInternalQuery.mockResolvedValue([]);
    mockHealthCheck.mockReset();
    mockRegister.mockReset();
    mockRegister.mockImplementation(() => {});
  });

  it("returns 400 when URL test fails but rollback succeeds", async () => {
    // Existing connection in DB
    mockInternalQuery.mockResolvedValueOnce([{ id: "warehouse", url: "postgresql://old/db", type: "postgres", description: null, schema_name: null }]);
    mockHealthCheck.mockRejectedValue(new Error("Connection refused"));

    const res = await app.fetch(adminRequest("/api/v1/admin/connections/warehouse", "PUT", { url: "postgresql://bad/url" }));
    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("connection_failed");
    expect(typeof body.message === "string" && !body.message.includes("restart")).toBe(true);
  });

  it("escalates to 500 with restart guidance when rollback fails", async () => {
    // Existing connection in DB
    mockInternalQuery.mockResolvedValueOnce([{ id: "warehouse", url: "postgresql://old/db", type: "postgres", description: null, schema_name: null }]);
    // Health check fails
    mockHealthCheck.mockRejectedValue(new Error("Connection refused"));
    // First call (register new URL) succeeds, second call (rollback) throws
    let callCount = 0;
    mockRegister.mockImplementation(() => {
      callCount++;
      if (callCount >= 2) throw new Error("rollback failed");
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/connections/warehouse", "PUT", { url: "postgresql://bad/url" }));
    expect(res.status).toBe(500);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("internal_error");
    expect(typeof body.message === "string" && body.message.includes("server restart")).toBe(true);
    expect(body.requestId).toBeTruthy();
  });
});

describe("POST /api/v1/admin/connections/:id/test", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setOrgScopedAdmin();
    mockHealthCheck.mockReset();
    mockHealthCheck.mockResolvedValue({
      status: "healthy",
      latencyMs: 5,
      checkedAt: new Date(),
    });
  });

  it("returns health check result for existing connection", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/connections/default/test", "POST"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("healthy");
  });

  it("returns 404 for non-existent connection", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/connections/nonexistent/test", "POST"));
    expect(res.status).toBe(404);
  });

  it("returns 500 when health check throws", async () => {
    mockHealthCheck.mockRejectedValue(new Error("Connection timed out"));

    const res = await app.fetch(adminRequest("/api/v1/admin/connections/default/test", "POST"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("internal_error");
  });
});

describe("GET /api/v1/admin/audit", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setOrgAdmin("org-test");
    mockHasInternalDB = true;
    mockInternalQuery.mockReset();
  });

  it("returns 404 when no internal DB (after auth)", async () => {
    mockHasInternalDB = false;

    const res = await app.fetch(adminRequest("/api/v1/admin/audit"));
    expect(res.status).toBe(404);
  });

  it("checks auth before hasInternalDB (returns 401 not 404 for unauth)", async () => {
    mockHasInternalDB = false;
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: false,
      mode: "simple-key",
      status: 401,
      error: "Invalid API key",
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/audit"));
    expect(res.status).toBe(401);
  });

  it("returns paginated audit log", async () => {
    mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      if (sql.includes("COUNT(*)")) return Promise.resolve([{ count: "5" }]);
      return Promise.resolve([
        { id: "1", timestamp: "2026-01-01", user_id: "u1", success: true, sql: "SELECT 1" },
      ]);
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/audit?limit=10&offset=0"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.total).toBe(5);
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it("supports all filter query params including dates", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      if (!capturedSql && sql.includes("audit_log")) {
        capturedSql = sql;
        capturedParams = params ?? [];
      }
      if (sql.includes("COUNT(*)")) return Promise.resolve([{ count: "0" }]);
      return Promise.resolve([]);
    });

    await app.fetch(adminRequest("/api/v1/admin/audit?user=test-user&success=true&from=2026-01-01&to=2026-03-01"));

    expect(capturedSql).toContain("org_id = $1");
    expect(capturedSql).toContain("user_id = $2");
    expect(capturedSql).toContain("success = $3");
    expect(capturedSql).toContain("timestamp >= $4");
    expect(capturedSql).toContain("timestamp <= $5");
    expect(capturedParams).toContain("org-test");
    expect(capturedParams).toContain("test-user");
    expect(capturedParams).toContain(true);
    expect(capturedParams).toContain("2026-01-01");
    expect(capturedParams).toContain("2026-03-01");
  });

  it("supports search filter across SQL, email, and error", async () => {
    let capturedSql = "";
    mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      if (!capturedSql && sql.includes("audit_log")) {
        capturedSql = sql;
      }
      if (sql.includes("COUNT(*)")) return Promise.resolve([{ count: "0" }]);
      return Promise.resolve([]);
    });

    await app.fetch(adminRequest("/api/v1/admin/audit?search=SELECT"));

    expect(capturedSql).toContain("a.sql ILIKE");
    expect(capturedSql).toContain("u.email ILIKE");
    expect(capturedSql).toContain("a.error ILIKE");
  });

  it("supports connection filter", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      if (!capturedSql && sql.includes("audit_log")) {
        capturedSql = sql;
        capturedParams = params ?? [];
      }
      if (sql.includes("COUNT(*)")) return Promise.resolve([{ count: "0" }]);
      return Promise.resolve([]);
    });

    await app.fetch(adminRequest("/api/v1/admin/audit?connection=warehouse"));

    expect(capturedSql).toContain("source_id");
    expect(capturedParams).toContain("warehouse");
  });

  it("supports table filter via JSONB contains", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      if (!capturedSql && sql.includes("audit_log")) {
        capturedSql = sql;
        capturedParams = params ?? [];
      }
      if (sql.includes("COUNT(*)")) return Promise.resolve([{ count: "0" }]);
      return Promise.resolve([]);
    });

    await app.fetch(adminRequest("/api/v1/admin/audit?table=orders"));

    expect(capturedSql).toContain("tables_accessed ?");
    expect(capturedParams).toContain("orders");
  });

  it("supports column filter via JSONB contains", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      if (!capturedSql && sql.includes("audit_log")) {
        capturedSql = sql;
        capturedParams = params ?? [];
      }
      if (sql.includes("COUNT(*)")) return Promise.resolve([{ count: "0" }]);
      return Promise.resolve([]);
    });

    await app.fetch(adminRequest("/api/v1/admin/audit?column=email"));

    expect(capturedSql).toContain("columns_accessed ?");
    expect(capturedParams).toContain("email");
  });

  it("lowercases table and column filter values", async () => {
    let capturedParams: unknown[] = [];
    mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      if (!capturedParams.length && sql.includes("audit_log")) {
        capturedParams = params ?? [];
      }
      if (sql.includes("COUNT(*)")) return Promise.resolve([{ count: "0" }]);
      return Promise.resolve([]);
    });

    await app.fetch(adminRequest("/api/v1/admin/audit?table=Orders&column=Email"));

    expect(capturedParams).toContain("orders");
    expect(capturedParams).toContain("email");
  });

  it("correctly parameterizes combined new filters (search + connection + table + column)", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      if (!capturedSql && sql.includes("audit_log")) {
        capturedSql = sql;
        capturedParams = params ?? [];
      }
      if (sql.includes("COUNT(*)")) return Promise.resolve([{ count: "0" }]);
      return Promise.resolve([]);
    });

    await app.fetch(adminRequest(
      "/api/v1/admin/audit?connection=warehouse&table=orders&column=revenue&search=test",
    ));

    expect(capturedSql).toContain("org_id = $1");
    expect(capturedSql).toContain("source_id = $2");
    expect(capturedSql).toContain("tables_accessed ? $3");
    expect(capturedSql).toContain("columns_accessed ? $4");
    expect(capturedSql).toContain("a.sql ILIKE $5 OR u.email ILIKE $5 OR a.error ILIKE $5");
    expect(capturedParams).toEqual(["org-test", "warehouse", "orders", "revenue", "%test%"]);
  });

  it("returns 400 for invalid date format", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/audit?from=not-a-date"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_request");
  });

  it("returns 500 when internalQuery throws", async () => {
    mockInternalQuery.mockRejectedValue(new Error("DB connection lost"));

    const res = await app.fetch(adminRequest("/api/v1/admin/audit"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("internal_error");
  });
});

describe("GET /api/v1/admin/audit/export", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setOrgAdmin("org-test");
    mockHasInternalDB = true;
    mockInternalQuery.mockReset();
  });

  it("returns CSV with correct headers", async () => {
    mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      if (sql.includes("COUNT(*)")) return Promise.resolve([{ count: "1" }]);
      return Promise.resolve([
        {
          id: "abc-123",
          timestamp: "2026-03-01T10:00:00Z",
          user_id: "u1",
          sql: "SELECT * FROM orders",
          duration_ms: 42,
          row_count: 10,
          success: true,
          error: null,
          source_id: "default",
          user_email: "admin@test.com",
        },
      ]);
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/audit/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Content-Disposition")).toContain(".csv");

    const body = await res.text();
    expect(body).toContain("id,timestamp,user,sql,duration_ms,row_count,success,error,connection,tables_accessed,columns_accessed");
    expect(body).toContain("admin@test.com");
    expect(body).toContain("SELECT * FROM orders");
  });

  it("escapes CSV fields with quotes", async () => {
    mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      if (sql.includes("COUNT(*)")) return Promise.resolve([{ count: "1" }]);
      return Promise.resolve([
        {
          id: "abc-456",
          timestamp: "2026-03-01T10:00:00Z",
          user_id: "u1",
          sql: 'SELECT "name" FROM users',
          duration_ms: 10,
          row_count: 5,
          success: true,
          error: null,
          source_id: null,
          user_email: null,
        },
      ]);
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/audit/export"));
    const body = await res.text();
    // SQL with double-quotes should be escaped
    expect(body).toContain('""name""');
  });

  it("respects filters on export", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      if (sql.includes("COUNT(*)")) return Promise.resolve([{ count: "0" }]);
      if (sql.includes("audit_log")) {
        capturedSql = sql;
        capturedParams = params ?? [];
      }
      return Promise.resolve([]);
    });

    await app.fetch(adminRequest("/api/v1/admin/audit/export?connection=warehouse&success=false"));

    expect(capturedSql).toContain("source_id");
    expect(capturedSql).toContain("success");
    expect(capturedParams).toContain("warehouse");
    expect(capturedParams).toContain(false);
  });

  it("returns 403 for non-admin user", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true,
      mode: "simple-key",
      user: { id: "user-1", mode: "simple-key", label: "User", role: "member" },
    });
    const res = await app.fetch(adminRequest("/api/v1/admin/audit/export"));
    expect(res.status).toBe(403);
  });

  it("returns CSV with only headers when no rows match", async () => {
    mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      if (sql.includes("COUNT(*)")) return Promise.resolve([{ count: "0" }]);
      return Promise.resolve([]);
    });
    const res = await app.fetch(adminRequest("/api/v1/admin/audit/export"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("id,timestamp,user,sql,duration_ms,row_count,success,error,connection,tables_accessed,columns_accessed\n");
  });

  it("returns 400 for invalid date on export", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/audit/export?from=garbage"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when no internal DB", async () => {
    mockHasInternalDB = false;
    const res = await app.fetch(adminRequest("/api/v1/admin/audit/export"));
    expect(res.status).toBe(404);
  });

  it("returns 500 when query throws", async () => {
    mockInternalQuery.mockRejectedValue(new Error("DB error"));
    const res = await app.fetch(adminRequest("/api/v1/admin/audit/export"));
    expect(res.status).toBe(500);
  });

  it("scopes export queries to active org", async () => {
    mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      if (sql.includes("COUNT(*)")) return Promise.resolve([{ count: "0" }]);
      return Promise.resolve([]);
    });

    await app.fetch(adminRequest("/api/v1/admin/audit/export"));

    const auditCalls = mockInternalQuery.mock.calls.filter(([sql]) => typeof sql === "string" && sql.includes("audit_log"));
    expect(auditCalls.length).toBeGreaterThan(0);
    for (const [sql, params] of auditCalls) {
      expect(sql).toContain("org_id = $1");
      expect(params).toContain("org-test");
    }
  });
});

describe("GET /api/v1/admin/audit/stats", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setOrgAdmin("org-test");
    mockHasInternalDB = true;
    mockInternalQuery.mockReset();
  });

  it("returns 404 when no internal DB", async () => {
    mockHasInternalDB = false;

    const res = await app.fetch(adminRequest("/api/v1/admin/audit/stats"));
    expect(res.status).toBe(404);
  });

  it("returns audit stats", async () => {
    let statsCallCount = 0;
    mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      statsCallCount++;
      if (statsCallCount === 1) return Promise.resolve([{ total: "100", errors: "5" }]);
      return Promise.resolve([
        { day: "2026-03-01", count: "20" },
        { day: "2026-02-28", count: "15" },
      ]);
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/audit/stats"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.totalQueries).toBe(100);
    expect(body.totalErrors).toBe(5);
    expect(body.errorRate).toBe(5);
    expect(Array.isArray(body.queriesPerDay)).toBe(true);
  });

  it("returns 500 when internalQuery throws", async () => {
    mockInternalQuery.mockRejectedValue(new Error("DB timeout"));

    const res = await app.fetch(adminRequest("/api/v1/admin/audit/stats"));
    expect(res.status).toBe(500);
  });

  it("scopes queries to active org", async () => {
    mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      return Promise.resolve([{ total: "0", errors: "0", day: "2026-01-01", count: "0" }]);
    });

    await app.fetch(adminRequest("/api/v1/admin/audit/stats"));

    const auditCalls = mockInternalQuery.mock.calls.filter(([sql]) => typeof sql === "string" && sql.includes("audit_log"));
    expect(auditCalls.length).toBeGreaterThan(0);
    for (const [sql, params] of auditCalls) {
      expect(sql).toContain("org_id = $1");
      expect(params).toContain("org-test");
    }
  });
});

describe("GET /api/v1/admin/audit/facets", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setOrgAdmin("org-test");
    mockHasInternalDB = true;
    mockInternalQuery.mockReset();
  });

  it("returns tables and columns arrays", async () => {
    mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      if (sql.includes("tables_accessed")) return Promise.resolve([{ val: "users" }, { val: "orders" }]);
      if (sql.includes("columns_accessed")) return Promise.resolve([{ val: "email" }]);
      return Promise.resolve([]);
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/audit/facets"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { tables: string[]; columns: string[] };
    expect(body.tables).toEqual(["users", "orders"]);
    expect(body.columns).toEqual(["email"]);
  });

  it("scopes queries to active org", async () => {
    mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    await app.fetch(adminRequest("/api/v1/admin/audit/facets"));

    const auditCalls = mockInternalQuery.mock.calls.filter(([sql]) => typeof sql === "string" && sql.includes("audit_log"));
    expect(auditCalls.length).toBe(2);
    for (const [sql, params] of auditCalls) {
      expect(sql).toContain("org_id = $1");
      expect(params).toContain("org-test");
    }
  });

  it("returns empty arrays with warnings on partial failure", async () => {
    mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      if (sql.includes("tables_accessed")) return Promise.reject(new Error("JSONB parse error"));
      if (sql.includes("columns_accessed")) return Promise.resolve([{ val: "email" }]);
      return Promise.resolve([]);
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/audit/facets"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { tables: string[]; columns: string[]; warnings?: string[] };
    expect(body.tables).toEqual([]);
    expect(body.columns).toEqual(["email"]);
    expect(body.warnings).toEqual(["Failed to load table filter values"]);
  });

  it("returns 404 when no internal DB", async () => {
    mockHasInternalDB = false;
    const res = await app.fetch(adminRequest("/api/v1/admin/audit/facets"));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/admin/plugins", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setPlatformAdmin();
  });

  it("lists plugins", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/plugins"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { plugins: unknown[] };
    expect(body.plugins.length).toBe(1);
  });
});

describe("POST /api/v1/admin/plugins/:id/health", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setPlatformAdmin();
    mockPluginHealthCheck.mockReset();
    mockPluginHealthCheck.mockResolvedValue({ healthy: true, message: "OK" });
  });

  it("returns health check result for existing plugin", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/plugins/test-plugin/health", "POST"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.healthy).toBe(true);
  });

  it("returns 404 for non-existent plugin", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/plugins/nonexistent/health", "POST"));
    expect(res.status).toBe(404);
  });

  it("returns 500 when healthCheck throws", async () => {
    mockPluginHealthCheck.mockRejectedValue(new Error("Plugin crashed"));

    const res = await app.fetch(adminRequest("/api/v1/admin/plugins/test-plugin/health", "POST"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.healthy).toBe(false);
    // Should not leak raw error message
    expect(body.message).toBe("Plugin health check failed unexpectedly.");
  });

  it("returns fallback for plugin without healthCheck method", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/plugins/no-health-plugin/health", "POST"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.healthy).toBe(true);
    expect(body.message).toBe("Plugin does not implement healthCheck.");
    expect(body.status).toBe("registered");
  });
});

// ---------------------------------------------------------------------------
// Audit analytics
// ---------------------------------------------------------------------------

describe("Admin routes — audit analytics", () => {
  beforeEach(() => {
    setOrgAdmin("org-test");
    mockHasInternalDB = true;
    mockInternalQuery.mockReset();
  });

  // Volume
  describe("GET /audit/analytics/volume", () => {
    it("returns daily volume data", async () => {
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([
          { day: "2026-03-01", count: "10", errors: "2" },
          { day: "2026-03-02", count: "15", errors: "0" },
        ]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/volume"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { volume: { day: string; count: number; errors: number }[] };
      expect(body.volume).toHaveLength(2);
      expect(body.volume[0].count).toBe(10);
      expect(body.volume[0].errors).toBe(2);
      expect(body.volume[1].count).toBe(15);
    });

    it("passes date range params to query", async () => {
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/volume?from=2026-03-01&to=2026-03-07"));
      expect(res.status).toBe(200);
      const auditCall = mockInternalQuery.mock.calls.find(([sql]) => sql.includes("audit_log"));
      expect(auditCall).toBeDefined();
      const [sql, params] = auditCall!;
      expect(sql).toContain("timestamp >=");
      expect(sql).toContain("timestamp <=");
      expect(params).toEqual(["org-test", "2026-03-01", "2026-03-07"]);
    });

    it("returns 400 for invalid date", async () => {
      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/volume?from=not-a-date"));
      expect(res.status).toBe(400);
    });

    it("returns 404 when no internal DB", async () => {
      mockHasInternalDB = false;
      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/volume"));
      expect(res.status).toBe(404);
    });
  });

  // Slow queries
  describe("GET /audit/analytics/slow", () => {
    it("returns top slow queries", async () => {
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([
          { query: "SELECT * FROM big_table", avg_duration: "1500", max_duration: "3000", count: "5" },
        ]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/slow"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { queries: { query: string; avgDuration: number; maxDuration: number; count: number }[] };
      expect(body.queries).toHaveLength(1);
      expect(body.queries[0].avgDuration).toBe(1500);
      expect(body.queries[0].maxDuration).toBe(3000);
      expect(body.queries[0].count).toBe(5);
    });
  });

  // Frequent queries
  describe("GET /audit/analytics/frequent", () => {
    it("returns top frequent queries", async () => {
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([
          { query: "SELECT 1", count: "100", avg_duration: "5", error_count: "3" },
        ]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/frequent"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { queries: { query: string; count: number; avgDuration: number; errorCount: number }[] };
      expect(body.queries).toHaveLength(1);
      expect(body.queries[0].count).toBe(100);
      expect(body.queries[0].errorCount).toBe(3);
    });
  });

  // Errors
  describe("GET /audit/analytics/errors", () => {
    it("returns error breakdown", async () => {
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([
          { error: "relation does not exist", count: "8" },
          { error: "permission denied", count: "3" },
        ]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/errors"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { errors: { error: string; count: number }[] };
      expect(body.errors).toHaveLength(2);
      expect(body.errors[0].count).toBe(8);
      expect(body.errors[1].error).toBe("permission denied");
    });

    it("combines date range with error filter", async () => {
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/errors?from=2026-03-01"));
      expect(res.status).toBe(200);
      const auditCall = mockInternalQuery.mock.calls.find(([sql]) => sql.includes("audit_log"));
      expect(auditCall).toBeDefined();
      const [sql] = auditCall!;
      expect(sql).toContain("timestamp >=");
      expect(sql).toContain("NOT success");
    });
  });

  // Users
  describe("GET /audit/analytics/users", () => {
    it("returns per-user stats with error rate", async () => {
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([
          { user_id: "user-1", count: "50", avg_duration: "120", error_count: "5" },
          { user_id: "user-2", count: "20", avg_duration: "80", error_count: "0" },
        ]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/users"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { users: { userId: string; count: number; avgDuration: number; errorCount: number; errorRate: number }[] };
      expect(body.users).toHaveLength(2);
      expect(body.users[0].userId).toBe("user-1");
      expect(body.users[0].count).toBe(50);
      expect(body.users[0].errorRate).toBe(0.1);
      expect(body.users[1].errorRate).toBe(0);
    });
  });

  // Cross-cutting: auth, errors, date validation
  describe("shared behavior", () => {
    it("returns 403 for non-admin users on analytics endpoints", async () => {
      mockAuthenticateRequest.mockResolvedValue({
        authenticated: true,
        mode: "simple-key",
        user: { id: "user-1", mode: "simple-key", label: "Member", role: "member" },
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/volume"));
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("forbidden_role");
    });

    it("checks auth before hasInternalDB (returns 401 not 404 for unauth)", async () => {
      mockHasInternalDB = false;
      mockAuthenticateRequest.mockResolvedValue({
        authenticated: false,
        mode: "simple-key",
        status: 401,
        error: "Invalid API key",
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/volume"));
      expect(res.status).toBe(401);
    });

    it("returns 500 when internalQuery throws", async () => {
      mockInternalQuery.mockRejectedValue(new Error("connection reset"));

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/volume"));
      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
    });

    it("returns 400 for invalid 'to' date", async () => {
      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/volume?to=garbage"));
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_request");
    });

    it("returns 400 for valid 'from' + invalid 'to'", async () => {
      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/volume?from=2026-03-01&to=garbage"));
      expect(res.status).toBe(400);
    });

    it("handles 'to'-only date range", async () => {
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/volume?to=2026-03-07"));
      expect(res.status).toBe(200);
      const auditCall = mockInternalQuery.mock.calls.find(([sql]) => sql.includes("audit_log"));
      expect(auditCall).toBeDefined();
      const [sql, params] = auditCall!;
      expect(sql).toContain("timestamp <=");
      expect(sql).not.toContain("timestamp >=");
      expect(params).toEqual(["org-test", "2026-03-07"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Semantic diff endpoint
// ---------------------------------------------------------------------------

describe("Admin routes — semantic diff", () => {
  beforeEach(() => {
    setAdmin();
    mockRunDiff.mockClear();
  });

  it("GET /semantic/diff returns structured diff", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/diff"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.connection).toBe("default");
    expect(body.newTables).toEqual(["new_table"]);
    expect(body.removedTables).toEqual(["old_table"]);
    expect(Array.isArray(body.tableDiffs)).toBe(true);
    expect(body.unchangedCount).toBe(2);
    expect(body.summary).toEqual({ total: 5, new: 1, removed: 1, changed: 1, unchanged: 2 });
  });

  it("passes connection query param and mode/org context to runDiff", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/diff?connection=default"));
    expect(res.status).toBe(200);
    expect(mockRunDiff).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ atlasMode: expect.any(String) }),
    );
  });

  it("returns 404 for unknown connection", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/diff?connection=unknown"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });

  it("returns 500 with specific message when runDiff throws", async () => {
    mockRunDiff.mockRejectedValueOnce(new Error("DB unreachable"));
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/diff"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("internal_error");
    expect(body.message).toContain("DB unreachable");
  });

  it("requires admin role", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true,
      mode: "simple-key",
      user: { id: "user-1", mode: "simple-key", label: "Member", role: "member" },
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/diff"));
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Org-scoped semantic entity CRUD
// ---------------------------------------------------------------------------

function setOrgAdmin(orgId: string): void {
  mockAuthenticateRequest.mockResolvedValue({
    authenticated: true,
    mode: "managed",
    user: { id: "admin-1", mode: "managed", label: "admin@test.com", role: "admin", activeOrganizationId: orgId },
  });
  mockCheckRateLimit.mockReturnValue({ allowed: true });
}

describe("GET /api/v1/admin/semantic/org/entities", () => {
  beforeEach(() => {
    setAdmin();
    mockHasInternalDB = true;
    mockListEntitiesAdmin.mockReset();
    mockListEntitiesAdmin.mockResolvedValue([]);
  });

  it("returns 400 when no active organization", async () => {
    setAdmin(); // no org
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("org_not_found");
  });

  it("returns 501 when no internal DB", async () => {
    setOrgAdmin("org-1");
    mockHasInternalDB = false;
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities"));
    expect(res.status).toBe(501);
  });

  it("lists entities for org", async () => {
    setOrgAdmin("org-1");
    mockListEntitiesAdmin.mockResolvedValue([
      { name: "users", entity_type: "entity", connection_id: null, updated_at: "2026-01-01" },
    ]);
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entities: Array<{ name: string }> };
    expect(body.entities).toHaveLength(1);
    expect(body.entities[0].name).toBe("users");
  });

  it("rejects invalid type parameter", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities?type=invalid"));
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/v1/admin/semantic/org/entities/:name", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockUpsertEntityAdmin.mockReset();
    mockUpsertEntityAdmin.mockResolvedValue(undefined);
  });

  it("returns 400 with org_not_found when no active organization", async () => {
    setAdmin();
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities/users", "PUT", { yamlContent: "table: users" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("org_not_found");
  });

  it("returns 400 when yamlContent is missing", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities/users", "PUT", {}));
    expect(res.status).toBe(422);
  });

  it("returns 400 for invalid YAML", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities/users", "PUT", { yamlContent: "{{{" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("Invalid YAML");
  });

  it("returns 400 when entity YAML has no table field", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities/users", "PUT", {
      yamlContent: "description: no table field here",
    }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).message).toContain("table");
  });

  it("upserts valid entity", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities/users", "PUT", {
      yamlContent: "table: users\ndescription: User accounts",
    }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).ok).toBe(true);
    expect(mockUpsertEntityAdmin).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid entityType", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities/users", "PUT", {
      yamlContent: "table: users",
      entityType: "DROP TABLE",
    }));
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/v1/admin/semantic/org/entities/:name", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockDeleteEntityAdmin.mockReset();
  });

  it("returns 400 with org_not_found when no active organization", async () => {
    setAdmin();
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities/users", "DELETE"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("org_not_found");
  });

  it("returns 404 when entity not found", async () => {
    setOrgAdmin("org-1");
    mockDeleteEntityAdmin.mockResolvedValue(false);
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities/nonexistent", "DELETE"));
    expect(res.status).toBe(404);
  });

  it("deletes existing entity", async () => {
    setOrgAdmin("org-1");
    mockDeleteEntityAdmin.mockResolvedValue(true);
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities/users", "DELETE"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structured semantic entity editor (#1124)
// ---------------------------------------------------------------------------

describe("PUT /api/v1/admin/semantic/entities/edit/:name", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockUpsertEntityAdmin.mockReset();
    mockUpsertEntityAdmin.mockResolvedValue(undefined);
    mockSyncEntityToDisk.mockReset();
    mockSyncEntityToDisk.mockResolvedValue(undefined);
  });

  it("returns 400 when no active organization", async () => {
    setAdmin();
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/users", "PUT", {
      table: "users",
      description: "User accounts",
    }));
    expect(res.status).toBe(400);
  });

  it("returns 501 when no internal DB", async () => {
    setOrgAdmin("org-1");
    mockHasInternalDB = false;
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/users", "PUT", {
      table: "users",
    }));
    expect(res.status).toBe(501);
  });

  it("creates entity from structured data with YAML round-trip verification", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/users", "PUT", {
      table: "users",
      description: "User accounts",
      dimensions: [
        { name: "id", sql: "id", type: "number", description: "Primary key", primary_key: true },
        { name: "email", sql: "email", type: "string", description: "Email address", sample_values: ["a@b.com"] },
      ],
      measures: [
        { name: "total_users", sql: "COUNT(*)", type: "count", description: "Total user count" },
      ],
      joins: [
        { name: "to_orders", sql: "users.id = orders.user_id", description: "User orders" },
      ],
      query_patterns: [
        { name: "user_count", sql: "SELECT COUNT(*) FROM users", description: "Count all users" },
      ],
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.name).toBe("users");
    expect(body.entityType).toBe("entity");
    expect(mockUpsertEntityAdmin).toHaveBeenCalledTimes(1);

    // Verify YAML round-trip: parse back and check structure
    const call = (mockUpsertEntityAdmin.mock.calls as unknown[][])[0];
    expect(call?.[0]).toBe("org-1");
    expect(call?.[1]).toBe("entity");
    expect(call?.[2]).toBe("users");
    const yamlContent = call?.[3] as string;

    const yaml = await import("js-yaml");
    const parsed = yaml.load(yamlContent) as Record<string, unknown>;
    expect(parsed.table).toBe("users");
    expect(parsed.description).toBe("User accounts");
    expect(Array.isArray(parsed.dimensions)).toBe(true);
    const dims = parsed.dimensions as Array<Record<string, unknown>>;
    expect(dims).toHaveLength(2);
    expect(dims[0].name).toBe("id");
    expect(dims[0].primary_key).toBe(true);
    expect(dims[1].sample_values).toEqual(["a@b.com"]);
    expect(Array.isArray(parsed.measures)).toBe(true);
    expect((parsed.measures as Array<Record<string, unknown>>)[0].sql).toBe("COUNT(*)");
    expect(Array.isArray(parsed.joins)).toBe(true);
    expect(Array.isArray(parsed.query_patterns)).toBe(true);

    // Verify sync was called
    expect(mockSyncEntityToDisk).toHaveBeenCalledTimes(1);
  });

  it("creates minimal entity — YAML omits empty sections", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/orders", "PUT", {
      table: "orders",
    }));
    expect(res.status).toBe(200);
    expect(mockUpsertEntityAdmin).toHaveBeenCalledTimes(1);

    const yamlContent = (mockUpsertEntityAdmin.mock.calls as unknown[][])[0]?.[3] as string;
    expect(yamlContent).toContain("table: orders");
    expect(yamlContent).not.toContain("dimensions:");
    expect(yamlContent).not.toContain("measures:");
    expect(yamlContent).not.toContain("joins:");
    expect(yamlContent).not.toContain("query_patterns:");
  });

  it("forwards connectionId to upsertEntity", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/orders", "PUT", {
      table: "orders",
      connectionId: "warehouse",
    }));
    expect(res.status).toBe(200);
    const call = (mockUpsertEntityAdmin.mock.calls as unknown[][])[0];
    expect(call?.[4]).toBe("warehouse");
  });

  it("returns 500 when upsertEntity throws", async () => {
    setOrgAdmin("org-1");
    mockUpsertEntityAdmin.mockRejectedValue(new Error("DB connection lost"));
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/users", "PUT", {
      table: "users",
    }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.requestId).toBeDefined();
  });

  it("returns 422 when table name is missing", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/users", "PUT", {
      description: "No table",
    }));
    expect(res.status).toBe(422);
  });

  it("returns 422 when dimension type is invalid", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/users", "PUT", {
      table: "users",
      dimensions: [{ name: "id", sql: "id", type: "invalid_type" }],
    }));
    expect(res.status).toBe(422);
  });

  it("returns 422 when measure type is invalid", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/users", "PUT", {
      table: "users",
      measures: [{ name: "total", sql: "COUNT(*)", type: "bad" }],
    }));
    expect(res.status).toBe(422);
  });
});

describe("DELETE /api/v1/admin/semantic/entities/edit/:name", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockDeleteEntityAdmin.mockReset();
    mockSyncEntityDeleteFromDisk.mockReset();
    mockSyncEntityDeleteFromDisk.mockResolvedValue(undefined);
  });

  it("returns 400 when no active organization", async () => {
    setAdmin();
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/users", "DELETE"));
    expect(res.status).toBe(400);
  });

  it("returns 501 when no internal DB", async () => {
    setOrgAdmin("org-1");
    mockHasInternalDB = false;
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/users", "DELETE"));
    expect(res.status).toBe(501);
  });

  it("returns 404 when entity not found", async () => {
    setOrgAdmin("org-1");
    mockDeleteEntityAdmin.mockResolvedValue(false);
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/nonexistent", "DELETE"));
    expect(res.status).toBe(404);
  });

  it("deletes existing entity and calls sync", async () => {
    setOrgAdmin("org-1");
    mockDeleteEntityAdmin.mockResolvedValue(true);
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/users", "DELETE"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.name).toBe("users");
    expect(body.entityType).toBe("entity");
    expect(mockSyncEntityDeleteFromDisk).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Column metadata endpoint (#1125)
// ---------------------------------------------------------------------------

describe("GET /api/v1/admin/semantic/columns/:tableName", () => {
  const originalQuery = mockDBConnection.query;

  beforeEach(() => {
    // Default: return column metadata for a "users" table
    (mockDBConnection as { query: (...args: unknown[]) => Promise<unknown> }).query = async (sql: unknown) => {
      if (typeof sql === "string" && sql.includes("information_schema")) {
        return {
          columns: ["name", "type", "nullable"],
          rows: [
            { name: "id", type: "integer", nullable: "NO" },
            { name: "email", type: "character varying", nullable: "NO" },
            { name: "created_at", type: "timestamp with time zone", nullable: "YES" },
          ],
        };
      }
      return originalQuery();
    };
  });

  afterEach(() => {
    mockDBConnection.query = originalQuery;
  });

  it("returns 400 when no active organization", async () => {
    setAdmin();
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/columns/users"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid table names", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/columns/'; DROP TABLE users;--"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_table_name");
  });

  it("returns column metadata for a valid table", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/columns/users"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { columns: Array<{ name: string; type: string; nullable: boolean }> };
    expect(body.columns).toHaveLength(3);
    expect(body.columns[0]).toEqual({ name: "id", type: "integer", nullable: false });
    expect(body.columns[1]).toEqual({ name: "email", type: "character varying", nullable: false });
    expect(body.columns[2]).toEqual({ name: "created_at", type: "timestamp with time zone", nullable: true });
  });

  it("returns 404 when table has no columns (not found)", async () => {
    setOrgAdmin("org-1");
    (mockDBConnection as { query: (...args: unknown[]) => Promise<unknown> }).query = async () => ({
      columns: ["name", "type", "nullable"],
      rows: [],
    });
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/columns/nonexistent_table"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });

  it("returns 500 when datasource query fails", async () => {
    setOrgAdmin("org-1");
    (mockDBConnection as { query: (...args: unknown[]) => Promise<unknown> }).query = async () => {
      throw new Error("Connection refused");
    };
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/columns/users"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("query_failed");
    expect(body.requestId).toBeDefined();
  });

  it("splits schema-qualified table names into schema + table", async () => {
    setOrgAdmin("org-1");
    let capturedSql = "";
    (mockDBConnection as { query: (...args: unknown[]) => Promise<unknown> }).query = async (sql: unknown) => {
      capturedSql = String(sql);
      return {
        columns: ["name", "type", "nullable"],
        rows: [{ name: "id", type: "integer", nullable: "NO" }],
      };
    };
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/columns/public.users"));
    expect(res.status).toBe(200);
    // Verify schema and table were split correctly in the SQL
    expect(capturedSql).toContain("table_name = 'users'");
    expect(capturedSql).toContain("table_schema = 'public'");
  });
});

// ---------------------------------------------------------------------------
// Entity version history (#1126)
// ---------------------------------------------------------------------------

describe("GET /api/v1/admin/semantic/entities/:name/versions", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockListVersions.mockReset();
    mockListVersions.mockResolvedValue({ versions: [], total: 0 });
  });

  it("returns 400 when no active organization", async () => {
    setAdmin();
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/users/versions"));
    expect(res.status).toBe(400);
  });

  it("returns 501 when no internal DB", async () => {
    setOrgAdmin("org-1");
    mockHasInternalDB = false;
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/users/versions"));
    expect(res.status).toBe(501);
  });

  it("returns empty version list for entity with no history", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/users/versions"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versions: unknown[]; total: number };
    expect(body.versions).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns version list with correct shape", async () => {
    setOrgAdmin("org-1");
    mockListVersions.mockResolvedValue({
      versions: [
        { id: "v-2", entity_id: "e-1", org_id: "org-1", entity_type: "entity", name: "users", change_summary: "+1 dimension", author_id: "admin-1", author_label: "admin@test.com", version_number: 2, created_at: "2026-04-01T12:00:00Z" },
        { id: "v-1", entity_id: "e-1", org_id: "org-1", entity_type: "entity", name: "users", change_summary: "Initial version", author_id: "admin-1", author_label: "admin@test.com", version_number: 1, created_at: "2026-04-01T10:00:00Z" },
      ],
      total: 2,
    });
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/users/versions"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versions: Array<{ id: string; versionNumber: number; changeSummary: string }>; total: number };
    expect(body.total).toBe(2);
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0].versionNumber).toBe(2);
    expect(body.versions[0].changeSummary).toBe("+1 dimension");
    expect(body.versions[1].versionNumber).toBe(1);
  });

  it("passes limit and offset query params", async () => {
    setOrgAdmin("org-1");
    await app.fetch(adminRequest("/api/v1/admin/semantic/entities/users/versions?limit=5&offset=10"));
    expect(mockListVersions).toHaveBeenCalledWith("org-1", "entity", "users", 5, 10);
  });
});

describe("GET /api/v1/admin/semantic/entities/versions/:versionId", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockGetVersion.mockReset();
    mockGetVersion.mockResolvedValue(null);
  });

  it("returns 400 when no active organization", async () => {
    setAdmin();
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/versions/550e8400-e29b-41d4-a716-446655440000"));
    expect(res.status).toBe(400);
  });

  it("returns 501 when no internal DB", async () => {
    setOrgAdmin("org-1");
    mockHasInternalDB = false;
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/versions/550e8400-e29b-41d4-a716-446655440000"));
    expect(res.status).toBe(501);
  });

  it("returns 404 when version not found", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/versions/550e8400-e29b-41d4-a716-446655440000"));
    expect(res.status).toBe(404);
  });

  it("returns version detail with full YAML content", async () => {
    setOrgAdmin("org-1");
    mockGetVersion.mockResolvedValue({
      id: "v-1",
      entity_id: "e-1",
      org_id: "org-1",
      entity_type: "entity",
      name: "users",
      yaml_content: "table: users\ndescription: User accounts\n",
      change_summary: "Initial version",
      author_id: "admin-1",
      author_label: "admin@test.com",
      version_number: 1,
      created_at: "2026-04-01T10:00:00Z",
    });
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/versions/v-1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: { id: string; versionNumber: number; yamlContent: string; name: string } };
    expect(body.version.id).toBe("v-1");
    expect(body.version.versionNumber).toBe(1);
    expect(body.version.yamlContent).toContain("table: users");
    expect(body.version.name).toBe("users");
  });
});

describe("POST /api/v1/admin/semantic/entities/:name/rollback", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockGetVersion.mockReset();
    mockGetEntityAdmin.mockReset();
    mockUpsertEntityAdmin.mockReset();
    mockUpsertEntityAdmin.mockResolvedValue(undefined);
    mockCreateVersion.mockReset();
    mockCreateVersion.mockResolvedValue("new-version-id");
    mockGenerateChangeSummary.mockReset();
    mockGenerateChangeSummary.mockResolvedValue(null);
    mockSyncEntityToDisk.mockReset();
    mockSyncEntityToDisk.mockResolvedValue(undefined);
  });

  it("returns 400 when no active organization", async () => {
    setAdmin();
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/users/rollback", "POST", {
      versionId: "550e8400-e29b-41d4-a716-446655440000",
    }));
    expect(res.status).toBe(400);
  });

  it("returns 501 when no internal DB", async () => {
    setOrgAdmin("org-1");
    mockHasInternalDB = false;
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/users/rollback", "POST", {
      versionId: "550e8400-e29b-41d4-a716-446655440000",
    }));
    expect(res.status).toBe(501);
  });

  it("returns 404 when version not found", async () => {
    setOrgAdmin("org-1");
    mockGetVersion.mockResolvedValue(null);
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/users/rollback", "POST", {
      versionId: "550e8400-e29b-41d4-a716-446655440000",
    }));
    expect(res.status).toBe(404);
  });

  it("returns 404 when version name does not match entity name", async () => {
    setOrgAdmin("org-1");
    mockGetVersion.mockResolvedValue({
      id: "550e8400-e29b-41d4-a716-446655440001", entity_id: "e-1", org_id: "org-1", entity_type: "entity",
      name: "orders", yaml_content: "table: orders\n", change_summary: null,
      author_id: null, author_label: null, version_number: 1, created_at: "2026-04-01T10:00:00Z",
    });
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/users/rollback", "POST", {
      versionId: "550e8400-e29b-41d4-a716-446655440001",
    }));
    expect(res.status).toBe(404);
  });

  it("rolls back entity to target version", async () => {
    setOrgAdmin("org-1");
    const targetYaml = "table: users\ndescription: Rolled back version\n";
    const versionUuid = "550e8400-e29b-41d4-a716-446655440001";
    const newVersionUuid = "550e8400-e29b-41d4-a716-446655440003";
    mockGetVersion
      .mockResolvedValueOnce({
        id: versionUuid, entity_id: "e-1", org_id: "org-1", entity_type: "entity",
        name: "users", yaml_content: targetYaml, change_summary: "Initial version",
        author_id: "admin-1", author_label: "admin@test.com", version_number: 1,
        created_at: "2026-04-01T10:00:00Z",
      })
      // Second call: getVersion for newly created rollback version
      .mockResolvedValueOnce({
        id: newVersionUuid, entity_id: "e-1", org_id: "org-1", entity_type: "entity",
        name: "users", yaml_content: targetYaml, change_summary: "Rolled back to v1",
        author_id: "admin-1", author_label: "admin@test.com", version_number: 3,
        created_at: "2026-04-01T14:00:00Z",
      });

    // Current entity for change summary + post-upsert entity
    mockGetEntityAdmin
      .mockResolvedValueOnce({
        id: "e-1", org_id: "org-1", entity_type: "entity", name: "users",
        yaml_content: "table: users\ndescription: Current\n", connection_id: "default",
        created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T12:00:00Z",
      })
      .mockResolvedValueOnce({
        id: "e-1", org_id: "org-1", entity_type: "entity", name: "users",
        yaml_content: targetYaml, connection_id: "default",
        created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T14:00:00Z",
      });

    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/users/rollback", "POST", {
      versionId: versionUuid,
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; name: string; versionNumber: number };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("users");
    expect(body.versionNumber).toBe(3);

    // Verify upsert was called with target version's YAML
    expect(mockUpsertEntityAdmin).toHaveBeenCalledTimes(1);
    const upsertCall = (mockUpsertEntityAdmin.mock.calls as unknown[][])[0];
    expect(upsertCall?.[3]).toBe(targetYaml);

    // Verify a new version was created for the rollback
    expect(mockCreateVersion).toHaveBeenCalledTimes(1);
  });

  it("succeeds even when version snapshot fails after rollback", async () => {
    setOrgAdmin("org-1");
    const versionUuid = "550e8400-e29b-41d4-a716-446655440001";
    mockGetVersion.mockResolvedValueOnce({
      id: versionUuid, entity_id: "e-1", org_id: "org-1", entity_type: "entity",
      name: "users", yaml_content: "table: users\n", change_summary: "Initial version",
      author_id: null, author_label: null, version_number: 1,
      created_at: "2026-04-01T10:00:00Z",
    });
    mockGetEntityAdmin
      .mockResolvedValueOnce({
        id: "e-1", org_id: "org-1", entity_type: "entity", name: "users",
        yaml_content: "table: users\n", connection_id: null,
        created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
      })
      .mockResolvedValueOnce({
        id: "e-1", org_id: "org-1", entity_type: "entity", name: "users",
        yaml_content: "table: users\n", connection_id: null,
        created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T14:00:00Z",
      });
    mockCreateVersion.mockRejectedValue(new Error("DB timeout"));

    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/users/rollback", "POST", {
      versionId: versionUuid,
    }));
    // Rollback still succeeds — entity was restored
    expect(res.status).toBe(200);
    expect(mockUpsertEntityAdmin).toHaveBeenCalledTimes(1);
  });
});

describe("PUT /api/v1/admin/semantic/entities/edit/:name — version creation", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockUpsertEntityAdmin.mockReset();
    mockUpsertEntityAdmin.mockResolvedValue(undefined);
    mockGetEntityAdmin.mockReset();
    mockCreateVersion.mockReset();
    mockCreateVersion.mockResolvedValue("version-1");
    mockGenerateChangeSummary.mockReset();
    mockGenerateChangeSummary.mockResolvedValue("Initial version");
    mockSyncEntityToDisk.mockReset();
    mockSyncEntityToDisk.mockResolvedValue(undefined);
  });

  it("creates a version snapshot on entity save", async () => {
    setOrgAdmin("org-1");
    // First call: getEntity for previous version (null = new entity)
    // Second call: getEntity after upsert to get entity ID
    mockGetEntityAdmin
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "e-1", org_id: "org-1", entity_type: "entity", name: "users",
        yaml_content: "table: users\n", connection_id: null,
        created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
      });

    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/users", "PUT", {
      table: "users",
      description: "User accounts",
    }));
    expect(res.status).toBe(200);
    expect(mockCreateVersion).toHaveBeenCalledTimes(1);
    const versionCall = (mockCreateVersion.mock.calls as unknown[][])[0];
    expect(versionCall?.[0]).toBe("e-1"); // entityId
    expect(versionCall?.[1]).toBe("org-1"); // orgId
    expect(versionCall?.[2]).toBe("entity"); // entityType
    expect(versionCall?.[3]).toBe("users"); // name
  });

  it("continues successfully even if version creation fails", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "e-1", org_id: "org-1", entity_type: "entity", name: "users",
        yaml_content: "table: users\n", connection_id: null,
        created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
      });
    mockCreateVersion.mockRejectedValue(new Error("Version creation failed"));

    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/users", "PUT", {
      table: "users",
    }));
    // Save still succeeds
    expect(res.status).toBe(200);
    expect(mockUpsertEntityAdmin).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Semantic entity write-path mode awareness (#1428)
// ---------------------------------------------------------------------------

describe("PUT /api/v1/admin/semantic/entities/edit/:name — mode-aware writes (#1428)", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockUpsertEntityAdmin.mockReset();
    mockUpsertEntityAdmin.mockResolvedValue(undefined);
    mockUpsertDraftEntityAdmin.mockReset();
    mockUpsertDraftEntityAdmin.mockResolvedValue(undefined);
    mockGetEntityAdmin.mockReset();
    mockSyncEntityToDisk.mockReset();
    mockSyncEntityToDisk.mockResolvedValue(undefined);
  });

  it("published mode upserts the published row (calls upsertEntity)", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue(null);
    const res = await app.fetch(
      adminRequest("/api/v1/admin/semantic/entities/edit/users", "PUT", {
        table: "users",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockUpsertEntityAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpsertDraftEntityAdmin).not.toHaveBeenCalled();
  });

  it("developer mode creates a draft for a new entity (calls upsertDraftEntity)", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue(null);
    const req = new Request("http://localhost/api/v1/admin/semantic/entities/edit/users", {
      method: "PUT",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
        Cookie: "atlas-mode=developer",
      },
      body: JSON.stringify({ table: "users" }),
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpsertEntityAdmin).not.toHaveBeenCalled();
  });

  it("developer mode — editing a published entity inserts a draft copy (published untouched)", async () => {
    setOrgAdmin("org-1");
    // There's already a published row with the same name
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-published", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n", connection_id: null, status: "published",
      created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
    });
    const req = new Request("http://localhost/api/v1/admin/semantic/entities/edit/users", {
      method: "PUT",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
        Cookie: "atlas-mode=developer",
      },
      body: JSON.stringify({ table: "users", description: "edited" }),
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
    // The published upsert must NOT be called — the published row must remain untouched
    expect(mockUpsertEntityAdmin).not.toHaveBeenCalled();
  });

  it("developer mode — editing an existing draft updates the draft row in place", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-draft", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n", connection_id: null, status: "draft",
      created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
    });
    const req = new Request("http://localhost/api/v1/admin/semantic/entities/edit/users", {
      method: "PUT",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
        Cookie: "atlas-mode=developer",
      },
      body: JSON.stringify({ table: "users", description: "edited again" }),
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
    // ON CONFLICT on the draft partial index handles update-in-place; we don't
    // need a different function — just assert that draft upsert is called once
  });

  it("published mode rejects writes to demo entity via body.connectionId (403)", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue(null);
    const res = await app.fetch(
      adminRequest("/api/v1/admin/semantic/entities/edit/users", "PUT", {
        table: "users",
        connectionId: "__demo__",
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("demo_readonly");
    expect(mockUpsertEntityAdmin).not.toHaveBeenCalled();
    expect(mockUpsertDraftEntityAdmin).not.toHaveBeenCalled();
  });

  it("published mode rejects writes when existing row belongs to __demo__ (403)", async () => {
    setOrgAdmin("org-1");
    // No body.connectionId provided — the existing row's connection_id is
    // the demo, so the edit must still be blocked.
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-1", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n", connection_id: "__demo__", status: "published",
      created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
    });
    const res = await app.fetch(
      adminRequest("/api/v1/admin/semantic/entities/edit/users", "PUT", {
        table: "users",
        description: "sneaky edit",
      }),
    );
    expect(res.status).toBe(403);
    expect(mockUpsertEntityAdmin).not.toHaveBeenCalled();
  });

  it("developer mode allows writes to demo entities (no 403)", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-1", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n", connection_id: "__demo__", status: "published",
      created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
    });
    const req = new Request("http://localhost/api/v1/admin/semantic/entities/edit/users", {
      method: "PUT",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
        Cookie: "atlas-mode=developer",
      },
      body: JSON.stringify({ table: "users", connectionId: "__demo__" }),
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /api/v1/admin/semantic/entities/edit/:name — mode-aware deletes (#1428)", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockDeleteEntityAdmin.mockReset();
    mockUpsertTombstoneAdmin.mockReset();
    mockDeleteDraftEntityAdmin.mockReset();
    mockGetEntityAdmin.mockReset();
    mockSyncEntityDeleteFromDisk.mockReset();
    mockSyncEntityDeleteFromDisk.mockResolvedValue(undefined);
  });

  it("published mode performs a hard delete", async () => {
    setOrgAdmin("org-1");
    mockDeleteEntityAdmin.mockResolvedValue(true);
    const res = await app.fetch(
      adminRequest("/api/v1/admin/semantic/entities/edit/users", "DELETE"),
    );
    expect(res.status).toBe(200);
    expect(mockDeleteEntityAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpsertTombstoneAdmin).not.toHaveBeenCalled();
  });

  it("developer mode — deleting a published entity inserts a draft_delete tombstone", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-published", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n", connection_id: null, status: "published",
      created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
    });
    mockUpsertTombstoneAdmin.mockResolvedValue(undefined);
    const req = new Request("http://localhost/api/v1/admin/semantic/entities/edit/users", {
      method: "DELETE",
      headers: { Authorization: "Bearer test-key", Cookie: "atlas-mode=developer" },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(mockUpsertTombstoneAdmin).toHaveBeenCalledTimes(1);
    // Published row must remain untouched
    expect(mockDeleteEntityAdmin).not.toHaveBeenCalled();
  });

  it("developer mode — deleting an existing draft row removes the draft only", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-draft", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n", connection_id: null, status: "draft",
      created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
    });
    mockDeleteDraftEntityAdmin.mockResolvedValue(true);
    const req = new Request("http://localhost/api/v1/admin/semantic/entities/edit/users", {
      method: "DELETE",
      headers: { Authorization: "Bearer test-key", Cookie: "atlas-mode=developer" },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(mockDeleteDraftEntityAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpsertTombstoneAdmin).not.toHaveBeenCalled();
    expect(mockDeleteEntityAdmin).not.toHaveBeenCalled();
  });

  it("developer mode — discarding a tombstone calls deleteDraftEntity", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-tomb", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "", connection_id: null, status: "draft_delete",
      created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
    });
    mockDeleteDraftEntityAdmin.mockResolvedValue(true);
    const req = new Request("http://localhost/api/v1/admin/semantic/entities/edit/users", {
      method: "DELETE",
      headers: { Authorization: "Bearer test-key", Cookie: "atlas-mode=developer" },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(mockDeleteDraftEntityAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpsertTombstoneAdmin).not.toHaveBeenCalled();
  });

  it("published mode rejects DELETE on demo-connection entity (403)", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-demo", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n", connection_id: "__demo__", status: "published",
      created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
    });
    mockDeleteEntityAdmin.mockResolvedValue(true);
    const res = await app.fetch(
      adminRequest("/api/v1/admin/semantic/entities/edit/users", "DELETE"),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("demo_readonly");
    expect(mockDeleteEntityAdmin).not.toHaveBeenCalled();
  });

  it("developer mode allows DELETE on demo-connection entity (tombstones it)", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-demo", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n", connection_id: "__demo__", status: "published",
      created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
    });
    mockUpsertTombstoneAdmin.mockResolvedValue(undefined);
    const req = new Request("http://localhost/api/v1/admin/semantic/entities/edit/users", {
      method: "DELETE",
      headers: { Authorization: "Bearer test-key", Cookie: "atlas-mode=developer" },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(mockUpsertTombstoneAdmin).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Org pool admin endpoints (#531)
// ---------------------------------------------------------------------------

describe("GET /api/v1/admin/connections/pool/orgs", () => {
  beforeEach(() => {
    setOrgScopedAdmin();
    mockGetOrgPoolMetrics.mockReset();
    mockGetOrgPoolConfig.mockReset();
    mockListOrgs.mockReset();
    mockGetOrgPoolMetrics.mockReturnValue([]);
    mockGetOrgPoolConfig.mockReturnValue({
      enabled: true,
      maxConnections: 5,
      idleTimeoutMs: 30000,
      maxOrgs: 50,
      warmupProbes: 2,
      drainThreshold: 5,
    });
    mockListOrgs.mockReturnValue([]);
  });

  it("requires admin auth", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true,
      mode: "simple-key",
      user: { id: "user-1", mode: "simple-key", label: "Member", role: "member" },
    });
    const res = await app.fetch(adminRequest("/api/v1/admin/connections/pool/orgs"));
    expect(res.status).toBe(403);
  });

  it("returns metrics, config, and orgCount", async () => {
    mockGetOrgPoolMetrics.mockReturnValue([
      {
        orgId: "org-1",
        connectionId: "default",
        dbType: "postgres",
        pool: { totalSize: 5, activeCount: 2, idleCount: 3, waitingCount: 0 },
        totalQueries: 100,
        totalErrors: 1,
        avgQueryTimeMs: 50,
        consecutiveFailures: 0,
        lastDrainAt: null,
      },
    ]);
    mockListOrgs.mockReturnValue(["org-1"]);

    const res = await app.fetch(adminRequest("/api/v1/admin/connections/pool/orgs"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.orgCount).toBe(1);
    expect(body.config).toBeDefined();
    expect(Array.isArray(body.metrics)).toBe(true);
    expect((body.metrics as unknown[]).length).toBe(1);
  });

  it("passes orgId query parameter to getOrgPoolMetrics (platform admin)", async () => {
    // Platform admins can specify an orgId query param to view any org's metrics
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "platform_admin", activeOrganizationId: "org-test-1" },
    });
    const res = await app.fetch(adminRequest("/api/v1/admin/connections/pool/orgs?orgId=org-42"));
    expect(res.status).toBe(200);
    expect((mockGetOrgPoolMetrics.mock.calls as unknown[][])[0]?.[0]).toBe("org-42");
  });

  it("workspace admin sees own org metrics only", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/connections/pool/orgs"));
    expect(res.status).toBe(200);
    // Workspace admin gets their own orgId passed to getOrgPoolMetrics
    expect((mockGetOrgPoolMetrics.mock.calls as unknown[][])[0]?.[0]).toBe("org-test-1");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.orgCount).toBe(1);
  });
});

describe("POST /api/v1/admin/connections/pool/orgs/:orgId/drain", () => {
  beforeEach(() => {
    setOrgScopedAdmin();
    mockDrainOrg.mockReset();
    mockDrainOrg.mockResolvedValue({ drained: 2 });
  });

  it("requires admin auth", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true,
      mode: "simple-key",
      user: { id: "user-1", mode: "simple-key", label: "Member", role: "member" },
    });
    const res = await app.fetch(adminRequest("/api/v1/admin/connections/pool/orgs/org-1/drain", "POST"));
    expect(res.status).toBe(403);
  });

  it("drains own org pools and returns count", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/connections/pool/orgs/org-test-1/drain", "POST"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.drained).toBe(2);
    expect((mockDrainOrg.mock.calls as unknown[][])[0]?.[0]).toBe("org-test-1");
  });

  it("returns 403 when workspace admin tries to drain another org", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/connections/pool/orgs/org-other/drain", "POST"));
    expect(res.status).toBe(403);
  });

  it("returns 500 when drainOrg throws", async () => {
    mockDrainOrg.mockRejectedValue(new Error("Pool close failed"));
    const res = await app.fetch(adminRequest("/api/v1/admin/connections/pool/orgs/org-test-1/drain", "POST"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("drain_failed");
  });
});
