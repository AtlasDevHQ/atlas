/**
 * Tests for public semantic API routes.
 *
 * Mirrors the entity-related semantic tests from admin.test.ts (the public
 * API exposes entities only, not metrics/glossary/catalog/stats).
 * Uses a real temp directory with fixture YAML files.
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

const tmpRoot = path.join(process.env.TMPDIR ?? "/tmp", `atlas-semantic-test-${Date.now()}`);

function setupFixtures(): void {
  fs.mkdirSync(path.join(tmpRoot, "entities"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "warehouse", "entities"), { recursive: true });

  fs.writeFileSync(
    path.join(tmpRoot, "entities", "companies.yml"),
    `table: companies
description: All company records
dimensions:
  id:
    type: integer
    description: Primary key
    primary_key: true
  name:
    type: text
    description: Company name
    sample_values: [Acme, Globex, Initech]
  industry:
    type: text
    description: Industry sector
joins:
  to_accounts:
    description: companies.id -> accounts.company_id
    relationship: one_to_many
measures:
  total_companies:
    sql: "COUNT(DISTINCT id)"
query_patterns:
  count_by_industry:
    description: How many companies in each industry?
    sql: "SELECT industry, COUNT(*) FROM companies GROUP BY industry"
`,
  );

  fs.writeFileSync(
    path.join(tmpRoot, "warehouse", "entities", "orders.yml"),
    `table: orders
description: Warehouse orders
type: table
connection: warehouse
dimensions:
  id:
    type: integer
  total:
    type: numeric
`,
  );

  // Broken YAML file for error handling test
  fs.writeFileSync(
    path.join(tmpRoot, "entities", "broken.yml"),
    `table: broken
description: This file has invalid YAML below
dimensions: [invalid: yaml: structure
`,
  );
}

setupFixtures();

// Point semantic routes to our temp directory
process.env.ATLAS_SEMANTIC_ROOT = tmpRoot;

// --- Mocks (before any import that touches the modules) ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: { id: "user-1", mode: "simple-key", label: "User", role: "member" },
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

mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
  connections: {
    get: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
    getDefault: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
    getDBType: () => "postgres" as const,
    getTargetHost: () => "localhost",
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
    list: () => ["default"],
    describe: () => [{ id: "default", dbType: "postgres", description: "Test DB" }],
    healthCheck: mock(() => Promise.resolve({ status: "healthy", latencyMs: 5, checkedAt: new Date() })),
  },
  detectDBType: () => "postgres" as const,
  extractTargetHost: () => "localhost",
  ConnectionRegistry: class {},
  ConnectionNotRegisteredError: class extends Error {
    constructor(id: string) { super(`Connection "${id}" is not registered.`); this.name = "ConnectionNotRegisteredError"; }
  },
  NoDatasourceConfiguredError: class extends Error {
    constructor() { super("No analytics datasource configured."); this.name = "NoDatasourceConfiguredError"; }
  },
}));

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

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => false,
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
  runAgent: mock(() =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      text: Promise.resolve("answer"),
    }),
  ),
}));

mock.module("@atlas/api/lib/tools/actions", () => ({
  createJiraTicket: { name: "createJiraTicket", description: "Mock", tool: { type: "function" } },
  sendEmailReport: { name: "sendEmailReport", description: "Mock", tool: { type: "function" } },
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

function apiRequest(urlPath: string): Request {
  return new Request(`http://localhost${urlPath}`, {
    method: "GET",
    headers: { Authorization: "Bearer test-key" },
  });
}

function setAuthenticated(): void {
  mockAuthenticateRequest.mockResolvedValue({
    authenticated: true,
    mode: "simple-key",
    user: { id: "user-1", mode: "simple-key", label: "User", role: "member" },
  });
  mockCheckRateLimit.mockReturnValue({ allowed: true });
}

function setUnauthenticated(): void {
  mockAuthenticateRequest.mockResolvedValue({
    authenticated: false,
    mode: "simple-key",
    status: 401,
    error: "Invalid API key",
  });
  mockCheckRateLimit.mockReturnValue({ allowed: true });
}

// --- Cleanup ---

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.ATLAS_SEMANTIC_ROOT;
});

// --- Tests ---

describe("Public semantic routes — auth", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    mockCheckRateLimit.mockReset();
  });

  it("returns 401 when unauthenticated on list endpoint", async () => {
    setUnauthenticated();
    const res = await app.fetch(apiRequest("/api/v1/semantic/entities"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when unauthenticated on detail endpoint", async () => {
    setUnauthenticated();
    const res = await app.fetch(apiRequest("/api/v1/semantic/entities/companies"));
    expect(res.status).toBe(401);
  });

  it("allows non-admin authenticated users", async () => {
    setAuthenticated();
    const res = await app.fetch(apiRequest("/api/v1/semantic/entities"));
    expect(res.status).toBe(200);
  });

  it("enforces rate limiting with Retry-After header", async () => {
    setAuthenticated();
    mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });
    const res = await app.fetch(apiRequest("/api/v1/semantic/entities"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("rate_limited");
  });

  it("returns 500 when authenticateRequest throws", async () => {
    mockAuthenticateRequest.mockRejectedValue(new Error("DB crashed"));
    mockCheckRateLimit.mockReturnValue({ allowed: true });
    const res = await app.fetch(apiRequest("/api/v1/semantic/entities"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("auth_error");
  });
});

describe("GET /api/v1/semantic/entities", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    mockCheckRateLimit.mockReset();
    setAuthenticated();
  });

  it("lists entities from default and per-source directories", async () => {
    const res = await app.fetch(apiRequest("/api/v1/semantic/entities"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { entities: Array<Record<string, unknown>> };
    // broken.yml fails to parse, so only companies + orders
    const validEntities = body.entities.filter((e) => e.table !== "broken");
    expect(validEntities.length).toBe(2);

    const companies = validEntities.find((e) => e.table === "companies");
    expect(companies).toBeDefined();
    expect(companies!.columnCount).toBe(3);
    expect(companies!.joinCount).toBe(1);

    const orders = validEntities.find((e) => e.table === "orders");
    expect(orders).toBeDefined();
  });

  it("includes type field for entities", async () => {
    const res = await app.fetch(apiRequest("/api/v1/semantic/entities"));
    const body = (await res.json()) as { entities: Array<Record<string, unknown>> };

    const orders = body.entities.find((e) => e.table === "orders");
    expect(orders!.type).toBe("table");
  });

  it("excludes admin-only fields (measureCount, connection, source)", async () => {
    const res = await app.fetch(apiRequest("/api/v1/semantic/entities"));
    const body = (await res.json()) as { entities: Array<Record<string, unknown>> };

    const companies = body.entities.find((e) => e.table === "companies");
    expect(companies).toBeDefined();
    expect(companies!.measureCount).toBeUndefined();
    expect(companies!.connection).toBeUndefined();
    expect(companies!.source).toBeUndefined();
  });
});

describe("GET /api/v1/semantic/entities/:name", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    mockCheckRateLimit.mockReset();
    setAuthenticated();
  });

  it("returns full entity detail", async () => {
    const res = await app.fetch(apiRequest("/api/v1/semantic/entities/companies"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { entity: Record<string, unknown> };
    expect(body.entity.table).toBe("companies");
    expect(body.entity.description).toBeDefined();
    expect(body.entity.dimensions).toBeDefined();
    expect(body.entity.joins).toBeDefined();
    expect(body.entity.query_patterns).toBeDefined();
  });

  it("returns 404 for non-existent entity", async () => {
    const res = await app.fetch(apiRequest("/api/v1/semantic/entities/nonexistent"));
    expect(res.status).toBe(404);
  });

  it("returns 400 for path traversal attempts", async () => {
    const traversalNames = [
      "../../etc/passwd",
      "..%2F..%2Fetc%2Fpasswd", // double-encoded to test that scenario
      "../.env",
      "foo/bar",
      "foo\\bar",
      "companies\0.yml", // null byte injection
    ];
    for (const name of traversalNames) {
      const res = await app.fetch(apiRequest(`/api/v1/semantic/entities/${encodeURIComponent(name)}`));
      expect(res.status).toBe(400);
    }
  });

  it("finds entities in per-source subdirectories", async () => {
    const res = await app.fetch(apiRequest("/api/v1/semantic/entities/orders"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { entity: Record<string, unknown> };
    expect(body.entity.table).toBe("orders");
  });

  it("returns 500 for malformed YAML", async () => {
    const res = await app.fetch(apiRequest("/api/v1/semantic/entities/broken"));
    expect(res.status).toBe(500);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("internal_error");
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/tables
// ---------------------------------------------------------------------------

describe("GET /api/v1/tables", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    mockCheckRateLimit.mockReset();
    setAuthenticated();
  });

  it("returns tables with column details", async () => {
    const res = await app.fetch(apiRequest("/api/v1/tables"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { tables: Array<Record<string, unknown>> };
    expect(body.tables).toBeDefined();

    // companies + orders from fixtures (broken.yml is skipped)
    const companies = body.tables.find((t) => t.table === "companies");
    expect(companies).toBeDefined();
    expect(companies!.description).toBe("All company records");
    expect(Array.isArray(companies!.columns)).toBe(true);
    const cols = companies!.columns as Array<{ name: string; type: string; description: string }>;
    expect(cols.length).toBe(3);
    expect(cols.find((c) => c.name === "id")).toBeDefined();

    const orders = body.tables.find((t) => t.table === "orders");
    expect(orders).toBeDefined();
  });

  it("returns 401 when unauthenticated", async () => {
    setUnauthenticated();
    const res = await app.fetch(apiRequest("/api/v1/tables"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("auth_error");
  });

  it("returns 429 when rate limited", async () => {
    setAuthenticated();
    mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 15000 });
    const res = await app.fetch(apiRequest("/api/v1/tables"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("15");
  });
});
