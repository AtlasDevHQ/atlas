/**
 * Tests for wizard API routes.
 *
 * Covers the semantic layer setup wizard endpoints:
 * - POST /api/v1/wizard/profile
 * - POST /api/v1/wizard/generate
 * - POST /api/v1/wizard/preview
 * - POST /api/v1/wizard/save
 *
 * Also covers resolveConnectionUrl (indirectly via endpoints):
 * - Not found (registry miss + no internal DB; registry miss + empty internal DB)
 * - Infrastructure error (internal DB query throws)
 * - Decryption failure
 * - Env-var fallback (ATLAS_DATASOURCE_URL for default connection)
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";

// --- Mocks ---

const mockAuthenticate: Mock<() => Promise<{
  authenticated: boolean;
  mode: string;
  user?: { id: string; mode: string; label: string; role: string; activeOrganizationId?: string };
  status?: number;
  error?: string;
}>> = mock(() =>
  Promise.resolve({
    authenticated: true,
    mode: "managed",
    user: { id: "user-1", mode: "managed", label: "admin@test.com", role: "admin", activeOrganizationId: "org-1" },
  }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticate,
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "managed",
  resetAuthModeCache: () => {},
}));

const mockConnectionHas: Mock<(id: string) => boolean> = mock(() => true);

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      has: mockConnectionHas,
      describe: () => [{ id: "default", dbType: "postgres", status: "healthy" }],
    },
    detectDBType: (url?: string) => {
      const connStr = url ?? "";
      if (connStr.startsWith("postgresql://") || connStr.startsWith("postgres://")) return "postgres";
      if (connStr.startsWith("mysql://") || connStr.startsWith("mysql2://")) return "mysql";
      throw new Error("Unsupported database URL scheme");
    },
  }),
);

const mockHasInternalDB: Mock<() => boolean> = mock(() => true);
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>> = mock(
  async () => [{ url: "postgresql://localhost/test", schema_name: "public" }],
);
const mockDecryptUrl: Mock<(url: string) => string> = mock(
  (url: string) => url.startsWith("postgresql://") ? url : "postgresql://localhost/test",
);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: mockHasInternalDB,
  getInternalDB: () => ({ query: async () => ({ rows: [] }) }),
  internalQuery: mockInternalQuery,
  internalExecute: () => {},
  encryptUrl: (url: string) => `encrypted:${url}`,
  decryptUrl: mockDecryptUrl,
  migrateInternalDB: async () => {},
  loadSavedConnections: async () => 0,
  isPlaintextUrl: () => true,
  getEncryptionKey: () => null,
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  _resetEncryptionKeyCache: () => {},
  closeInternalDB: async () => {},
}));

const mockResetWhitelists: Mock<() => void> = mock(() => {});

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(),
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  _resetWhitelists: mockResetWhitelists,
}));

const mockSyncEntityToDisk: Mock<(orgId: string, name: string, type: string, yaml: string) => Promise<void>> = mock(
  async () => {},
);

mock.module("@atlas/api/lib/semantic-sync", () => ({
  syncEntityToDisk: mockSyncEntityToDisk,
  syncEntityDeleteFromDisk: async () => {},
  syncAllEntitiesToDisk: async () => 0,
  getSemanticRoot: () => "/tmp/test-semantic",
  reconcileAllOrgs: async () => {},
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async () => {},
}));

mock.module("@atlas/api/lib/settings", () => ({
  getSetting: () => undefined,
}));

mock.module("@atlas/api/lib/security", () => ({
  maskConnectionUrl: (url: string) => url.replace(/\/\/.*@/, "//***@"),
}));

// Mock fs to avoid real filesystem writes in save endpoint
const mockMkdirSync: Mock<(dir: string, opts?: unknown) => void> = mock(() => {});
const mockWriteFileSync: Mock<(path: string, data: string, encoding?: string) => void> = mock(() => {});

mock.module("fs", () => ({
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
}));

// Mock the profiler functions that talk to real databases.
// We import the actual pure functions (YAML generation, heuristics) but mock
// the DB-calling functions (listPostgresObjects, profilePostgres, etc.).
import {
  analyzeTableProfiles as _analyzeReal,
  generateEntityYAML as _genEntityReal,
  generateCatalogYAML as _genCatalogReal,
  generateGlossaryYAML as _genGlossaryReal,
  generateMetricYAML as _genMetricReal,
  outputDirForDatasource as _outputDirReal,
  mapSQLType as _mapSQLTypeReal,
  mapSalesforceFieldType as _mapSfReal,
  singularize as _singReal,
  pluralize as _plurReal,
  entityName as _entityNameReal,
  isView as _isViewReal,
  isMatView as _isMatViewReal,
  isViewLike as _isViewLikeReal,
  isFatalConnectionError as _isFatalReal,
  checkFailureThreshold as _checkReal,
  logProfilingErrors as _logReal,
  inferForeignKeys as _inferReal,
  detectAbandonedTables as _detectAbReal,
  detectEnumInconsistency as _detectEnumReal,
  detectDenormalizedTables as _detectDenReal,
  mysqlQuoteIdent as _mysqlQuoteIdentReal,
  FATAL_ERROR_PATTERN as _fatalPatternReal,
} from "@atlas/api/lib/profiler";

const mockUserProfile = {
  table_name: "users",
  object_type: "table" as const,
  row_count: 1000,
  columns: [
    {
      name: "id",
      type: "integer",
      nullable: false,
      unique_count: 1000,
      null_count: 0,
      sample_values: [],
      is_primary_key: true,
      is_foreign_key: false,
      fk_target_table: null,
      fk_target_column: null,
      is_enum_like: false,
      profiler_notes: [],
    },
    {
      name: "name",
      type: "text",
      nullable: true,
      unique_count: 950,
      null_count: 5,
      sample_values: ["Alice", "Bob"],
      is_primary_key: false,
      is_foreign_key: false,
      fk_target_table: null,
      fk_target_column: null,
      is_enum_like: false,
      profiler_notes: [],
    },
  ],
  primary_key_columns: ["id"],
  foreign_keys: [],
  inferred_foreign_keys: [],
  profiler_notes: [],
  table_flags: { possibly_abandoned: false, possibly_denormalized: false },
};

// Controllable mocks for DB-calling profiler functions
const mockListPostgresObjects: Mock<() => Promise<{ name: string; type: string }[]>> = mock(
  async () => [
    { name: "users", type: "table" },
    { name: "orders", type: "table" },
    { name: "user_stats", type: "view" },
  ],
);
const mockListMySQLObjects: Mock<() => Promise<{ name: string; type: string }[]>> = mock(
  async () => [{ name: "products", type: "table" }],
);
const mockProfilePostgres: Mock<() => Promise<{ profiles: typeof mockUserProfile[]; errors: unknown[] }>> = mock(
  async () => ({ profiles: [mockUserProfile], errors: [] }),
);
const mockProfileMySQL: Mock<() => Promise<{ profiles: never[]; errors: unknown[] }>> = mock(
  async () => ({ profiles: [], errors: [] }),
);

mock.module("@atlas/api/lib/profiler", () => ({
  // Re-export all pure functions
  analyzeTableProfiles: _analyzeReal,
  generateEntityYAML: _genEntityReal,
  generateCatalogYAML: _genCatalogReal,
  generateGlossaryYAML: _genGlossaryReal,
  generateMetricYAML: _genMetricReal,
  outputDirForDatasource: _outputDirReal,
  mapSQLType: _mapSQLTypeReal,
  mapSalesforceFieldType: _mapSfReal,
  singularize: _singReal,
  pluralize: _plurReal,
  entityName: _entityNameReal,
  isView: _isViewReal,
  isMatView: _isMatViewReal,
  isViewLike: _isViewLikeReal,
  isFatalConnectionError: _isFatalReal,
  checkFailureThreshold: _checkReal,
  logProfilingErrors: _logReal,
  inferForeignKeys: _inferReal,
  detectAbandonedTables: _detectAbReal,
  detectEnumInconsistency: _detectEnumReal,
  detectDenormalizedTables: _detectDenReal,
  mysqlQuoteIdent: _mysqlQuoteIdentReal,
  FATAL_ERROR_PATTERN: _fatalPatternReal,
  // Mock DB-calling functions — use Mock instances for per-test overrides
  listPostgresObjects: mockListPostgresObjects,
  listMySQLObjects: mockListMySQLObjects,
  profilePostgres: mockProfilePostgres,
  profileMySQL: mockProfileMySQL,
}));

// --- Import after mocks ---

const { wizard } = await import("../routes/wizard");
const { OpenAPIHono } = await import("@hono/zod-openapi");

import { validationHook } from "../routes/validation-hook";
const app = new OpenAPIHono({ defaultHook: validationHook });
app.route("/api/v1/wizard", wizard);

function request(path: string, init?: RequestInit) {
  return app.request(`http://localhost${path}`, init);
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function postJson(path: string, body: Record<string, unknown>) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- Tests ---

beforeEach(() => {
  mockAuthenticate.mockReset();
  mockAuthenticate.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: { id: "user-1", mode: "managed", label: "admin@test.com", role: "admin", activeOrganizationId: "org-1" },
    }),
  );

  mockConnectionHas.mockReset();
  mockConnectionHas.mockImplementation(() => true);

  mockHasInternalDB.mockReset();
  mockHasInternalDB.mockImplementation(() => true);

  mockInternalQuery.mockReset();
  mockInternalQuery.mockImplementation(
    async () => [{ url: "postgresql://localhost/test", schema_name: "public" }],
  );

  mockDecryptUrl.mockReset();
  mockDecryptUrl.mockImplementation(
    (url: string) => url.startsWith("postgresql://") ? url : "postgresql://localhost/test",
  );

  mockMkdirSync.mockReset();
  mockWriteFileSync.mockReset();
  mockResetWhitelists.mockReset();
  mockSyncEntityToDisk.mockReset();
  mockSyncEntityToDisk.mockImplementation(async () => {});

  mockListPostgresObjects.mockReset();
  mockListPostgresObjects.mockImplementation(async () => [
    { name: "users", type: "table" },
    { name: "orders", type: "table" },
    { name: "user_stats", type: "view" },
  ]);
  mockListMySQLObjects.mockReset();
  mockListMySQLObjects.mockImplementation(async () => [{ name: "products", type: "table" }]);
  mockProfilePostgres.mockReset();
  mockProfilePostgres.mockImplementation(async () => ({ profiles: [mockUserProfile], errors: [] }));
  mockProfileMySQL.mockReset();
  mockProfileMySQL.mockImplementation(async () => ({ profiles: [], errors: [] }));
});

// =====================================================================
// POST /api/v1/wizard/profile
// =====================================================================

describe("POST /api/v1/wizard/profile", () => {
  it("returns 400 without connectionId", async () => {
    const res = await postJson("/api/v1/wizard/profile", {});
    expect(res.status).toBe(422);
    const data = await json(res);
    expect(data.error).toBe("validation_error");
  });

  it("returns table list for a valid connection", async () => {
    const res = await postJson("/api/v1/wizard/profile", { connectionId: "default" });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.connectionId).toBe("default");
    expect(Array.isArray(data.tables)).toBe(true);
    expect((data.tables as unknown[]).length).toBe(3);
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockAuthenticate.mockImplementation(() =>
      Promise.resolve({ authenticated: false, mode: "managed", status: 401, error: "Not authenticated" }),
    );
    const res = await postJson("/api/v1/wizard/profile", { connectionId: "default" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    mockAuthenticate.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "user-2", mode: "managed", label: "user@test.com", role: "member" },
      }),
    );
    const res = await postJson("/api/v1/wizard/profile", { connectionId: "default" });
    expect(res.status).toBe(403);
  });

  it("returns 500 with profile_failed when listing tables throws", async () => {
    mockListPostgresObjects.mockImplementation(async () => {
      throw new Error("connection timeout");
    });
    const res = await postJson("/api/v1/wizard/profile", { connectionId: "default" });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("profile_failed");
    expect(data.requestId).toBeDefined();
  });

  it("returns 400 for malformed JSON body", async () => {
    const res = await request("/api/v1/wizard/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{{{",
    });
    expect(res.status).toBe(400);
  });
});

// =====================================================================
// POST /api/v1/wizard/generate
// =====================================================================

describe("POST /api/v1/wizard/generate", () => {
  it("returns 400 without tables", async () => {
    const res = await postJson("/api/v1/wizard/generate", { connectionId: "default" });
    expect(res.status).toBe(422);
  });

  it("returns 400 with empty tables array", async () => {
    const res = await postJson("/api/v1/wizard/generate", { connectionId: "default", tables: [] });
    expect(res.status).toBe(422);
  });

  it("generates entities for selected tables", async () => {
    const res = await postJson("/api/v1/wizard/generate", {
      connectionId: "default",
      tables: ["users"],
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.connectionId).toBe("default");
    expect(Array.isArray(data.entities)).toBe(true);
    const entities = data.entities as { tableName: string; yaml: string }[];
    expect(entities.length).toBe(1);
    expect(entities[0].tableName).toBe("users");
    expect(entities[0].yaml).toContain("name: Users");
  });

  it("returns 500 with generate_failed when profiling throws", async () => {
    mockProfilePostgres.mockImplementation(async () => {
      throw new Error("statement timeout");
    });
    const res = await postJson("/api/v1/wizard/generate", {
      connectionId: "default",
      tables: ["users"],
    });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("generate_failed");
    expect(data.requestId).toBeDefined();
  });
});

// =====================================================================
// POST /api/v1/wizard/preview
// =====================================================================

describe("POST /api/v1/wizard/preview", () => {
  it("returns 400 without question", async () => {
    const res = await postJson("/api/v1/wizard/preview", {
      entities: [{ tableName: "users", yaml: "table: users" }],
    });
    expect(res.status).toBe(422);
  });

  it("returns 400 without entities", async () => {
    const res = await postJson("/api/v1/wizard/preview", {
      question: "How many users?",
    });
    expect(res.status).toBe(422);
  });

  it("returns preview for valid input", async () => {
    const res = await postJson("/api/v1/wizard/preview", {
      question: "How many users?",
      entities: [{ tableName: "users", yaml: "table: users\ndimensions: []\n" }],
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.question).toBe("How many users?");
    expect(Array.isArray(data.availableTables)).toBe(true);
    expect((data.availableTables as string[]).includes("users")).toBe(true);
  });
});

// =====================================================================
// POST /api/v1/wizard/save
// =====================================================================

describe("POST /api/v1/wizard/save", () => {
  it("returns 400 without connectionId", async () => {
    const res = await postJson("/api/v1/wizard/save", {
      entities: [{ tableName: "users", yaml: "table: users" }],
    });
    expect(res.status).toBe(422);
  });

  it("returns 400 without entities", async () => {
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
    });
    expect(res.status).toBe(422);
  });

  it("returns 400 with empty entities array", async () => {
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [],
    });
    expect(res.status).toBe(422);
    const data = await json(res);
    expect(data.error).toBe("validation_error");
  });

  it("returns 400 when no active org", async () => {
    mockAuthenticate.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "user-1", mode: "managed", label: "admin@test.com", role: "admin" },
      }),
    );
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "users", yaml: "table: users\n" }],
    });
    expect(res.status).toBe(400);
    const data = await json(res);
    expect(data.error).toBe("no_organization");
  });

  it("returns 403 for non-admin users", async () => {
    mockAuthenticate.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "user-2", mode: "managed", label: "user@test.com", role: "member" },
      }),
    );
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "users", yaml: "table: users\n" }],
    });
    expect(res.status).toBe(403);
    const data = await json(res);
    expect(data.error).toBe("forbidden_role");
  });

  it("saves valid entities and returns 201", async () => {
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [
        { tableName: "users", yaml: "table: users\ndescription: User accounts\n" },
        { tableName: "orders", yaml: "table: orders\ndescription: Customer orders\n" },
      ],
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.saved).toBe(true);
    expect(data.orgId).toBe("org-1");
    expect(data.connectionId).toBe("default");
    expect(data.entityCount).toBe(2);
    expect(Array.isArray(data.files)).toBe(true);
    const files = data.files as string[];
    expect(files).toContain("entities/users.yml");
    expect(files).toContain("entities/orders.yml");
  });

  it("creates directories and writes entity files", async () => {
    await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "users", yaml: "table: users\n" }],
    });

    // mkdirSync called for entities and metrics dirs
    expect(mockMkdirSync).toHaveBeenCalledTimes(2);
    expect(mockMkdirSync.mock.calls[0][1]).toEqual({ recursive: true });

    // writeFileSync called for the entity YAML
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const [writePath, content, encoding] = mockWriteFileSync.mock.calls[0];
    expect((writePath as string).endsWith("users.yml")).toBe(true);
    expect(content).toBe("table: users\n");
    expect(encoding).toBe("utf-8");
  });

  it("resets semantic whitelist cache after save", async () => {
    await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "users", yaml: "table: users\n" }],
    });
    expect(mockResetWhitelists).toHaveBeenCalledTimes(1);
  });

  it("syncs entities to disk when internal DB is available", async () => {
    await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [
        { tableName: "users", yaml: "table: users\n" },
        { tableName: "orders", yaml: "table: orders\n" },
      ],
    });
    expect(mockSyncEntityToDisk).toHaveBeenCalledTimes(2);
  });

  it("returns 400 for invalid entity objects (missing tableName/yaml)", async () => {
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ foo: "bar" }, { baz: 123 }],
    });
    expect(res.status).toBe(422);
    const data = await json(res);
    expect(data.error).toBe("validation_error");
    // Zod validation catches missing required fields
    expect(typeof data.message).toBe("string");
    expect((data.message as string).length).toBeGreaterThan(0);
  });

  it("returns 400 for path-traversal table name with '..'", async () => {
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "../../../etc/passwd", yaml: "malicious: true\n" }],
    });
    expect(res.status).toBe(400);
    const data = await json(res);
    expect(data.error).toBe("invalid_request");
    expect(data.message).toContain("Invalid table name");
  });

  it("returns 400 for table name with path separators", async () => {
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "foo/bar", yaml: "table: foo\n" }],
    });
    expect(res.status).toBe(400);
    const data = await json(res);
    expect(data.error).toBe("invalid_request");
  });

  it("returns 400 for table name with spaces", async () => {
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "my table", yaml: "table: my table\n" }],
    });
    expect(res.status).toBe(400);
    const data = await json(res);
    expect(data.error).toBe("invalid_request");
  });

  it("allows table names with dots and hyphens", async () => {
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [
        { tableName: "user.accounts", yaml: "table: user.accounts\n" },
        { tableName: "order-items", yaml: "table: order-items\n" },
      ],
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.entityCount).toBe(2);
  });

  it("handles duplicate entity names (last write wins)", async () => {
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [
        { tableName: "users", yaml: "table: users\nversion: 1\n" },
        { tableName: "users", yaml: "table: users\nversion: 2\n" },
      ],
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.entityCount).toBe(2);

    // Both writes happen — the second overwrites the first
    expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
    const lastWriteContent = mockWriteFileSync.mock.calls[1][1];
    expect(lastWriteContent).toBe("table: users\nversion: 2\n");
  });

  it("returns 400 when entities contain invalid objects (Zod rejects non-conforming items)", async () => {
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [
        { tableName: "users", yaml: "table: users\n" },
        { noTableName: true }, // invalid — Zod rejects
        42, // invalid — Zod rejects
      ],
    });
    // Zod validation rejects the array because items don't conform to schema
    expect(res.status).toBe(422);
    const data = await json(res);
    expect(data.error).toBe("validation_error");
  });

  it("returns 500 with save_failed when filesystem write throws", async () => {
    mockWriteFileSync.mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "users", yaml: "table: users\n" }],
    });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("save_failed");
    expect(data.requestId).toBeDefined();
  });

  it("returns 500 with save_failed when mkdirSync throws", async () => {
    mockMkdirSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "users", yaml: "table: users\n" }],
    });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("save_failed");
    expect(data.requestId).toBeDefined();
  });

  it("still returns 201 when syncEntityToDisk fails (best-effort sync)", async () => {
    mockSyncEntityToDisk.mockImplementation(async () => {
      throw new Error("Internal DB connection lost");
    });
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "users", yaml: "table: users\n" }],
    });
    // Save succeeds even when sync fails — the .catch() is intentional
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.saved).toBe(true);
  });

  it("generates catalog/glossary/metric files when profiles are provided", async () => {
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "users", yaml: "table: users\n" }],
      schema: "analytics",
      profiles: [mockUserProfile],
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.saved).toBe(true);

    // Entity YAML + catalog + glossary = at minimum 3 writes
    expect(mockWriteFileSync.mock.calls.length).toBeGreaterThanOrEqual(3);
    const files = data.files as string[];
    expect(files).toContain("entities/users.yml");
    expect(files).toContain("catalog.yml");
    expect(files).toContain("glossary.yml");
  });

  it("returns 422 when profiles contain invalid objects", async () => {
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "users", yaml: "table: users\n" }],
      profiles: [{ table_name: "bad", object_type: "trigger" }],
    });
    expect(res.status).toBe(422);
    const data = await json(res);
    expect(data.error).toBe("validation_error");
  });

  it("strips unknown fields from request body (no passthrough)", async () => {
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "users", yaml: "table: users\n" }],
      unknownField: "should be stripped",
    });
    // Unknown fields are silently stripped — request still succeeds
    expect(res.status).toBe(201);
  });
});

// =====================================================================
// resolveConnectionUrl — tested indirectly via endpoints
// =====================================================================

describe("resolveConnectionUrl", () => {
  it("returns 404 when connection is not found anywhere", async () => {
    mockConnectionHas.mockImplementation(() => false);
    mockHasInternalDB.mockImplementation(() => false);

    const res = await postJson("/api/v1/wizard/profile", { connectionId: "nonexistent" });
    expect(res.status).toBe(404);
    const data = await json(res);
    expect(data.error).toBe("not_found");
    expect(data.message).toContain("nonexistent");
  });

  it("returns 404 when connection not in registry and internal DB returns empty", async () => {
    mockConnectionHas.mockImplementation(() => false);
    mockHasInternalDB.mockImplementation(() => true);
    mockInternalQuery.mockImplementation(async () => []);

    const res = await postJson("/api/v1/wizard/profile", { connectionId: "missing-conn" });
    expect(res.status).toBe(404);
    const data = await json(res);
    expect(data.error).toBe("not_found");
  });

  it("returns 500 when internal DB query throws (infrastructure error)", async () => {
    mockConnectionHas.mockImplementation(() => true);
    mockInternalQuery.mockImplementation(async () => {
      throw new Error("Connection pool exhausted");
    });

    const res = await postJson("/api/v1/wizard/profile", { connectionId: "default" });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("connection_resolution_failed");
    expect(data.requestId).toBeDefined();
  });

  it("returns 500 when decryption fails", async () => {
    mockConnectionHas.mockImplementation(() => true);
    mockInternalQuery.mockImplementation(
      async () => [{ url: "encrypted:secret-url", schema_name: "public" }],
    );
    mockDecryptUrl.mockImplementation(() => {
      throw new Error("Decryption failed: invalid key");
    });

    const res = await postJson("/api/v1/wizard/profile", { connectionId: "default" });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("connection_resolution_failed");
    expect(data.requestId).toBeDefined();
  });

  it("falls back to ATLAS_DATASOURCE_URL for default connection", async () => {
    const originalUrl = process.env.ATLAS_DATASOURCE_URL;
    process.env.ATLAS_DATASOURCE_URL = "postgresql://fallback/test";

    try {
      // Registry has it, but no internal DB configured
      mockConnectionHas.mockImplementation(() => true);
      mockHasInternalDB.mockImplementation(() => false);

      const res = await postJson("/api/v1/wizard/profile", { connectionId: "default" });
      // Should succeed using the env var fallback
      expect(res.status).toBe(200);
    } finally {
      if (originalUrl === undefined) {
        delete process.env.ATLAS_DATASOURCE_URL;
      } else {
        process.env.ATLAS_DATASOURCE_URL = originalUrl;
      }
    }
  });
});
