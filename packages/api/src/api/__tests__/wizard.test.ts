/**
 * Tests for wizard API routes.
 *
 * Covers the semantic layer setup wizard endpoints:
 * - POST /api/v1/wizard/profile
 * - POST /api/v1/wizard/generate
 * - POST /api/v1/wizard/preview
 * - POST /api/v1/wizard/save
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

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      has: () => true,
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

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => ({ query: async () => ({ rows: [] }) }),
  internalQuery: async () => [{ url: "postgresql://localhost/test", schema_name: "public" }],
  internalExecute: () => {},
  encryptUrl: (url: string) => `encrypted:${url}`,
  decryptUrl: (url: string) => url.startsWith("postgresql://") ? url : "postgresql://localhost/test",
  migrateInternalDB: async () => {},
  loadSavedConnections: async () => 0,
  isPlaintextUrl: () => true,
  getEncryptionKey: () => null,
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  _resetEncryptionKeyCache: () => {},
  closeInternalDB: async () => {},
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(),
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  _resetWhitelists: () => {},
}));

mock.module("@atlas/api/lib/semantic-sync", () => ({
  syncEntityToDisk: async () => {},
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
  FATAL_ERROR_PATTERN: _fatalPatternReal,
  // Mock DB-calling functions
  listPostgresObjects: async () => [
    { name: "users", type: "table" },
    { name: "orders", type: "table" },
    { name: "user_stats", type: "view" },
  ],
  listMySQLObjects: async () => [
    { name: "products", type: "table" },
  ],
  profilePostgres: async () => ({
    profiles: [mockUserProfile],
    errors: [],
  }),
  profileMySQL: async () => ({
    profiles: [],
    errors: [],
  }),
}));

// --- Import after mocks ---

const { wizard } = await import("../routes/wizard");
const { Hono } = await import("hono");

const app = new Hono();
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
});

describe("POST /api/v1/wizard/profile", () => {
  it("returns 400 without connectionId", async () => {
    const res = await postJson("/api/v1/wizard/profile", {});
    expect(res.status).toBe(400);
    const data = await json(res);
    expect(data.error).toBe("invalid_request");
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
});

describe("POST /api/v1/wizard/generate", () => {
  it("returns 400 without tables", async () => {
    const res = await postJson("/api/v1/wizard/generate", { connectionId: "default" });
    expect(res.status).toBe(400);
  });

  it("returns 400 with empty tables array", async () => {
    const res = await postJson("/api/v1/wizard/generate", { connectionId: "default", tables: [] });
    expect(res.status).toBe(400);
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
});

describe("POST /api/v1/wizard/preview", () => {
  it("returns 400 without question", async () => {
    const res = await postJson("/api/v1/wizard/preview", {
      entities: [{ tableName: "users", yaml: "table: users" }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 without entities", async () => {
    const res = await postJson("/api/v1/wizard/preview", {
      question: "How many users?",
    });
    expect(res.status).toBe(400);
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

describe("POST /api/v1/wizard/save", () => {
  it("returns 400 without connectionId", async () => {
    const res = await postJson("/api/v1/wizard/save", {
      entities: [{ tableName: "users", yaml: "table: users" }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 without entities", async () => {
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
    });
    expect(res.status).toBe(400);
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
});
