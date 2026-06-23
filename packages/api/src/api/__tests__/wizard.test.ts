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
const mockConnectionDescribe: Mock<() => Array<{ id: string; dbType: string; status: string }>> = mock(
  () => [{ id: "default", dbType: "postgres", status: "healthy" }],
);

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      has: mockConnectionHas,
      describe: mockConnectionDescribe,
    },
    detectDBType: (url?: string) => {
      const connStr = url ?? "";
      if (connStr.startsWith("postgresql://") || connStr.startsWith("postgres://")) return "postgres";
      if (connStr.startsWith("mysql://") || connStr.startsWith("mysql2://")) return "mysql";
      // Plugin dbType used by the profiler-seam dispatch tests (#3621). The
      // wizard treats any non-pg/mysql dbType as a plugin type and resolves its
      // profiler off the registry.
      if (connStr.startsWith("clickhouse://")) return "clickhouse";
      throw new Error("Unsupported database URL scheme");
    },
  }),
);

const mockHasInternalDB: Mock<() => boolean> = mock(() => true);
// resolveConnectionUrl now selects the full `config` JSONB + the catalog
// `config_schema` (to decrypt separate-field credentials — ADR-0017 amendment /
// #3552 wizard equivalent), shaping `{ config, schema_name, config_schema }`.
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>> = mock(
  async () => [
    { config: { url: "postgresql://localhost/test", schema: "public" }, schema_name: "public", config_schema: null },
  ],
);
const mockDecryptUrl: Mock<(url: string) => string> = mock(
  (url: string) => url.startsWith("postgresql://") ? url : "postgresql://localhost/test",
);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: mockHasInternalDB,
  getInternalDB: () => ({ query: async () => ({ rows: [] }) }),
  internalQuery: mockInternalQuery,
  internalExecute: () => {},
  encryptSecret: (url: string) => `encrypted:${url}`,
  decryptSecret: mockDecryptUrl,
  migrateInternalDB: async () => {},
  loadSavedConnections: async () => 0,
  isPlaintextUrl: () => true,
  getEncryptionKey: () => null,
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  _resetEncryptionKeyCache: () => {},
  closeInternalDB: async () => {},
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
}));

const mockResetWhitelists: Mock<() => void> = mock(() => {});
const mockInvalidateOrgWhitelist: Mock<(orgId: string) => void> = mock(() => {});

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(),
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: mockInvalidateOrgWhitelist,
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  _resetWhitelists: mockResetWhitelists,
}));

const mockBulkUpsertEntities: Mock<(
  orgId: string,
  entities: Array<{ entityType: string; name: string; yamlContent: string; connectionId?: string; connectionGroupId?: string | null }>,
) => Promise<number>> = mock(async (_orgId, entities) => entities.length);

// #3682 — durable partial-profile marker write the wizard `/save` makes when the
// client forwards `failedTables`. A module-level spy so tests can assert the
// call args and drive a rejection (best-effort path).
const mockUpsertProfileStatus: Mock<(
  orgId: string,
  connectionGroupId: string | null | undefined,
  input: { totalTables: number; failedTables: Array<{ table: string; error: string }> },
) => Promise<void>> = mock(async () => {});

// Connection → Connection group resolver (#3234). The wizard scopes saved
// entities by group: the default/unknown connection → NULL default group
// (flat root), a non-default connection → its group (group-of-one stand-in
// here = the connectionId itself). Tests override per-case for member-share.
const mockResolveGroupId: Mock<(orgId: string, connectionId?: string | null) => Promise<string | null>> = mock(
  async (_orgId, connectionId) => (!connectionId || connectionId === "default" ? null : connectionId),
);

mock.module("@atlas/api/lib/semantic/entities", () => ({
  upsertProfileStatus: mockUpsertProfileStatus,
  listIncompleteProfileLayers: mock(() => Promise.resolve([])),
  // Constants the wizard route imports statically
  DEMO_CONNECTION_ID: "__demo__",
  SEMANTIC_ENTITY_STATUSES: ["published", "draft", "draft_delete", "archived"] as const,
  // Functions under test in this suite
  bulkUpsertEntities: mockBulkUpsertEntities,
  resolveGroupIdForConnection: mockResolveGroupId,
  // Other named exports — the mock.module() loader requires every export
  // from the real module to be present, otherwise other test files in the
  // same isolated process throw `Export named 'X' not found`.
  upsertEntity: async () => {},
  upsertDraftEntity: async () => {},
  upsertTombstone: async () => {},
  deleteDraftEntity: async () => false,
  listEntityRows: async () => [],
  listEntities: async () => [],
  listEntitiesWithOverlay: async () => [],
  getEntity: async () => null,
  deleteEntity: async () => false,
  countEntities: async () => 0,
  createVersion: async () => "",
  listVersions: async () => [],
  getVersion: async () => null,
  generateChangeSummary: async () => "",
  applyTombstones: async () => 0,
  promoteDraftEntities: async () => 0,
  archiveSingleConnection: async () => ({ ok: true as const, archived: 0 }),
  restoreSingleConnection: async () => ({ ok: true as const, restored: 0 }),
}));

const mockSyncEntityToDisk: Mock<(orgId: string, name: string, type: string, yaml: string) => Promise<void>> = mock(
  async () => {},
);

mock.module("@atlas/api/lib/semantic/sync", () => ({
  syncEntityToDisk: mockSyncEntityToDisk,
  syncEntityDeleteFromDisk: async () => {},
  syncAllEntitiesToDisk: async () => 0,
  getSemanticRoot: () => "/tmp/test-semantic",
  reconcileAllOrgs: async () => {},
}));

// #3894 — the Source-catalog auto-description refresh the wizard `/save` fires
// after entities land. A module-level spy so tests can assert the wiring (call
// args + the NULL-group skip) without exercising the real (DB-backed) refresh.
const mockRefreshGroupAutoDescription: Mock<(
  orgId: string,
  groupId: string,
  entities: ReadonlyArray<{ name: string; yaml: string }>,
) => Promise<void>> = mock(async () => {});

