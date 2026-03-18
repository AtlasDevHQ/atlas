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
}));

// Org-scoped semantic entities mock
const mockListEntitiesAdmin: Mock<(orgId: string, type?: string) => Promise<unknown[]>> = mock(() => Promise.resolve([]));
const mockGetEntityAdmin: Mock<(orgId: string, type: string, name: string) => Promise<unknown>> = mock(() => Promise.resolve(null));
const mockUpsertEntityAdmin: Mock<(...args: unknown[]) => Promise<void>> = mock(() => Promise.resolve());
const mockDeleteEntityAdmin: Mock<(orgId: string, type: string, name: string) => Promise<boolean>> = mock(() => Promise.resolve(false));

mock.module("@atlas/api/lib/db/semantic-entities", () => ({
  listEntities: mockListEntitiesAdmin,
  getEntity: mockGetEntityAdmin,
  upsertEntity: mockUpsertEntityAdmin,
  deleteEntity: mockDeleteEntityAdmin,
  countEntities: mock(() => Promise.resolve(0)),
  bulkUpsertEntities: mock(() => Promise.resolve(0)),
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

mock.module("@atlas/api/lib/semantic-diff", () => ({
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
    setAdmin();
  });

  it("lists connections", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/connections"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { connections: unknown[] };
    expect(body.connections.length).toBe(1);
  });
});

describe("POST /api/v1/admin/connections/:id/test", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setAdmin();
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
    setAdmin();
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
    let callCount = 0;
    mockInternalQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([{ count: "5" }]);
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
    let callCount = 0;
    mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        capturedSql = sql;
        capturedParams = params ?? [];
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });

    await app.fetch(adminRequest("/api/v1/admin/audit?user=test-user&success=true&from=2026-01-01&to=2026-03-01"));

    expect(capturedSql).toContain("user_id = $1");
    expect(capturedSql).toContain("success = $2");
    expect(capturedSql).toContain("timestamp >= $3");
    expect(capturedSql).toContain("timestamp <= $4");
    expect(capturedParams).toContain("test-user");
    expect(capturedParams).toContain(true);
    expect(capturedParams).toContain("2026-01-01");
    expect(capturedParams).toContain("2026-03-01");
  });

  it("supports search filter across SQL, email, and error", async () => {
    let capturedSql = "";
    let callCount = 0;
    mockInternalQuery.mockImplementation((sql: string) => {
      callCount++;
      if (callCount === 1) {
        capturedSql = sql;
        return Promise.resolve([{ count: "0" }]);
      }
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
    let callCount = 0;
    mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        capturedSql = sql;
        capturedParams = params ?? [];
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });

    await app.fetch(adminRequest("/api/v1/admin/audit?connection=warehouse"));

    expect(capturedSql).toContain("source_id");
    expect(capturedParams).toContain("warehouse");
  });

  it("supports table filter via JSONB contains", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    let callCount = 0;
    mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        capturedSql = sql;
        capturedParams = params ?? [];
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });

    await app.fetch(adminRequest("/api/v1/admin/audit?table=orders"));

    expect(capturedSql).toContain("tables_accessed ?");
    expect(capturedParams).toContain("orders");
  });

  it("supports column filter via JSONB contains", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    let callCount = 0;
    mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        capturedSql = sql;
        capturedParams = params ?? [];
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });

    await app.fetch(adminRequest("/api/v1/admin/audit?column=email"));

    expect(capturedSql).toContain("columns_accessed ?");
    expect(capturedParams).toContain("email");
  });

  it("lowercases table and column filter values", async () => {
    let capturedParams: unknown[] = [];
    let callCount = 0;
    mockInternalQuery.mockImplementation((_sql: string, params?: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        capturedParams = params ?? [];
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });

    await app.fetch(adminRequest("/api/v1/admin/audit?table=Orders&column=Email"));

    expect(capturedParams).toContain("orders");
    expect(capturedParams).toContain("email");
  });

  it("correctly parameterizes combined new filters (search + connection + table + column)", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    let callCount = 0;
    mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        capturedSql = sql;
        capturedParams = params ?? [];
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });

    await app.fetch(adminRequest(
      "/api/v1/admin/audit?connection=warehouse&table=orders&column=revenue&search=test",
    ));

    expect(capturedSql).toContain("source_id = $1");
    expect(capturedSql).toContain("tables_accessed ? $2");
    expect(capturedSql).toContain("columns_accessed ? $3");
    expect(capturedSql).toContain("a.sql ILIKE $4 OR u.email ILIKE $4 OR a.error ILIKE $4");
    expect(capturedParams).toEqual(["warehouse", "orders", "revenue", "%test%"]);
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
    setAdmin();
    mockHasInternalDB = true;
    mockInternalQuery.mockReset();
  });

  it("returns CSV with correct headers", async () => {
    let callCount = 0;
    mockInternalQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([{ count: "1" }]);
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
    let callCount = 0;
    mockInternalQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([{ count: "1" }]);
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
    let callCount = 0;
    mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
      callCount++;
      if (callCount === 1) return Promise.resolve([{ count: "0" }]);
      capturedSql = sql;
      capturedParams = params ?? [];
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
    let callCount = 0;
    mockInternalQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([{ count: "0" }]);
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
});

