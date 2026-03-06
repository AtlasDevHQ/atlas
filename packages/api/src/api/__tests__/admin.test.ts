/**
 * Tests for admin API routes.
 *
 * Mocks: auth middleware, connection registry, internal DB, plugin registry,
 * and transitive dependencies (explore, agent, semantic, conversations, etc.).
 * Uses a real temp directory with fixture YAML files for semantic layer tests.
 * Verifies admin role enforcement and endpoint response shapes.
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

mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => mockDBConnection,
  connections: {
    get: () => mockDBConnection,
    getDefault: () => mockDBConnection,
    getDBType: () => "postgres" as const,
    getTargetHost: () => "localhost",
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
    list: () => ["default"],
    describe: () => [
      { id: "default", dbType: "postgres", description: "Test DB" },
    ],
    healthCheck: mockHealthCheck,
  },
  detectDBType: () => "postgres" as const,
  extractTargetHost: () => "localhost",
  ConnectionRegistry: class {},
}));

mock.module("@atlas/api/lib/semantic", () => ({
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
  _resetPool: mock(() => {}),
  _resetCircuitBreaker: mock(() => {}),
}));

const mockPluginHealthCheck: Mock<() => Promise<unknown>> = mock(() =>
  Promise.resolve({ healthy: true, message: "OK" }),
);

mock.module("@atlas/api/lib/plugins/registry", () => ({
  plugins: {
    describe: () => [
      { id: "test-plugin", type: "context", version: "1.0.0", name: "Test Plugin", status: "healthy" },
    ],
    get: (id: string) => {
      if (id === "test-plugin") {
        return {
          id: "test-plugin",
          type: "context",
          version: "1.0.0",
          name: "Test Plugin",
          healthCheck: mockPluginHealthCheck,
        };
      }
      if (id === "no-health-plugin") {
        return {
          id: "no-health-plugin",
          type: "action",
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

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mock(() => Promise.resolve(null)),
  addMessage: mock(() => {}),
  getConversation: mock(() => Promise.resolve(null)),
  generateTitle: mock((q: string) => q.slice(0, 80)),
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  deleteConversation: mock(() => Promise.resolve(false)),
  starConversation: async () => false,
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

  it("returns 403 when user has analyst role", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true,
      mode: "simple-key",
      user: { id: "user-1", mode: "simple-key", label: "Analyst", role: "analyst" },
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("forbidden");
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
      user: { id: "user-1", mode: "simple-key", label: "Analyst", role: "analyst" },
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
    expect(body.errorRate).toBe(0.05);
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