mock.module("@atlas/api/lib/source-catalog/lookup", () => ({
  refreshGroupAutoDescription: mockRefreshGroupAutoDescription,
  // Other named export — present so the mock.module() loader resolves every
  // export of the real module for any sibling import in this isolated process.
  loadSourceCatalog: async () => "",
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
  getSettingAuto: () => undefined,
  getSettingLive: async () => undefined,
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  setSetting: async () => {},
  deleteSetting: async () => {},
  loadSettings: async () => 0,
  getAllSettingOverrides: async () => [],
  _resetSettingsCache: () => {},
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
  outputDirForGroup as _outputDirGroupReal,
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

// The shared assembly engine (#3506) — imported unmocked so the wire-shape
// tests can assert the wizard's `/generate` YAML is byte-identical to what the
// shared core emits (the consolidation contract, #3529).
import { generateSemanticLayer } from "@atlas/api/lib/semantic/generate";

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

// A profile with a numeric (non-PK, non-FK, non-`_id`) measure column, so
// `generateMetricYAML` yields a metric artifact (#3550). `mockUserProfile`
// has only a PK + text column and produces NO metric, which is why the
// metric-persistence tests need their own profile.
const mockOrdersProfile = {
  table_name: "orders",
  object_type: "table" as const,
  row_count: 5000,
  columns: [
    {
      name: "id",
      type: "integer",
      nullable: false,
      unique_count: 5000,
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
      name: "amount",
      type: "numeric",
      nullable: false,
      unique_count: 4200,
      null_count: 0,
      sample_values: ["19.99", "42.50"],
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
  outputDirForGroup: _outputDirGroupReal,
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

// Providers — control enrichment availability + stub the model. Spread the real
// module so unrelated exports survive; the wizard route only consumes getModel +
// getMissingModelConfig from here (the /enrich Phase-2 path, #3236).
import * as _providersActual from "@atlas/api/lib/providers";
const mockGetMissingModelConfig: Mock<() => { provider: string; missing: string[] }> = mock(
  () => ({ provider: "anthropic", missing: [] }),
);
mock.module("@atlas/api/lib/providers", () => ({
  ..._providersActual,
  getModel: () => ({ modelId: "test-model" }),
  getModelFromWorkspaceConfig: () => ({ modelId: "workspace-model" }),
  getMissingModelConfig: mockGetMissingModelConfig,
}));

// Enterprise layer — the /enrich route resolves per-workspace BYOT via
// `runEnterprise(ModelRouter…)` before the env provider (#3236 P1, mirrors the
// agent loop). Spread the real module so `runEffect`'s EnterpriseLayer stays
// real; override only runEnterprise. Default: null = no workspace config →
// route falls through to the env-based getMissingModelConfig path.
import * as _enterpriseLayerActual from "@atlas/api/lib/effect/enterprise-layer";
const mockRunEnterprise: Mock<(program: unknown) => Promise<unknown>> = mock(async () => null);
mock.module("@atlas/api/lib/effect/enterprise-layer", () => ({
  ..._enterpriseLayerActual,
  runEnterprise: mockRunEnterprise,
}));

// Enrich engine — stub the in-memory per-table LLM pass so /enrich makes no real
// model call. Default: a successful merge that appends a marker field.
const mockEnrichEntityYaml: Mock<
  (
    content: string,
    profile: unknown,
    model: unknown,
    usage?: unknown,
    dbType?: string,
  ) => Promise<{ yaml: string; enriched: boolean }>
> = mock(async (content: string) => ({ yaml: `${content}description: Enriched by AI.\n`, enriched: true }));
mock.module("@atlas/api/lib/semantic/enrich", () => ({
  enrichEntityYaml: mockEnrichEntityYaml,
  enrichEntity: async () => {},
  enrichGlossary: async () => {},
  enrichMetric: async () => {},
  enrichSemanticLayer: async () => {},
}));

// One profiler home (#3657, ADR-0017 §Amendment(#3667)). The wizard routes now
// resolve a LIVE connection via `resolveWizardConnection` (which rides the same
// `resolveLiveConnection` MCP uses) — introspection is a capability OF that
// connection, not a second profiler seam. We mock that ONE seam so the route
// tests drive resolution outcomes (ok / not_found / unsupported / reconnect)
// directly. The resolver's own internals (workspace vs global vs env-var
// byproduct, the connections.has gate) are unit-tested in
// `datasources/__tests__/wizard-connection.test.ts`.
type WizListObjects = (o?: { schema?: string }) => Promise<{ name: string; type: string }[]>;
type WizProfile = (o?: { schema?: string; selectedTables?: string[] }) => Promise<{
  profiles: unknown[];
  errors: unknown[];
}>;
type WizCtx =
  | {
      kind: "ok";
      dbType: string;
      querySchema: string | undefined;
      connection: {
        dbType: string;
        connectionGroupId: string | null;
        query: () => Promise<{ columns: string[]; rows: Record<string, unknown>[] }>;
        listObjects: WizListObjects;
        profile: WizProfile;
        close: () => Promise<void>;
      };
    }
  | { kind: "not_found" }
  | { kind: "unsupported"; message: string }
  | { kind: "reconnect_required"; message: string };

function okCtx(opts: {
  dbType: string;
  querySchema: string | undefined;
  listObjects: WizListObjects;
  profile: WizProfile;
}): WizCtx {
  return {
    kind: "ok",
    dbType: opts.dbType,
    querySchema: opts.querySchema,
    connection: {
      dbType: opts.dbType,
      connectionGroupId: null,
      query: async () => ({ columns: [], rows: [] as Record<string, unknown>[] }),
      listObjects: opts.listObjects,
      profile: opts.profile,
      close: async () => {},
    },
  };
}

const mockResolveWizardConnection: Mock<(connectionId: string, orgId?: string | null) => Promise<WizCtx>> = mock(
  async () =>
    okCtx({
      dbType: "postgres",
      querySchema: "public",
      listObjects: () => mockListPostgresObjects(),
      profile: () => mockProfilePostgres(),
    }),
);
mock.module("@atlas/api/lib/datasources/wizard-connection", () => ({
  resolveWizardConnection: mockResolveWizardConnection,
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

  mockConnectionDescribe.mockReset();
  mockConnectionDescribe.mockImplementation(
    () => [{ id: "default", dbType: "postgres", status: "healthy" }],
  );

  mockHasInternalDB.mockReset();
  mockHasInternalDB.mockImplementation(() => true);

  mockInternalQuery.mockReset();
  mockInternalQuery.mockImplementation(
    async () => [
      { config: { url: "postgresql://localhost/test", schema: "public" }, schema_name: "public", config_schema: null },
    ],
  );

  mockDecryptUrl.mockReset();
  mockDecryptUrl.mockImplementation(
    (url: string) => url.startsWith("postgresql://") ? url : "postgresql://localhost/test",
  );

  mockMkdirSync.mockReset();
  mockWriteFileSync.mockReset();
  // Reset the bulk-upsert impl every test so a failure-injection impl
  // (mockImplementation, e.g. the partial-metric-persist test) can't leak into
  // a later test. Default mirrors the module-level stub: every row "lands".
  mockBulkUpsertEntities.mockReset();
  mockBulkUpsertEntities.mockImplementation(async (_orgId, entities) => entities.length);
  mockResetWhitelists.mockReset();
  mockSyncEntityToDisk.mockReset();
  mockSyncEntityToDisk.mockImplementation(async () => {});

  mockResolveGroupId.mockReset();
  mockResolveGroupId.mockImplementation(
    async (_orgId, connectionId) => (!connectionId || connectionId === "default" ? null : connectionId),
  );

  mockRefreshGroupAutoDescription.mockReset();
  mockRefreshGroupAutoDescription.mockImplementation(async () => {});

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

  mockGetMissingModelConfig.mockReset();
  mockGetMissingModelConfig.mockImplementation(() => ({ provider: "anthropic", missing: [] }));
  mockEnrichEntityYaml.mockReset();
  mockEnrichEntityYaml.mockImplementation(
    async (content: string) => ({ yaml: `${content}description: Enriched by AI.\n`, enriched: true }),
  );
  mockRunEnterprise.mockReset();
  mockRunEnterprise.mockImplementation(async () => null); // no workspace BYOT by default

  mockResolveWizardConnection.mockReset();
  mockResolveWizardConnection.mockImplementation(async () =>
    okCtx({
      dbType: "postgres",
      querySchema: "public",
      listObjects: () => mockListPostgresObjects(),
      profile: () => mockProfilePostgres(),
    }),
  );
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
    // The raw driver detail stays in the logs — never echoed to the client (a
    // driver error can embed host/port/DSN userinfo).
    expect(data.message).not.toContain("connection timeout");
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
    // Default connection → NULL default group → no group field emitted
    // (neither the canonical `group:` nor the deprecated `connection:` alias).
    expect(entities[0].yaml).not.toContain("group:");
    expect(entities[0].yaml).not.toContain("connection:");
  });

  it("pins the /generate wire response shape (consolidation must not reshape it, #3529)", async () => {
    // The entity YAML is now produced by the shared `generateSemanticLayer`
    // (#3529), but the wizard's preview-metadata wrapper stays wizard-local.
    // Pin the exact response shape so the delegation can't silently drop or
    // rename a field the frontend reads.
    const res = await postJson("/api/v1/wizard/generate", {
      connectionId: "default",
      tables: ["users"],
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(Object.keys(data).toSorted()).toEqual(
      ["connectionId", "dbType", "entities", "errors", "schema"].toSorted(),
    );
    const entities = data.entities as Array<Record<string, unknown>>;
    expect(entities).toHaveLength(1);
    expect(Object.keys(entities[0]).toSorted()).toEqual(
      ["columnCount", "objectType", "profile", "rowCount", "tableName", "yaml"].toSorted(),
    );
    const profile = entities[0].profile as Record<string, unknown>;
    expect(Object.keys(profile).toSorted()).toEqual(
      ["columns", "flags", "foreignKeys", "inferredForeignKeys", "notes", "primaryKeys"].toSorted(),
    );
    expect(typeof entities[0].yaml).toBe("string");
    expect(entities[0].tableName).toBe("users");
    expect(entities[0].objectType).toBe("table");
    expect(entities[0].rowCount).toBe(1000);
    expect(entities[0].columnCount).toBe(2);
  });

  it("routes /generate entity YAML through the shared core, byte-identical and correctly paired (#3529)", async () => {
    // The wizard preview YAML must match exactly what the shared engine emits
    // for the same analyzed profiles — that byte-equality is the whole point of
    // the consolidation (one engine, no per-caller drift). Default connection →
    // NULL default group → no sourceId, matching the wizard's resolution.
    //
    // Two profiles (not one) so the test also pins per-table PAIRING: each
    // preview row must carry ITS OWN table's YAML. A regression that mis-pairs
    // YAML with the wrong metadata row would pass a single-table check but fail
    // here (users' YAML names "users", orders' YAML names "orders").
    mockProfilePostgres.mockImplementation(async () => ({
      profiles: [mockUserProfile, mockOrdersProfile],
      errors: [],
    }));

    const res = await postJson("/api/v1/wizard/generate", {
      connectionId: "default",
      tables: ["users", "orders"],
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    const entities = data.entities as { tableName: string; yaml: string }[];

    const analyzed = _analyzeReal([mockUserProfile, mockOrdersProfile]);
    const expected = generateSemanticLayer(analyzed, { dbType: "postgres", schema: "public" });

    expect(entities).toHaveLength(2);
    // Compare the whole tableName → YAML mapping: each preview row must carry
    // its OWN table's byte-identical shared-core YAML. A mis-paired row (users'
    // metadata + orders' YAML) would diverge from the expected mapping and fail.
    const actualByTable = Object.fromEntries(entities.map((e) => [e.tableName, e.yaml]));
    const expectedByTable = Object.fromEntries(expected.entities.map((e) => [e.table, e.yaml]));
    expect(actualByTable).toEqual(expectedByTable);
  });

  it("scopes generated YAML by the connection's group (non-default connection)", async () => {
    // A non-default connection resolves to its group, which is baked into the
    // preview YAML so it matches the groups/<group>/ dir /save writes into.
    const res = await postJson("/api/v1/wizard/generate", {
      connectionId: "warehouse",
      tables: ["users"],
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    const entities = data.entities as { tableName: string; yaml: string }[];
    // #3285: the canonical `group:` field (ADR-0012), not the deprecated
    // `connection:` alias the generator used to emit.
    expect(entities[0].yaml).toContain("group: warehouse");
    expect(entities[0].yaml).not.toContain("connection:");
  });

  it("degrades to no group field when group resolution fails (preview is best-effort)", async () => {
    // /generate is a preview — a group-lookup hiccup must not fail the whole
    // generate; it falls back to no group field rather than 500ing.
    mockResolveGroupId.mockReset();
    mockResolveGroupId.mockRejectedValueOnce(new Error("internal DB unreachable"));

    const res = await postJson("/api/v1/wizard/generate", {
      connectionId: "warehouse",
      tables: ["users"],
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    const entities = data.entities as { tableName: string; yaml: string }[];
    expect(entities[0].tableName).toBe("users");
    // Degraded preview falls back to no group field at all (#3285).
    expect(entities[0].yaml).not.toContain("group:");
    expect(entities[0].yaml).not.toContain("connection:");
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
    // Raw driver detail stays out of the client response.
    expect(data.message).not.toContain("statement timeout");
  });
});

// =====================================================================
// POST /api/v1/wizard/enrich (Phase 2 — issue #3236)
// =====================================================================

describe("POST /api/v1/wizard/enrich", () => {
  it("returns 422 when required fields are missing", async () => {
    // No yaml → Zod rejects (yaml is the baseline the LLM merges into).
    const res = await postJson("/api/v1/wizard/enrich", {
      connectionId: "default",
      tableName: "users",
    });
    expect(res.status).toBe(422);
  });

  it("enriches one table and returns the upgraded YAML", async () => {
    const res = await postJson("/api/v1/wizard/enrich", {
      connectionId: "default",
      tableName: "users",
      yaml: "table: users\n",
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.tableName).toBe("users");
    expect(data.enriched).toBe(true);
    expect(String(data.yaml)).toContain("Enriched by AI.");
    // The engine got the submitted baseline + the freshly-profiled table profile
    // (DB-grounded enrichment — § D) + the datasource dialect so query_patterns
    // match the connection (#3236 review: dbType threaded, 5th arg).
    expect(mockEnrichEntityYaml).toHaveBeenCalledTimes(1);
    const call = mockEnrichEntityYaml.mock.calls[0];
    expect(call[0]).toBe("table: users\n");
    expect((call[1] as { table_name: string }).table_name).toBe("users");
    expect(call[4]).toBe("postgres");
  });

  it("uses an admin-configured workspace provider even when no platform env key is set", async () => {
    // BYOT (#3236 P1): a workspace whose provider lives in settings must enrich
    // even if the platform env has no provider — so the env preflight is skipped
    // when the ModelRouter returns a workspace config.
    // runEnterprise is a shared seam: adminAuth's IP-allowlist check
    // (expects `{ allowed }`) AND resolveEnrichModel's ModelRouter both flow
    // through it. The mock return must satisfy both — `allowed: true` keeps the
    // IP check green; the model fields are the workspace BYOT config (consumed
    // by the mocked getModelFromWorkspaceConfig, which ignores their values).
    mockRunEnterprise.mockImplementation(async () => ({
      allowed: true,
      provider: "anthropic",
      model: "claude-x",
      baseUrl: null,
      bedrockRegion: null,
      credentials: { provider: "anthropic", apiKey: "sk-test" },
    }));
    mockGetMissingModelConfig.mockImplementation(() => ({
      provider: "anthropic",
      missing: ["ANTHROPIC_API_KEY"], // platform env is empty, but workspace BYOT wins
    }));

    const res = await postJson("/api/v1/wizard/enrich", {
      connectionId: "default",
      tableName: "users",
      yaml: "table: users\n",
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.enriched).toBe(true);
    expect(mockEnrichEntityYaml).toHaveBeenCalledTimes(1);
  });

  it("passes the baseline through unchanged when the model returns no usable output", async () => {
    mockEnrichEntityYaml.mockImplementationOnce(async (content: string) => ({
      yaml: content,
      enriched: false,
    }));
    const res = await postJson("/api/v1/wizard/enrich", {
      connectionId: "default",
      tableName: "users",
      yaml: "table: users\n",
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.enriched).toBe(false);
    expect(data.yaml).toBe("table: users\n");
  });

  it("returns 503 and never enriches when no LLM provider is configured", async () => {
    mockGetMissingModelConfig.mockImplementation(() => ({
      provider: "anthropic",
      missing: ["ANTHROPIC_API_KEY"],
    }));
    const res = await postJson("/api/v1/wizard/enrich", {
      connectionId: "default",
      tableName: "users",
      yaml: "table: users\n",
    });
    expect(res.status).toBe(503);
    const data = await json(res);
    expect(data.error).toBe("enrichment_unavailable");
    // Fail-fast BEFORE any profiling or model call.
    expect(mockEnrichEntityYaml).not.toHaveBeenCalled();
    expect(mockProfilePostgres).not.toHaveBeenCalled();
  });

  it("returns 404 when the connection is not found", async () => {
    mockResolveWizardConnection.mockImplementation(async () => ({ kind: "not_found" }));
    const res = await postJson("/api/v1/wizard/enrich", {
      connectionId: "nonexistent",
      tableName: "users",
      yaml: "table: users\n",
    });
    expect(res.status).toBe(404);
    const data = await json(res);
    expect(data.error).toBe("not_found");
  });

  it("returns 500 enrich_failed when profiling throws", async () => {
    mockProfilePostgres.mockImplementation(async () => {
      throw new Error("statement timeout");
    });
    const res = await postJson("/api/v1/wizard/enrich", {
      connectionId: "default",
      tableName: "users",
      yaml: "table: users\n",
    });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("enrich_failed");
    expect(data.requestId).toBeDefined();
  });

  it("returns 403 for non-admin users", async () => {
    mockAuthenticate.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "user-2", mode: "managed", label: "user@test.com", role: "member" },
      }),
    );
    const res = await postJson("/api/v1/wizard/enrich", {
      connectionId: "default",
      tableName: "users",
      yaml: "table: users\n",
    });
    expect(res.status).toBe(403);
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

  it("#3894 — refreshes the group's auto-description from the saved batch (real group)", async () => {
    // A non-"default" connection resolves to its own group (group-of-one), so
    // the Source-catalog auto-description refresh fires with the saved entities.
    await postJson("/api/v1/wizard/save", {
      connectionId: "warehouse",
      entities: [
        { tableName: "users", yaml: "table: users\ndescription: User accounts\n" },
        { tableName: "orders", yaml: "table: orders\ndescription: Customer orders\n" },
      ],
    });
    expect(mockRefreshGroupAutoDescription).toHaveBeenCalledTimes(1);
    const [orgId, groupId, entities] = mockRefreshGroupAutoDescription.mock.calls[0];
    expect(orgId).toBe("org-1");
    expect(groupId).toBe("warehouse");
    expect(entities).toEqual([
      { name: "users", yaml: "table: users\ndescription: User accounts\n" },
      { name: "orders", yaml: "table: orders\ndescription: Customer orders\n" },
    ]);
  });

  it("#3894 — skips the auto-description refresh for the NULL default group", async () => {
    // `connectionId: "default"` resolves to the NULL flat-default group, which
    // has no group id to key a description under — the refresh must not fire.
    await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "users", yaml: "table: users\n" }],
    });
    expect(mockRefreshGroupAutoDescription).not.toHaveBeenCalled();
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

  it("populates the per-org semantic_entities table via bulkUpsertEntities (#2142)", async () => {
    // Pre-fix the wizard wrote YAMLs to disk only — the DB-backed
    // per-org whitelist consumed by the MCP edge stayed empty, so every
    // executeSQL call against wizard-onboarded workspaces hit
    // `unknown_entity`.
    mockBulkUpsertEntities.mockClear();
    mockInvalidateOrgWhitelist.mockClear();

    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "warehouse",
      entities: [
        { tableName: "users", yaml: "table: users\n" },
        { tableName: "orders", yaml: "table: orders\n" },
      ],
    });
    expect(res.status).toBe(201);

    expect(mockBulkUpsertEntities).toHaveBeenCalledTimes(1);
    const [orgIdArg, entitiesArg] = mockBulkUpsertEntities.mock.calls[0];
    expect(orgIdArg).toBe("org-1");
    expect(entitiesArg).toHaveLength(2);
    // Rows are scoped by the Connection group (#3234), not the raw
    // connectionId — "warehouse" resolves to its group (group-of-one here).
    expect(entitiesArg[0]).toMatchObject({
      entityType: "entity",
      name: "users",
      yamlContent: "table: users\n",
      connectionGroupId: "warehouse",
    });
    expect(entitiesArg[1]).toMatchObject({
      entityType: "entity",
      name: "orders",
      connectionGroupId: "warehouse",
    });

    expect(mockInvalidateOrgWhitelist).toHaveBeenCalledWith("org-1");
  });

  it("routes two members of the same group to one shared group key (no duplicate on member-add)", async () => {
    // Adding a MEMBER to an already-populated group must not create a second
    // copy of its entities (#3234). Both member connections resolve to the
    // SAME connection_group_id, so saving via either upserts the shared
    // group rows (the DB ON CONFLICT keys on connection_group_id) rather
    // than inserting a duplicate. This pins the wizard half: both members
    // route the same (name, group) key into bulkUpsertEntities.
    mockResolveGroupId.mockReset();
    mockResolveGroupId.mockImplementation(async () => "prod-group"); // every member → same group
    mockBulkUpsertEntities.mockClear();
    mockMkdirSync.mockReset();

    const save = (conn: string) =>
      postJson("/api/v1/wizard/save", {
        connectionId: conn,
        entities: [{ tableName: "orders", yaml: "table: orders\n" }],
      });

    const first = await save("us-prod");
    const second = await save("eu-prod"); // member added to the already-populated group

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(mockBulkUpsertEntities).toHaveBeenCalledTimes(2);

    const firstEntities = mockBulkUpsertEntities.mock.calls[0][1];
    const secondEntities = mockBulkUpsertEntities.mock.calls[1][1];
    // Same (name, group) key on both members → upsert, never a second row.
    expect(firstEntities[0]).toMatchObject({ name: "orders", connectionGroupId: "prod-group" });
    expect(secondEntities[0]).toMatchObject({ name: "orders", connectionGroupId: "prod-group" });

    // Both members write into the SAME on-disk group namespace, not a
    // per-connection dir — so the disk layer doesn't duplicate either.
    const path = await import("path");
    const mkdirPaths = mockMkdirSync.mock.calls.map(([dir]) => String(dir));
    expect(mkdirPaths.every((p) => !p.includes(path.join("groups", "us-prod")))).toBe(true);
    expect(mkdirPaths.every((p) => !p.includes(path.join("groups", "eu-prod")))).toBe(true);
    expect(mkdirPaths.some((p) => p.includes(path.join("groups", "prod-group")))).toBe(true);
  });

  it("fails closed with 500 save_failed when group resolution throws (no misscoped write)", async () => {
    // The resolved group keys both the DB rows and the on-disk groups/<group>/
    // dir. If resolution throws, we must abort BEFORE any write rather than
    // silently fall through to the default group and misscope the entities.
    mockResolveGroupId.mockReset();
    mockResolveGroupId.mockRejectedValueOnce(new Error("internal DB unreachable"));
    mockBulkUpsertEntities.mockClear();
    mockWriteFileSync.mockClear();

    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "warehouse",
      entities: [{ tableName: "users", yaml: "table: users\n" }],
    });

    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("save_failed");
    expect(data.requestId).toBeDefined();
    // Fail-closed: neither the DB nor the disk was touched.
    expect(mockBulkUpsertEntities).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("returns 500 db_persist_failed when bulkUpsertEntities throws", async () => {
    // DB write failure must NOT silently succeed — the disk YAMLs alone
    // leave wizard-onboarded workspaces broken on MCP. Surface the
    // failure so the operator notices instead of discovering it via a
    // customer report.
    mockBulkUpsertEntities.mockClear();
    mockWriteFileSync.mockClear();
    mockBulkUpsertEntities.mockImplementationOnce(() => Promise.reject(new Error("internal DB unreachable")));

    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "users", yaml: "table: users\n" }],
    });

    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("db_persist_failed");
    // DB-first ordering: on DB failure, no disk writes should have happened.
    // Otherwise a 500 leaves orphan YAMLs on disk for the operator to clean up.
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("returns 500 db_partial_persist when bulkUpsertEntities reports a partial count", async () => {
    // bulkUpsertEntities swallows per-entity errors and returns the count
    // that succeeded. Returning 201 in that case would silently recreate
    // the #2142 unknown_entity failure for the rows that didn't land —
    // the half-broken state is worse than a clear failure the operator
    // can retry.
    mockBulkUpsertEntities.mockClear();
    mockBulkUpsertEntities.mockImplementationOnce(async (_orgId, entitiesArg) =>
      Math.max(0, entitiesArg.length - 1),
    );

    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [
        { tableName: "users", yaml: "table: users\n" },
        { tableName: "orders", yaml: "table: orders\n" },
      ],
    });

    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("db_partial_persist");
    expect(data.attempted).toBe(2);
    expect(data.succeeded).toBe(1);
  });

  it("surfaces syncEntityToDisk failures in the response warnings array", async () => {
    // The org-scoped semantic dir feeds the explore tool. A silent .catch
    // here recreates the same split-state failure mode #2142 was filed to
    // fix, just on the file path instead of the DB path. Make per-entity
    // disk-sync failures visible so the operator can act on them.
    mockBulkUpsertEntities.mockClear();
    mockSyncEntityToDisk.mockReset();
    // First entity syncs cleanly; second entity's disk sync throws.
    mockSyncEntityToDisk.mockImplementationOnce(async () => {});
    mockSyncEntityToDisk.mockImplementationOnce(async () => {
      throw new Error("EACCES: permission denied");
    });

    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [
        { tableName: "users", yaml: "table: users\n" },
        { tableName: "orders", yaml: "table: orders\n" },
      ],
    });

    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.saved).toBe(true);
    const warnings = data.warnings as Array<{ kind: string; tableName: string; reason: string }>;
    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: "disk_sync_failed",
      tableName: "orders",
    });
    expect(typeof warnings[0].reason).toBe("string");
  });

  it("omits the warnings field on a clean save (no disk-sync failures)", async () => {
    mockBulkUpsertEntities.mockClear();
    mockSyncEntityToDisk.mockReset();
    mockSyncEntityToDisk.mockImplementation(async () => {});

    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "users", yaml: "table: users\n" }],
    });

    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.saved).toBe(true);
    expect("warnings" in data).toBe(false);
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

  it("sanitizes path-bearing metric table names via path.basename before writing (#3529 filename safety)", async () => {
    // The wizard delegates catalog/glossary/metric assembly to the shared core
    // but PRESERVES its own filename-safety guard: a path-bearing profile table
    // name (which the SAFE_TABLE_NAME entity guard never sees, since profiles
    // arrive separately) must be reduced to its basename via
    // `safeSemanticRowName` so the metric file can never escape metricsDir.
    mockWriteFileSync.mockClear();
    const unsafeMetricProfile = { ...mockOrdersProfile, table_name: "../../../etc/passwd" };

    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      // Entities carry a safe name (they pass the SAFE_TABLE_NAME guard); the
      // path-bearing name lives only in the raw profile.
      entities: [{ tableName: "passwd", yaml: "table: passwd\n" }],
      schema: "public",
      profiles: [unsafeMetricProfile],
    });

    expect(res.status).toBe(201);
    const data = await json(res);
    const files = data.files as string[];
    // basename("../../../etc/passwd") === "passwd": the metric lands under the
    // sanitized name, never the traversing path.
    expect(files).toContain("metrics/passwd.yml");

    // Defense-in-depth: no write path escapes via the raw traversing name.
    const writePaths = mockWriteFileSync.mock.calls.map(([p]) => String(p));
    expect(writePaths.every((p) => !p.includes("etc/passwd"))).toBe(true);
    expect(writePaths.every((p) => !p.includes(".."))).toBe(true);

    // The persisted metric row is keyed by the same sanitized basename.
    const allRows = mockBulkUpsertEntities.mock.calls.flatMap(([, rows]) => rows);
    const metricRows = allRows.filter((r) => r.entityType === "metric");
    expect(metricRows.length).toBeGreaterThan(0);
    expect(metricRows[0].name).toBe("passwd");
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

  // --- Metric persistence: wizard /save converges with SemanticGenerator.persist (#3550) ---

  it("persists generated metrics to semantic_entities as draft metric rows, not disk-only (#3550)", async () => {
    // Pre-#3550 the wizard wrote metrics to disk only — they never landed in
    // `semantic_entities`, so a wizard-onboarded workspace had a different
    // metric durability guarantee than an MCP-profiled one. Both paths now
    // persist metrics to the DB via bulkUpsertEntities.
    mockBulkUpsertEntities.mockClear();
    mockInvalidateOrgWhitelist.mockClear();

    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "orders", yaml: "table: orders\n" }],
      schema: "public",
      profiles: [mockOrdersProfile],
    });
    expect(res.status).toBe(201);

    // Some bulkUpsertEntities call carries a `metric` row keyed identically to
    // the MCP path (path.basename(table) → "orders"), scoped by the resolved
    // connection group (default connection → NULL default group).
    const allRows = mockBulkUpsertEntities.mock.calls.flatMap(([, rows]) => rows);
    const metricRows = allRows.filter((r) => r.entityType === "metric");
    expect(metricRows.length).toBeGreaterThan(0);
    expect(metricRows[0]).toMatchObject({
      entityType: "metric",
      name: "orders",
      connectionGroupId: null,
    });
    expect(typeof metricRows[0].yamlContent).toBe("string");
    expect((metricRows[0].yamlContent as string).length).toBeGreaterThan(0);

    // Disk write is RETAINED but additive — the metric YAML is still on disk
    // for legibility (DB is the source of truth for queryability).
    const data = await json(res);
    const files = data.files as string[];
    expect(files).toContain("metrics/orders.yml");
  });

  it("fails loud (db_partial_persist) on a partial metric upsert — contract pin against drift back to disk-only (#3550)", async () => {
    // Pins the chosen contract: metrics go through bulkUpsertEntities and a
    // short count fails the whole save, exactly like entities. A future
    // regression that writes metrics to disk only (no DB call) would never
    // produce a `metric` upsert, so this short-count path could not fire — the
    // test would fail, flagging the drift.
    mockBulkUpsertEntities.mockClear();
    mockWriteFileSync.mockClear();
    // Entities upsert fully; the metric upsert lands one row short.
    mockBulkUpsertEntities.mockImplementation(async (_orgId, rows) =>
      rows.some((r) => r.entityType === "metric") ? Math.max(0, rows.length - 1) : rows.length,
    );

    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "orders", yaml: "table: orders\n" }],
      schema: "public",
      profiles: [mockOrdersProfile],
    });

    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("db_partial_persist");
    expect(data.requestId).toBeDefined();
    // beforeEach resets the impl, so no manual restore is needed here.
  });

  it("returns 500 db_persist_failed when the metric upsert throws (#3550)", async () => {
    // Distinct from the partial-count branch: a *thrown* metric upsert (DB
    // unreachable) must fail loud, not 201 a workspace whose metrics never
    // landed. Mirrors the entity `db_persist_failed` test.
    mockBulkUpsertEntities.mockReset();
    // First call (entities) succeeds; second call (metrics) rejects.
    mockBulkUpsertEntities.mockImplementationOnce(async (_orgId, rows) => rows.length);
    mockBulkUpsertEntities.mockImplementationOnce(() =>
      Promise.reject(new Error("internal DB unreachable")),
    );

    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "orders", yaml: "table: orders\n" }],
      schema: "public",
      profiles: [mockOrdersProfile],
    });

    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("db_persist_failed");
    expect(data.requestId).toBeDefined();
  });

  it("falls through to disk-only metrics when there is no internal DB (#3550)", async () => {
    // Self-hosted without an internal DB: the DB persist is gated on
    // hasInternalDB(), so metrics must still be written to disk and the save
    // must 201 without ever calling bulkUpsertEntities for a metric row.
    mockHasInternalDB.mockReset();
    mockHasInternalDB.mockImplementation(() => false);
    mockBulkUpsertEntities.mockClear();

    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "default",
      entities: [{ tableName: "orders", yaml: "table: orders\n" }],
      schema: "public",
      profiles: [mockOrdersProfile],
    });

    expect(res.status).toBe(201);
    // No DB → no upsert at all (entities or metrics).
    expect(mockBulkUpsertEntities).not.toHaveBeenCalled();
    // Metric YAML still lands on disk (the only durable copy in this mode).
    const data = await json(res);
    expect(data.files as string[]).toContain("metrics/orders.yml");
  });

  it("scopes persisted metric rows by the resolved connection group, not the raw connectionId (#3550)", async () => {
    // The metric row carries connectionGroupId — the same group-keying the
    // entity rows use (#3234). A non-default connection resolves to its group
    // (group-of-one here), so the metric must NOT be scoped to the NULL default
    // group. Pins the field the convergence comment calls shared-keying-critical.
    mockBulkUpsertEntities.mockClear();

    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "warehouse",
      entities: [{ tableName: "orders", yaml: "table: orders\n" }],
      schema: "public",
      profiles: [mockOrdersProfile],
    });

    expect(res.status).toBe(201);
    const allRows = mockBulkUpsertEntities.mock.calls.flatMap(([, rows]) => rows);
    const metricRows = allRows.filter((r) => r.entityType === "metric");
    expect(metricRows.length).toBeGreaterThan(0);
    expect(metricRows[0]).toMatchObject({
      entityType: "metric",
      name: "orders",
      connectionGroupId: "warehouse",
    });
  });

  // ── #3682 — durable partial-profile marker on the wizard /save path ──
  // The wizard persists via bulkUpsertEntities (not SemanticGenerator.persist),
  // so it writes the marker directly when the client forwards the `/generate`
  // failures. These pin the second acceptance criterion (wizard-path persistence).
  describe("durable partial-profile marker (#3682)", () => {
    beforeEach(() => {
      mockUpsertProfileStatus.mockReset();
      mockUpsertProfileStatus.mockImplementation(async () => {});
      // Pin the resolver — an earlier test pins it to a constant group and
      // never restores, so re-establish the default scope mapping here.
      mockResolveGroupId.mockReset();
      mockResolveGroupId.mockImplementation(async (_orgId, connectionId) =>
        !connectionId || connectionId === "default" ? null : connectionId,
      );
    });

    it("writes the marker with the forwarded failures + attempted total", async () => {
      const res = await postJson("/api/v1/wizard/save", {
        connectionId: "warehouse",
        entities: [
          { tableName: "users", yaml: "table: users\n" },
          { tableName: "orders", yaml: "table: orders\n" },
        ],
        failedTables: [{ table: "locked", error: "permission denied" }],
        totalTables: 3,
      });
      expect(res.status).toBe(201);

      expect(mockUpsertProfileStatus).toHaveBeenCalledTimes(1);
      const [orgIdArg, groupArg, inputArg] = mockUpsertProfileStatus.mock.calls[0];
      expect(orgIdArg).toBe("org-1");
      // Scoped by the resolved connection group (#3234), not the raw connectionId.
      expect(groupArg).toBe("warehouse");
      expect(inputArg.totalTables).toBe(3);
      expect(inputArg.failedTables).toEqual([
        { table: "locked", error: "permission denied" },
      ]);
    });

    it("records completeness (empty failedTables) — clears a prior partial marker", async () => {
      const res = await postJson("/api/v1/wizard/save", {
        connectionId: "default",
        entities: [{ tableName: "users", yaml: "table: users\n" }],
        failedTables: [],
        totalTables: 1,
      });
      expect(res.status).toBe(201);
      // An empty failedTables write is what CLEARS a stale partial marker, so
      // the marker is still written (not skipped).
      expect(mockUpsertProfileStatus).toHaveBeenCalledTimes(1);
      const [, groupArg, inputArg] = mockUpsertProfileStatus.mock.calls[0];
      expect(groupArg).toBeNull(); // default group
      expect(inputArg.failedTables).toEqual([]);
    });

    it("does not write the marker when failedTables is omitted (back-compat)", async () => {
      const res = await postJson("/api/v1/wizard/save", {
        connectionId: "warehouse",
        entities: [{ tableName: "users", yaml: "table: users\n" }],
      });
      expect(res.status).toBe(201);
      expect(mockUpsertProfileStatus).not.toHaveBeenCalled();
    });

    it("still returns 201 when the marker write throws (best-effort)", async () => {
      mockUpsertProfileStatus.mockImplementationOnce(async () => {
        throw new Error("status table unavailable");
      });
      const res = await postJson("/api/v1/wizard/save", {
        connectionId: "warehouse",
        entities: [{ tableName: "users", yaml: "table: users\n" }],
        failedTables: [{ table: "locked", error: "permission denied" }],
        totalTables: 2,
      });
      // Entities ARE persisted — a marker-write failure must not fail the save.
      expect(res.status).toBe(201);
      expect(mockUpsertProfileStatus).toHaveBeenCalledTimes(1);
    });
  });
});