describe("GET /api/v1/admin/audit/stats", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setAdmin();
    mockHasInternalDB = true;
    mockInternalQuery.mockReset();
  });

  it("returns 404 when no internal DB", async () => {
    mockHasInternalDB = false;

    const res = await app.fetch(adminRequest("/api/v1/admin/audit/stats"));
    expect(res.status).toBe(404);
  });

  it("returns audit stats", async () => {
    let callCount = 0;
    mockInternalQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([{ total: "100", errors: "5" }]);
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
});

describe("GET /api/v1/admin/plugins", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setAdmin();
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
    setAdmin();
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
    setAdmin();
    mockHasInternalDB = true;
    mockInternalQuery.mockReset();
  });

  // Volume
  describe("GET /audit/analytics/volume", () => {
    it("returns daily volume data", async () => {
      mockInternalQuery.mockResolvedValue([
        { day: "2026-03-01", count: "10", errors: "2" },
        { day: "2026-03-02", count: "15", errors: "0" },
      ]);

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/volume"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { volume: { day: string; count: number; errors: number }[] };
      expect(body.volume).toHaveLength(2);
      expect(body.volume[0].count).toBe(10);
      expect(body.volume[0].errors).toBe(2);
      expect(body.volume[1].count).toBe(15);
    });

    it("passes date range params to query", async () => {
      mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/volume?from=2026-03-01&to=2026-03-07"));
      expect(res.status).toBe(200);
      expect(mockInternalQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockInternalQuery.mock.calls[0];
      expect(sql).toContain("timestamp >=");
      expect(sql).toContain("timestamp <=");
      expect(params).toEqual(["2026-03-01", "2026-03-07"]);
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
      mockInternalQuery.mockResolvedValue([
        { query: "SELECT * FROM big_table", avg_duration: "1500", max_duration: "3000", count: "5" },
      ]);

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
      mockInternalQuery.mockResolvedValue([
        { query: "SELECT 1", count: "100", avg_duration: "5", error_count: "3" },
      ]);

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
      mockInternalQuery.mockResolvedValue([
        { error: "relation does not exist", count: "8" },
        { error: "permission denied", count: "3" },
      ]);

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/errors"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { errors: { error: string; count: number }[] };
      expect(body.errors).toHaveLength(2);
      expect(body.errors[0].count).toBe(8);
      expect(body.errors[1].error).toBe("permission denied");
    });

    it("combines date range with error filter", async () => {
      mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/errors?from=2026-03-01"));
      expect(res.status).toBe(200);
      expect(mockInternalQuery).toHaveBeenCalledTimes(1);
      const [sql] = mockInternalQuery.mock.calls[0];
      expect(sql).toContain("timestamp >=");
      expect(sql).toContain("NOT success");
    });
  });

  // Users
  describe("GET /audit/analytics/users", () => {
    it("returns per-user stats with error rate", async () => {
      mockInternalQuery.mockResolvedValue([
        { user_id: "user-1", count: "50", avg_duration: "120", error_count: "5" },
        { user_id: "user-2", count: "20", avg_duration: "80", error_count: "0" },
      ]);

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
      mockInternalQuery.mockResolvedValue([]);

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/volume?to=2026-03-07"));
      expect(res.status).toBe(200);
      expect(mockInternalQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockInternalQuery.mock.calls[0];
      expect(sql).toContain("timestamp <=");
      expect(sql).not.toContain("timestamp >=");
      expect(params).toEqual(["2026-03-07"]);
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

  it("passes connection query param to runDiff", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/diff?connection=default"));
    expect(res.status).toBe(200);
    expect(mockRunDiff).toHaveBeenCalledWith("default");
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
    expect(res.status).toBe(400);
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
// Org pool admin endpoints (#531)
// ---------------------------------------------------------------------------

describe("GET /api/v1/admin/connections/pool/orgs", () => {
  beforeEach(() => {
    setAdmin();
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

  it("passes orgId query parameter to getOrgPoolMetrics", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/connections/pool/orgs?orgId=org-42"));
    expect(res.status).toBe(200);
    expect((mockGetOrgPoolMetrics.mock.calls as unknown[][])[0]?.[0]).toBe("org-42");
  });

  it("returns empty metrics when no orgs", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/connections/pool/orgs"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.orgCount).toBe(0);
    expect((body.metrics as unknown[]).length).toBe(0);
  });
});

describe("POST /api/v1/admin/connections/pool/orgs/:orgId/drain", () => {
  beforeEach(() => {
    setAdmin();
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

  it("drains org pools and returns count", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/connections/pool/orgs/org-1/drain", "POST"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.drained).toBe(2);
    expect((mockDrainOrg.mock.calls as unknown[][])[0]?.[0]).toBe("org-1");
  });

  it("returns 500 when drainOrg throws", async () => {
    mockDrainOrg.mockRejectedValue(new Error("Pool close failed"));
    const res = await app.fetch(adminRequest("/api/v1/admin/connections/pool/orgs/org-1/drain", "POST"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("drain_failed");
  });
});