// =====================================================================
// Profiler dispatch for a plugin dbType (#3657 / ADR-0017)
//
// The wizard reads introspection off the ONE resolved live connection
// (`resolveWizardConnection`). These tests pin that dispatch end-to-end with a
// clickhouse-shaped connection: a plugin connection flows the same baseline →
// enrich → save path pg/mysql does, and a connection exposing no profiling
// capability surfaces the actionable not_profilable state, and a plugin that
// doesn't implement the contract surfaces the actionable `not_profilable` state
// (the only remaining rejection — the "PostgreSQL and MySQL" gate is gone).
// =====================================================================

describe("wizard profiler-seam dispatch — plugin dbType (#3621)", () => {
  // A clickhouse install: registry has it, internal DB returns a clickhouse://
  // url (→ detectDBType → "clickhouse"), decrypt passes the url through.
  function registerClickHouseConnection() {
    mockConnectionHas.mockImplementation((id: string) => id === "analytics" || id === "default");
    mockConnectionDescribe.mockImplementation(() => [
      { id: "default", dbType: "postgres", status: "healthy" },
      { id: "analytics", dbType: "clickhouse", status: "healthy" },
    ]);
    mockInternalQuery.mockImplementation(async () => [
      {
        config: { url: "clickhouse://localhost:8123/analytics", schema: "default" },
        schema_name: "default",
        config_schema: null,
      },
    ]);
    mockDecryptUrl.mockImplementation((url: string) => url);
  }

  // Inject a plugin capability with spy list/profile fns returning a usable
  // profile so the shared generate engine emits an entity.
  const pluginListObjects = mock(async () => [
    { name: "events", type: "table" },
    { name: "sessions", type: "table" },
  ]);
  const pluginProfile = mock(async () => ({ profiles: [mockOrdersProfile], errors: [] }));

  function injectClickHousePlugin() {
    mockResolveWizardConnection.mockImplementation(async () =>
      okCtx({
        dbType: "clickhouse",
        querySchema: "default",
        listObjects: pluginListObjects,
        profile: pluginProfile,
      }),
    );
  }

  beforeEach(() => {
    pluginListObjects.mockClear();
    pluginProfile.mockClear();
  });

  it("profile → lists tables via the plugin's listObjects for a clickhouse dbType", async () => {
    registerClickHouseConnection();
    injectClickHousePlugin();

    const res = await postJson("/api/v1/wizard/profile", { connectionId: "analytics" });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.connectionId).toBe("analytics");
    expect(data.dbType).toBe("clickhouse");
    const tables = data.tables as { name: string }[];
    expect(tables.map((t) => t.name).toSorted()).toEqual(["events", "sessions"]);
    // Routed through the ONE resolver (the same `resolveLiveConnection` MCP uses),
    // reading `listObjects` off the resolved live connection — not the native pg path.
    expect(mockResolveWizardConnection).toHaveBeenCalledWith("analytics", "org-1");
    expect(pluginListObjects).toHaveBeenCalledTimes(1);
    expect(mockListPostgresObjects).not.toHaveBeenCalled();
  });

  it("generate → profiles + emits clickhouse-dialect entity YAML via the plugin profiler", async () => {
    registerClickHouseConnection();
    injectClickHousePlugin();

    const res = await postJson("/api/v1/wizard/generate", {
      connectionId: "analytics",
      tables: ["orders"],
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.dbType).toBe("clickhouse");
    const entities = data.entities as { tableName: string; yaml: string }[];
    expect(entities.length).toBe(1);
    expect(entities[0].tableName).toBe("orders");
    // The plugin's profile fn ran; the native pg profiler did not.
    expect(pluginProfile).toHaveBeenCalledTimes(1);
    expect(mockProfilePostgres).not.toHaveBeenCalled();
  });

  it("enrich → re-profiles one table via the plugin profiler", async () => {
    registerClickHouseConnection();
    injectClickHousePlugin();

    const res = await postJson("/api/v1/wizard/enrich", {
      connectionId: "analytics",
      tableName: "orders",
      yaml: "table: orders\n",
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.tableName).toBe("orders");
    expect(data.enriched).toBe(true);
    // Re-profile-on-enrich ran through the plugin profiler, and the enrichment
    // engine got the datasource dialect (clickhouse) as its 5th arg.
    expect(pluginProfile).toHaveBeenCalledTimes(1);
    expect(mockEnrichEntityYaml).toHaveBeenCalledTimes(1);
    expect(mockEnrichEntityYaml.mock.calls[0][4]).toBe("clickhouse");
  });

  // A clickhouse install whose resolved connection exposes no profiling
  // capability → the resolver surfaces the actionable not-profilable state.
  function injectUnprofilableClickHouse() {
    mockResolveWizardConnection.mockImplementation(async () => ({
      kind: "unsupported" as const,
      message:
        `Datasource type "clickhouse" cannot be profiled in this deployment. No registered plugin ` +
        `builds a live connection exposing the introspection capability (connection.profile) for it.`,
    }));
  }

  it("profile → returns the actionable not_profilable state when the plugin doesn't implement profiling", async () => {
    registerClickHouseConnection();
    injectUnprofilableClickHouse();
    const res = await postJson("/api/v1/wizard/profile", { connectionId: "analytics" });
    expect(res.status).toBe(400);
    const data = await json(res);
    expect(data.error).toBe("not_profilable");
    expect(typeof data.message).toBe("string");
    expect(data.message as string).toContain("clickhouse");
    // The removed gate's copy must NOT appear.
    expect(data.message as string).not.toContain("currently supported for PostgreSQL and MySQL");
  });

  it("generate → returns not_profilable (400) when the plugin doesn't implement profiling", async () => {
    registerClickHouseConnection();
    injectUnprofilableClickHouse();
    const res = await postJson("/api/v1/wizard/generate", {
      connectionId: "analytics",
      tables: ["events"],
    });
    expect(res.status).toBe(400);
    const data = await json(res);
    expect(data.error).toBe("not_profilable");
  });

  it("enrich → returns not_profilable (400) when the plugin doesn't implement profiling", async () => {
    registerClickHouseConnection();
    injectUnprofilableClickHouse();
    const res = await postJson("/api/v1/wizard/enrich", {
      connectionId: "analytics",
      tableName: "events",
      yaml: "table: events\n",
    });
    expect(res.status).toBe(400);
    const data = await json(res);
    expect(data.error).toBe("not_profilable");
    // Fail-closed: never profiled, never enriched.
    expect(mockEnrichEntityYaml).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Connection resolution → route mapping (#3657)
//
// Resolution moved into the ONE resolver (`resolveWizardConnection`, riding
// `resolveLiveConnection`); its internals — workspace vs global vs env-var
// byproduct, the connections.has gate — are unit-tested in
// `datasources/__tests__/wizard-connection.test.ts`. Here we pin the ROUTE's
// mapping of each resolver outcome to an HTTP response.
// =====================================================================

describe("wizard connection resolution → route mapping", () => {
  it("not_found → 404 with the connectionId in the message", async () => {
    mockResolveWizardConnection.mockImplementation(async () => ({ kind: "not_found" }));

    const res = await postJson("/api/v1/wizard/profile", { connectionId: "nonexistent" });
    expect(res.status).toBe(404);
    const data = await json(res);
    expect(data.error).toBe("not_found");
    expect(data.message).toContain("nonexistent");
  });

  it("resolver throws (infrastructure error) → 500 connection_resolution_failed + requestId", async () => {
    mockResolveWizardConnection.mockImplementation(async () => {
      throw new Error("Connection pool exhausted");
    });

    const res = await postJson("/api/v1/wizard/profile", { connectionId: "default" });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("connection_resolution_failed");
    expect(data.requestId).toBeDefined();
  });

  it("reconnect_required (OAuth token stale) → 400 reconnect_required", async () => {
    mockResolveWizardConnection.mockImplementation(async () => ({
      kind: "reconnect_required",
      message: "The salesforce connection needs to be reconnected before it can be profiled.",
    }));

    const res = await postJson("/api/v1/wizard/profile", { connectionId: "sf" });
    expect(res.status).toBe(400);
    const data = await json(res);
    expect(data.error).toBe("reconnect_required");
  });

  it("ok → 200 (the resolver handled workspace/global/env-var resolution internally)", async () => {
    // Default impl resolves an ok postgres context — the route just profiles it.
    const res = await postJson("/api/v1/wizard/profile", { connectionId: "default" });
    expect(res.status).toBe(200);
  });
});

// =====================================================================
// __demo__ end-to-end — see resolveConnectionUrl fallback in wizard.ts
// for the WHY. The wizard datasource list surfaces __demo__ but not
// other underscore-prefixed ids; these tests pin both halves of that
// asymmetry end-to-end.
// =====================================================================

describe("wizard __demo__ end-to-end", () => {
  /**
   * Make the runtime registry mirror production: loadSavedConnections()
   * has registered both `default` and `__demo__`, so describe() returns
   * an entry for each. Tests can still override `mockInternalQuery` to
   * simulate the user's session not finding a row for their orgId.
   */
  function registerDemoInRegistry() {
    mockConnectionHas.mockImplementation((id: string) => id === "__demo__" || id === "default");
    mockConnectionDescribe.mockImplementation(() => [
      { id: "default", dbType: "postgres", status: "healthy" },
      { id: "__demo__", dbType: "postgres", status: "healthy" },
    ]);
  }

  it("profile → returns the demo schema's table list (no 404)", async () => {
    registerDemoInRegistry();
    const res = await postJson("/api/v1/wizard/profile", { connectionId: "__demo__" });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.connectionId).toBe("__demo__");
    expect(Array.isArray(data.tables)).toBe(true);
    expect((data.tables as unknown[]).length).toBeGreaterThan(0);
  });

  it("generate → profiles tables via the demo connection", async () => {
    registerDemoInRegistry();
    const res = await postJson("/api/v1/wizard/generate", {
      connectionId: "__demo__",
      tables: ["users"],
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.connectionId).toBe("__demo__");
    const entities = data.entities as { tableName: string }[];
    expect(entities.length).toBe(1);
    expect(entities[0].tableName).toBe("users");
  });

  it("save → persists the demo entities under the __demo__ group namespace (not default/)", async () => {
    registerDemoInRegistry();
    const res = await postJson("/api/v1/wizard/save", {
      connectionId: "__demo__",
      entities: [{ tableName: "users", yaml: "table: users\n" }],
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.saved).toBe(true);
    expect(data.connectionId).toBe("__demo__");
    expect(data.orgId).toBe("org-1");

    // Pin the group-scoping branch in wizard.ts: __demo__ resolves to its
    // own Connection group, so it must NOT collapse into the `default`
    // output dir (`semantic/.orgs/{orgId}/`). Under ADR-0012 (#3234) it
    // lands in the canonical groups/<group>/ namespace
    // (`semantic/.orgs/{orgId}/groups/__demo__/`) so a demo wipe doesn't
    // blow away an org's real semantic layer.
    const path = await import("path");
    const mkdirPaths = mockMkdirSync.mock.calls.map(([dir]) => String(dir));
    expect(mkdirPaths.some((p) => p.includes(path.join("groups", "__demo__")))).toBe(true);
  });

  it("profile → resolves __demo__ when the resolver returns ok (e.g. env-var byproduct)", async () => {
    // The resolver owns the workspace-miss → ATLAS_DATASOURCE_URL byproduct
    // fallback (unit-tested in wizard-connection.test.ts). At the route level we
    // pin that an ok outcome for __demo__ profiles normally.
    registerDemoInRegistry();
    const res = await postJson("/api/v1/wizard/profile", { connectionId: "__demo__" });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.connectionId).toBe("__demo__");
  });

  it("profile → 404s for __demo__ when the resolver finds nothing (not registered, no DB row)", async () => {
    // The connections.has gate + workspace/global misses live in the resolver;
    // here we pin the route maps that not_found to a 404 rather than silently
    // profiling ATLAS_DATASOURCE_URL.
    mockResolveWizardConnection.mockImplementation(async () => ({ kind: "not_found" }));
    const res = await postJson("/api/v1/wizard/profile", { connectionId: "__demo__" });
    expect(res.status).toBe(404);
    const data = await json(res);
    expect(data.error).toBe("not_found");
  });

  it("profile → 404s for other underscore-prefixed identities (e.g. draft_test)", async () => {
    // Mirror the wizard frontend filter: only __demo__ is first-class. The
    // resolver never env-var-profiles a stray `_`-prefixed id → not_found → 404.
    mockResolveWizardConnection.mockImplementation(async () => ({ kind: "not_found" }));
    const originalUrl = process.env.ATLAS_DATASOURCE_URL;
    process.env.ATLAS_DATASOURCE_URL = "postgresql://fallback/atlas";
    try {
      const res = await postJson("/api/v1/wizard/profile", { connectionId: "draft_test" });
      expect(res.status).toBe(404);
      const data = await json(res);
      expect(data.error).toBe("not_found");
    } finally {
      if (originalUrl === undefined) delete process.env.ATLAS_DATASOURCE_URL;
      else process.env.ATLAS_DATASOURCE_URL = originalUrl;
    }
  });
});
