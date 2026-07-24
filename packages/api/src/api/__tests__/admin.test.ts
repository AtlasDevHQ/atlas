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
  makeQueryEffectMock,
  MockInternalDB,
  makeMockInternalDBShimLayer,
} from "@atlas/api/testing/api-test-mocks";
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

  // #2891 fixture — YAML's `name:` ("AuditLog") deliberately differs
  // from the file stem ("audit_log") so list→detail roundtrip tests
  // exercise the storage-key path. Pre-fix this was the production
  // failure mode reported on app.useatlas.dev: clicking the entity
  // hit `/api/v1/admin/semantic/entities/AuditLog` and 404'd because
  // the DB row / file stem stored `audit_log`.
  fs.writeFileSync(
    path.join(tmpRoot, "entities", "audit_log.yml"),
    `name: AuditLog
table: audit_log
description: Audit trail rows
dimensions:
  id:
    type: integer
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
// Module-top env setup — must be set before the dynamic imports below
// (the imported modules read env at module-load time). Unconditional `=`
// is intentional: this test owns `tmpRoot`, so a parent-env value would
// break hermetic isolation (post-#2813 codex fix). The
// `packages/api/src/test-setup.ts` preload strips `ATLAS_*` per-file so
// cross-file leakage under `bun test --parallel` (#2797) stays bounded
// — for path-typed test-owned vars, the override behavior is required.
// #4655 / #4751 — capture the preload's per-process semantic sandbox so the
// teardown RESTORES it rather than deleting the var. A bare `delete` drops
// every later suite in a shared process back to `{cwd}/semantic`, which is the
// developer-checkout litter the sandbox exists to prevent.
const priorSemanticRoot = process.env.ATLAS_SEMANTIC_ROOT;
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

void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mockCheckRateLimit,
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  rateLimitCleanupTick: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
}));

void mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "simple-key",
  resetAuthModeCache: () => {},
}));

// F-53 — admin routes refine `adminAuth` with `requirePermission()` /
// `enforcePermission()`. Post-#2571 (slice 9/11 of #2017) the route layer
// yields `RolesPolicy`; the no-op `NoopRolesPolicyLayer` delegates to
// the core `permission-resolve.checkPermission` (legacy admin → all-flags
// mapping). Negative-path coverage lives in
// `routes/__tests__/permission-enforcement.test.ts`.
import { Effect as F53Effect } from "effect";

void mock.module("@atlas/api/lib/auth/roles-errors", () => ({
  RoleError: class extends Error {
    public readonly _tag = "RoleError" as const;
    public readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = "RoleError";
      this.code = code;
    }
  },
}));

// Legacy module-mock stub for any transitive resolver chain. ALL named
// exports admin-roles.ts imports must be stubbed so module load doesn't
// throw "Export named 'X' not found" — slice 11 closeout #2573 will drop
// this entirely.
void mock.module("@atlas/ee/auth/roles", () => ({
  PERMISSIONS: [
    "query", "query:raw_data", "admin:users", "admin:connections",
    "admin:settings", "admin:audit", "admin:roles", "admin:semantic",
  ] as const,
  isValidPermission: () => true,
  isValidRoleName: () => true,
  BUILTIN_ROLES: [],
  resolvePermissions: () => F53Effect.succeed(new Set()),
  hasPermission: () => F53Effect.succeed(true),
  checkPermission: () => F53Effect.succeed(null),
  listRoles: () => F53Effect.succeed([]),
  getRole: () => F53Effect.succeed(null),
  getRoleByName: () => F53Effect.succeed(null),
  createRole: () => F53Effect.die(new Error("not configured")),
  updateRole: () => F53Effect.die(new Error("not configured")),
  deleteRole: () => F53Effect.succeed(true),
  listRoleMembers: () => F53Effect.succeed([]),
  assignRole: () => F53Effect.die(new Error("not configured")),
  seedBuiltinRoles: () => F53Effect.succeed(undefined),
  RoleError: class extends Error {
    public readonly _tag = "RoleError" as const;
    public readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = "RoleError";
      this.code = code;
    }
  },
}));

void mock.module("@atlas/api/lib/startup", () => ({
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

const mockConnectionsHas: Mock<(id: string) => boolean> = mock(() => true);

void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => mockDBConnection,
    connections: {
      get: () => mockDBConnection,
      getDefault: () => mockDBConnection,
      describe: () => [
        { id: "default", dbType: "postgres", description: "Test DB" },
      ],
      has: mockConnectionsHas,
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

void mock.module("@atlas/api/lib/semantic", () => ({
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
const mockGetWorkspaceDetails: Mock<(orgId: string) => Promise<Record<string, unknown> | null>> = mock(
  async () => null,
);

void mock.module("@atlas/api/lib/db/internal", () => ({
  InternalDB: MockInternalDB,
  makeInternalDBShimLayer: () =>
    makeMockInternalDBShimLayer(mockInternalQuery, { available: mockHasInternalDB }),
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: mockInternalQuery,
  withWorkspaceAdminLock: (
    _orgId: string,
    fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<unknown>,
  ) => fn({ query: (sql: string, params?: unknown[]) => mockInternalQuery(sql, params) }),
  withWorkspaceAdminLocks: (
    _orgIds: readonly string[],
    fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<unknown>,
  ) => fn({ query: (sql: string, params?: unknown[]) => mockInternalQuery(sql, params) }),
  queryEffect: makeQueryEffectMock(mockInternalQuery),
  internalExecute: mock(() => {}),
  isInternalCircuitOpen: () => false,
  getInternalDB: mock(() => ({})),
  closeInternalDB: mock(async () => {}),
  migrateInternalDB: mock(async () => {}),
  loadSavedConnections: mock(async () => 0),
  _resetPool: mock(() => {}),
  _resetCircuitBreaker: mock(() => {}),
  encryptSecret: (url: string) => url,
  decryptSecret: (url: string) => url,
  getEncryptionKey: () => null,
  isPlaintextUrl: (value: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value),
  _resetEncryptionKeyCache: mock(() => {}),
  findPatternBySQL: async () => null,
  insertLearnedPattern: () => {},
  incrementPatternCount: () => {},
  getApprovedPatterns: mock(async () => []),
  // #4580 — the learned-patterns route (loaded at app boot) imports this shared
  // org-scope helper; provide it so its named import doesn't SyntaxError here.
  amendmentOrgScope: (orgId: string | null, ph: string) =>
    orgId ? { withhold: false, clause: `(org_id = ${ph} OR org_id IS NULL)` } : { withhold: false, clause: "org_id IS NULL" },
  upsertSuggestion: mock(() => Promise.resolve("created")),
  getSuggestionsByTables: mock(() => Promise.resolve([])),
  getPopularSuggestions: mock(() => Promise.resolve([])),
  incrementSuggestionClick: mock(),
  deleteSuggestion: mock(() => Promise.resolve(false)),
  getAuditLogQueries: mock(() => Promise.resolve([])),
  getWorkspaceStatus: mock(async () => "active"),
  getWorkspaceDetails: mockGetWorkspaceDetails,
  getWorkspaceNamesByIds: mock(async () => new Map<string, string | null>()),
  updateWorkspaceStatus: mock(async () => true),
  updateWorkspacePlanTier: mock(async () => true),
  setWorkspaceTrialEndsAt: mock(async () => true),
  cascadeWorkspaceDelete: mock(async () => ({ conversations: 0, semanticEntities: 0, learnedPatterns: 0, suggestions: 0, scheduledTasks: 0, settings: 0 })),
  getWorkspaceHealthSummary: mock(async () => null),
  getWorkspaceRegion: mock(async () => null),
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
}));

void mock.module("@atlas/api/lib/cache", () => ({
  getCache: mock(() => ({ get: () => null, set: () => {}, delete: () => false, flush: () => {}, stats: () => ({}) })),
  cacheEnabled: mock(() => true),
  setCacheBackend: mock(() => {}),
  flushCache: mock(() => {}),
  getDefaultTtl: mock(() => 300000),
  _resetCache: mock(() => {}),
  buildCacheKey: mock(() => "mock-key"),
}));

void mock.module("@atlas/api/lib/workspace", () => ({
  checkWorkspaceStatus: mock(async () => ({ allowed: true })),
}));

void mock.module("@atlas/api/lib/learn/pattern-cache", () => ({
  buildLearnedPatternsSection: async () => "",
  getRelevantPatterns: async () => [],
  buildRetrievalQuery: () => "",
  getRetrievalTurns: () => 3,
  invalidatePatternCache: () => {},
  extractKeywords: () => new Set(),
  _resetPatternCache: () => {},
}));

// Org-scoped semantic entities mock
const mockListEntitiesAdmin: Mock<(orgId: string, type?: string) => Promise<unknown[]>> = mock(() => Promise.resolve([]));
const mockListEntitiesWithOverlay: Mock<(orgId: string, type?: string) => Promise<unknown[]>> = mock(() => Promise.resolve([]));
const mockGetEntityAdmin: Mock<(orgId: string, type: string, name: string) => Promise<unknown>> = mock(() => Promise.resolve(null));
const mockUpsertEntityAdmin: Mock<(...args: unknown[]) => Promise<void>> = mock(() => Promise.resolve());
const mockDeleteEntityAdmin: Mock<(orgId: string, type: string, name: string) => Promise<boolean>> = mock(() => Promise.resolve(false));
const mockUpsertDraftEntityAdmin: Mock<(...args: unknown[]) => Promise<void>> = mock(() => Promise.resolve());
const mockUpsertDraftEntityForGroupAdmin: Mock<(...args: unknown[]) => Promise<void>> = mock(() => Promise.resolve());
const mockUpsertTombstoneAdmin: Mock<(...args: unknown[]) => Promise<void>> = mock(() => Promise.resolve());
const mockDeleteDraftEntityAdmin: Mock<(...args: unknown[]) => Promise<boolean>> = mock(() => Promise.resolve(true));
const mockCreateVersion: Mock<(...args: unknown[]) => Promise<string>> = mock(() => Promise.resolve("version-1"));
const mockListVersions: Mock<(...args: unknown[]) => Promise<{ versions: unknown[]; total: number }>> = mock(() => Promise.resolve({ versions: [], total: 0 }));
const mockGetVersion: Mock<(...args: unknown[]) => Promise<unknown>> = mock(() => Promise.resolve(null));
const mockGenerateChangeSummary: Mock<(oldYaml: string | null, newYaml: string) => Promise<string | null>> = mock(() => Promise.resolve("Initial version"));

// Pull the real tagged error class through so `instanceof` checks in
// route handlers (e.g. version-snapshot catches that must re-throw
// ambiguity 409s) compare against the same class the production code
// throws. Without this the mocked import returns `undefined` and the
// `instanceof` always evaluates false (or worse, throws TypeError).
const { AmbiguousEntityError: RealAmbiguousEntityError } = await import(
  "@atlas/api/lib/effect/errors"
);

void mock.module("@atlas/api/lib/semantic/entities", () => ({
  upsertProfileStatus: mock(() => Promise.resolve()),
  listIncompleteProfileLayers: mock(() => Promise.resolve([])),
  AmbiguousEntityError: RealAmbiguousEntityError,
  listEntityRows: mockListEntitiesAdmin,
  listEntitiesWithOverlay: mockListEntitiesWithOverlay,
  listEntities: mock(() => Promise.resolve([])),
  getEntity: mockGetEntityAdmin,
  upsertEntity: mockUpsertEntityAdmin,
  deleteEntity: mockDeleteEntityAdmin,
  upsertDraftEntity: mockUpsertDraftEntityAdmin,
  upsertDraftEntityForGroup: mockUpsertDraftEntityForGroupAdmin,
  upsertTombstone: mockUpsertTombstoneAdmin,
  deleteDraftEntity: mockDeleteDraftEntityAdmin,
  upsertTombstoneForGroup: mockUpsertTombstoneAdmin,
  deleteDraftEntityForGroup: mockDeleteDraftEntityAdmin,
  countEntities: mock(() => Promise.resolve(0)),
  bulkUpsertEntities: mock(() => Promise.resolve(0)),
  resolveGroupIdForConnection: mock(() => Promise.resolve(null)),
  createVersion: mockCreateVersion,
  listVersions: mockListVersions,
  getVersion: mockGetVersion,
  generateChangeSummary: mockGenerateChangeSummary,
  // Publish / archive helpers (#1429, #1437) — not exercised here, but
  // must exist so admin-publish.ts / admin-archive.ts can resolve their
  // imports when admin routes load.
  applyTombstones: mock(() => Promise.resolve(0)),
  promoteDraftEntities: mock(() => Promise.resolve(0)),
  DEMO_CONNECTION_ID: "__demo__",
  archiveSingleConnection: mock(() =>
    Promise.resolve({ status: "not_found" as const }),
  ),
  restoreSingleConnection: mock(() =>
    Promise.resolve({ status: "not_found" as const }),
  ),
}));

const mockSyncEntityToDisk: Mock<(...args: unknown[]) => Promise<void>> = mock(() => Promise.resolve());
const mockSyncEntityDeleteFromDisk: Mock<(...args: unknown[]) => Promise<void>> = mock(() => Promise.resolve());

void mock.module("@atlas/api/lib/semantic/sync", () => ({
  syncEntityToDisk: mockSyncEntityToDisk,
  syncEntityDeleteFromDisk: mockSyncEntityDeleteFromDisk,
  syncAllEntitiesToDisk: mock(() => Promise.resolve(0)),
  importFromDisk: mock(() => Promise.resolve({ imported: 0, skipped: 0, errors: [], total: 0 })),
  reconcileAllOrgs: mock(() => Promise.resolve()),
  cleanupOrgDirectory: mock(() => Promise.resolve()),
  // Mirror the real `sync.getSemanticRoot(orgId?)` shape: returns the base
  // root (from the env-driven fixture) when no orgId, or the per-org overlay
  // under `.orgs/<orgId>/` when an orgId is supplied. Keeping this in sync
  // with the real signature matters because admin.ts now routes all 5
  // semantic-root resolutions through this module (PR fix: org-scope admin
  // disk endpoints).
  getSemanticRoot: mock((orgId?: string) =>
    orgId ? path.join(tmpRoot, ".orgs", orgId) : tmpRoot,
  ),
}));

const mockPluginHealthCheck: Mock<() => Promise<unknown>> = mock(() =>
  Promise.resolve({ healthy: true, message: "OK" }),
);

void mock.module("@atlas/api/lib/plugins/registry", () => ({
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

void mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
  explore: { type: "function" },
  invalidateExploreBackend: () => {},
  invalidateOrgExploreBackends: () => {},
}));

void mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(() =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      text: Promise.resolve("answer"),
    }),
  ),
}));

void mock.module("@atlas/api/lib/tools/actions", () => ({
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

// `mockRunDriftDiff` is module-scoped so per-test setups can override its
// return via `.mockResolvedValueOnce` / `.mockRejectedValueOnce`. Default
// is the in-sync envelope (zero introspected tables → drift fully muted).
const mockRunDriftDiff: Mock<(connectionId?: string) => Promise<unknown>> = mock(async () => ({
  diff: { newTables: [], removedTables: [], tableDiffs: [], unchangedCount: 0 },
  introspectedTableCount: 0,
  warnings: [] as string[],
}));

// `getDBSchemaRaw` is overridable per-test for the create_from_db happy
// path. Default is an empty Map (the introspection-found-nothing case).
const mockGetDBSchemaRaw: Mock<(connectionId?: string) => Promise<Map<string, { table: string; columns: Map<string, string> }>>> =
  mock(async () => new Map());

void mock.module("@atlas/api/lib/semantic/diff", () => ({
  runDiff: mockRunDiff,
  // #2459: matches the admin route's new import alongside runDiff.
  runDriftDiff: mockRunDriftDiff,
  mapSQLType: (t: string) => t,
  parseEntityYAML: () => ({ table: "", columns: new Map(), foreignKeys: new Set() }),
  computeDiff: () => ({ newTables: [], removedTables: [], tableDiffs: [], unchangedCount: 0 }),
  getDBSchema: async () => new Map(),
  getDBSchemaRaw: mockGetDBSchemaRaw,
  getYAMLSnapshots: () => ({ snapshots: new Map(), warnings: [] }),
}));

void mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mock(() => Promise.resolve(null)),
  addMessage: mock(() => {}),
  persistAssistantSteps: mock(() => {}),
  // F-77 step-cap helpers — chat.ts imports both via @atlas/api/lib/conversations.
  reserveConversationBudget: mock(() => Promise.resolve({ status: 'ok' as const, totalStepsBefore: 0 })),
  settleConversationSteps: mock(() => {}),
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
  resolveGroupForConnection: mock(() => Promise.resolve(null)),
  verifyGroupBelongsToOrg: mock(() => Promise.resolve("ok")),
  // #4351 — the single conversation-scope write path. No-op success by
  // default; tests that exercise a picker toggle override locally.
  updateConversationScope: mock(() => Promise.resolve({ ok: true as const })),
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
  if (priorSemanticRoot === undefined) delete process.env.ATLAS_SEMANTIC_ROOT;
  else process.env.ATLAS_SEMANTIC_ROOT = priorSemanticRoot;
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
    mockInternalQuery.mockReset();
    mockInternalQuery.mockResolvedValue([]);
    mockGetWorkspaceDetails.mockReset();
    mockGetWorkspaceDetails.mockResolvedValue(null);
    setAdmin();
  });

  // Reset sticky `mockImplementation` so later describes (e.g.
  // /admin/connections) don't inherit org-overlay rows from our tests.
  afterEach(() => {
    mockInternalQuery.mockReset();
    mockInternalQuery.mockResolvedValue([]);
  });

  it("returns workspace-scoped overview shape (#2489)", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    // Org-scoped connection count via `getVisibleConnectionIds`. Without
    // an org context the helper falls through to runtime `default` (which
    // exists in the test mock), so we still see 1.
    expect(body.connections).toBe(1);
    // 3 disk entities (companies + warehouse/orders + audit_log) via
    // `listAdminEntities`. `audit_log` is the #2891 fixture whose YAML
    // `name:` deliberately differs from its file stem.
    expect(body.entities).toBe(3);
    expect(body.plugins).toBe(1);
    // Deployment-scaffold tiles (metrics, glossaryTerms, pluginHealth)
    // moved to /api/v1/platform/overview per #2489 — assert they're gone
    // so the split doesn't accidentally regress.
    expect(body.metrics).toBeUndefined();
    expect(body.glossaryTerms).toBeUndefined();
    expect(body.pluginHealth).toBeUndefined();
  });

  it("connection count is org-scoped — leaks no rows when query returns []", async () => {
    setOrgScopedAdmin("org-test-1");
    // Internal DB returns no connection rows for this org → helper falls
    // back to runtime `default` (#2483 SaaS-gate is off here since
    // deployMode isn't 'saas').
    mockInternalQuery.mockResolvedValue([]);

    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.connections).toBe(1);
  });

  it("populates queriesLast24h and workspace block when an org context is present", async () => {
    setOrgScopedAdmin("org-test-1");
    // `getVisibleConnectionIds` runs against `internalQuery` (connections
    // table) and the 24h tile runs against audit_log. `getWorkspaceDetails`
    // is mocked separately because it doesn't go through internalQuery
    // here — the lib export is shadowed by the module mock above.
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM audit_log")) return [{ count: 42 }];
      return [];
    });
    mockGetWorkspaceDetails.mockResolvedValue({
      id: "org-test-1",
      name: "Acme Co",
      slug: "acme",
      workspace_status: "active",
      plan_tier: "trial",
      byot: false,
      stripe_customer_id: null,
      trial_ends_at: "2026-06-01T00:00:00Z",
      suspended_at: null,
      deleted_at: null,
      region: "us-east",
      region_assigned_at: null,
      createdAt: "2026-01-01T00:00:00Z",
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.queriesLast24h).toBe(42);
    const workspace = body.workspace as Record<string, unknown> | null;
    expect(workspace?.name).toBe("Acme Co");
    expect(workspace?.planTier).toBe("trial");
    expect(workspace?.trialEndsAt).toBe("2026-06-01T00:00:00Z");
    // #3434 — effective end mirrors trial_ends_at when set; trialDays from
    // the plan definition so UI copy never hardcodes the number.
    expect(workspace?.trialEndsAtEffective).toBe("2026-06-01T00:00:00.000Z");
    expect(workspace?.trialDays).toBe(14);
  });

  it("computes the effective trial end from createdAt when trial_ends_at is NULL (#3434)", async () => {
    setOrgScopedAdmin("org-test-1");
    mockGetWorkspaceDetails.mockResolvedValue({
      id: "org-test-1",
      name: "Acme Co",
      slug: "acme",
      workspace_status: "active",
      plan_tier: "trial",
      byot: false,
      stripe_customer_id: null,
      trial_ends_at: null,
      suspended_at: null,
      deleted_at: null,
      region: null,
      region_assigned_at: null,
      createdAt: "2026-01-01T00:00:00Z",
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const workspace = body.workspace as Record<string, unknown> | null;
    // createdAt + TRIAL_DAYS (14) — the same fallback enforcement uses.
    expect(workspace?.trialEndsAt).toBeNull();
    expect(workspace?.trialEndsAtEffective).toBe("2026-01-15T00:00:00.000Z");
  });

  it("does not surface poolWarnings — deployment-wide leak guard (#2489)", async () => {
    // `poolWarnings` exposes capacity config (maxOrgs × maxConns × ...) that
    // workspace admins shouldn't see. It now lives only on
    // `/api/v1/platform/overview`. A regression that re-introduced it here
    // would silently expose deployment shape to every workspace admin.
    mockGetPoolWarnings.mockReturnValue([
      "Org pool capacity (50 orgs × 5 conns × 1 datasources = 250 slots) exceeds maxTotalConnections (100) by 2.5×.",
    ]);
    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.poolWarnings).toBeUndefined();
  });

  it("falls back to queriesLast24h=null when the audit_log query throws", async () => {
    // The handler catches internalQuery failures and emits a log.warn —
    // the tile renders "—". Without this test, a future refactor letting
    // the error bubble could 500 the page, or — worse — silently default
    // to 0 ("no queries today") when the audit DB is wedged.
    setOrgScopedAdmin("org-test-1");
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM audit_log")) throw new Error("audit DB down");
      return [];
    });
    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.queriesLast24h).toBeNull();
    // Other fields still populated — the failure is scoped to the tile.
    expect(typeof body.connections).toBe("number");
    expect(typeof body.entities).toBe("number");
  });

  it("counts __global__ overlay connection rows in the org-scoped tile", async () => {
    // Onboarded SaaS workspaces inherit demo/shared connections via the
    // `__global__` overlay in `getVisibleConnectionIds`. The tile must
    // count them, not just per-org rows. Dropping the UNION branch would
    // silently report `connections: 0` for every onboarded workspace.
    setOrgScopedAdmin("org-test-1");
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM workspace_plugins")) {
        return [{ id: "__demo__", install_id: "__demo__" }];
      }
      return [];
    });
    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.connections).toBe(1);
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
    // Count covers all three fixtures (companies, orders, audit_log).
    expect(body.entities.length).toBe(3);

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

    // #2891: list response must carry both the storage `name` (file
    // stem) and the YAML's `displayName`. The frontend routes URLs by
    // `name` (so detail lookup matches the DB / disk key), but
    // renders the file tree off `displayName`.
    const auditLog = body.entities.find((e) => e.table === "audit_log");
    expect(auditLog).toBeDefined();
    expect(auditLog!.name).toBe("audit_log");
    expect(auditLog!.displayName).toBe("AuditLog");
  });
});

// Mode-fan-out for the unified list route. The orchestrator picks
// `listEntitiesWithOverlay` in developer mode and `listEntityRows(..., "published")`
// otherwise — without these tests, swapping the branch in admin-source.ts
// would still pass CI.
describe("GET /api/v1/admin/semantic/entities — DB branch + mode fan-out", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    mockListEntitiesAdmin.mockReset();
    mockListEntitiesWithOverlay.mockReset();
    mockListEntitiesAdmin.mockResolvedValue([]);
    mockListEntitiesWithOverlay.mockResolvedValue([]);
    mockHasInternalDB = true;
  });

  it("published mode (default) calls listEntityRows with status='published'", async () => {
    setOrgScopedAdmin("org-saas-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities"));
    expect(res.status).toBe(200);
    expect(mockListEntitiesAdmin).toHaveBeenCalledWith("org-saas-1", "entity", "published");
    expect(mockListEntitiesWithOverlay).not.toHaveBeenCalled();
  });

  it("developer mode (atlas-mode=developer cookie) calls listEntitiesWithOverlay", async () => {
    setOrgScopedAdmin("org-saas-1");
    const req = new Request("http://localhost/api/v1/admin/semantic/entities", {
      headers: {
        Authorization: "Bearer test-key",
        Cookie: "atlas-mode=developer",
      },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(mockListEntitiesWithOverlay).toHaveBeenCalledWith("org-saas-1", "entity");
    expect(mockListEntitiesAdmin).not.toHaveBeenCalled();
  });

  it("includeDrafts=true forces the developer overlay even in published mode (#4613 — improve launcher)", async () => {
    setOrgScopedAdmin("org-saas-1");
    // No developer cookie ⇒ the global mode is published. The Semantic
    // Improvement launcher opts into the draft layer via includeDrafts so
    // draft-only entities aren't hidden.
    const res = await app.fetch(
      adminRequest("/api/v1/admin/semantic/entities?includeDrafts=true"),
    );
    expect(res.status).toBe(200);
    expect(mockListEntitiesWithOverlay).toHaveBeenCalledWith("org-saas-1", "entity");
    expect(mockListEntitiesAdmin).not.toHaveBeenCalled();
  });

  it("DB-row's status reaches the response (draft shadows disk on name collision)", async () => {
    setOrgScopedAdmin("org-saas-1");
    mockListEntitiesWithOverlay.mockResolvedValue([
      {
        id: "e1", org_id: "org-saas-1", entity_type: "entity", name: "companies",
        yaml_content: "table: companies\ndescription: From DB draft\n",
        connection_id: null, status: "draft",
        created_at: "2026-01-01", updated_at: "2026-01-02",
      },
    ]);
    const req = new Request("http://localhost/api/v1/admin/semantic/entities", {
      headers: { Authorization: "Bearer test-key", Cookie: "atlas-mode=developer" },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entities: Array<Record<string, unknown>> };
    const companies = body.entities.find((e) => e.table === "companies");
    expect(companies?.status).toBe("draft");
    expect(companies?.sourceKind).toBe("db");
    expect(companies?.description).toBe("From DB draft");
  });

  it("no orgId → skips DB and reads disk only", async () => {
    setAdmin(); // no org
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities"));
    expect(res.status).toBe(200);
    expect(mockListEntitiesAdmin).not.toHaveBeenCalled();
    expect(mockListEntitiesWithOverlay).not.toHaveBeenCalled();
  });

  it("no internal DB → skips DB even with orgId", async () => {
    setOrgScopedAdmin("org-saas-1");
    mockHasInternalDB = false;
    try {
      const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities"));
      expect(res.status).toBe(200);
      expect(mockListEntitiesAdmin).not.toHaveBeenCalled();
      expect(mockListEntitiesWithOverlay).not.toHaveBeenCalled();
    } finally {
      mockHasInternalDB = true;
    }
  });

  it("DB query failure returns 500 with requestId (does not silently degrade to disk)", async () => {
    setOrgScopedAdmin("org-saas-1");
    mockListEntitiesAdmin.mockRejectedValue(new Error("pool exhausted"));
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId?: string };
    expect(body.error).toBe("internal_error");
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId).not.toBe("");
  });

  it("developer-mode DB failure also returns 500 with requestId (symmetry with published-mode)", async () => {
    // Mirror of the published-mode throw test above — the developer-mode
    // path uses `listEntitiesWithOverlay`, a separate code path. Without
    // this guard, a future refactor that masked overlay errors with
    // `.catch(() => [])` would silently flip the developer-mode list to
    // an empty workspace under DB outage while the published-mode test
    // above still passed.
    setOrgScopedAdmin("org-saas-1");
    mockListEntitiesWithOverlay.mockRejectedValue(new Error("overlay query failed"));
    const req = new Request("http://localhost/api/v1/admin/semantic/entities", {
      headers: { Authorization: "Bearer test-key", Cookie: "atlas-mode=developer" },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId?: string };
    expect(body.error).toBe("internal_error");
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId).not.toBe("");
  });

  it("orphan disk YAMLs under .orgs/<orgId>/ do not leak into the list when DB is present", async () => {
    // Regression guard for the prod symptom — every internal Atlas
    // table appeared twice in the file tree: once as a stale lowercase
    // disk YAML (`apikey.yml`, `audit_log.yml`, …) and once as a group-
    // scoped DB row with a PascalCase display name (`ApiKey`,
    // `AuditLog`, …). The merge dedup-key `(name, group)` didn't
    // collide across either axis, so both used to survive.
    //
    // With the DB-only-when-DB-present orchestration the disk read is
    // skipped entirely. Drop a disk fixture for this org and assert
    // the listing returns only the DB row, not the disk YAML.
    const orgRoot = path.join(tmpRoot, ".orgs", "org-saas-orphan", "entities");
    fs.mkdirSync(orgRoot, { recursive: true });
    fs.writeFileSync(
      path.join(orgRoot, "apikey.yml"),
      `table: apikey
description: legacy disk orphan — must not appear
`,
    );

    mockListEntitiesAdmin.mockResolvedValue([
      {
        id: "db-1",
        org_id: "org-saas-orphan",
        entity_type: "entity",
        name: "ApiKey",
        yaml_content: "table: apikey\nname: ApiKey\ndescription: live DB row\n",
        connection_id: null,
        connection_group_id: "g_prod",
        status: "published",
        created_at: "2026-01-01",
        updated_at: "2026-05-16T19:39:07.279Z",
      },
    ]);

    setOrgScopedAdmin("org-saas-orphan");

    try {
      const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entities: Array<Record<string, unknown>> };
      expect(body.entities.length).toBe(1);
      expect(body.entities[0]?.name).toBe("ApiKey");
      expect(body.entities[0]?.sourceKind).toBe("db");
      // The disk entry's lowercase `name` must NOT appear — that's the
      // bug this test exists to prevent.
      const lowercase = body.entities.find((e) => e.name === "apikey");
      expect(lowercase).toBeUndefined();
    } finally {
      fs.rmSync(path.join(tmpRoot, ".orgs", "org-saas-orphan"), { recursive: true, force: true });
    }
  });
});

// #2459 — drift attachment via `?connection=<id>`. Covers the four
// response shapes of the route: no `?connection` (legacy), unknown
// connection (noIntrospectedTables true), `runDriftDiff` failure (warning
// string + entities still rendered), and success (envelope from
// `attachDrift`). Each branch is exercised once — `attachDrift` itself
// has pure-function coverage in `semantic-diff.test.ts`.
describe("GET /api/v1/admin/semantic/entities — drift via ?connection (#2459)", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setAdmin();
    mockConnectionsHas.mockReset();
    mockConnectionsHas.mockReturnValue(true);
    mockRunDriftDiff.mockReset();
    mockRunDriftDiff.mockResolvedValue({
      diff: { newTables: [], removedTables: [], tableDiffs: [], unchangedCount: 0 },
      introspectedTableCount: 0,
      warnings: [] as string[],
    });
  });

  it("legacy path: no ?connection → no drift field, no noIntrospectedTables flag", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entities: Record<string, unknown>[]; noIntrospectedTables?: boolean };
    expect(body.noIntrospectedTables).toBeUndefined();
    expect(body.entities[0]?.drift).toBeUndefined();
    expect(mockRunDriftDiff).not.toHaveBeenCalled();
  });

  it("unknown connection → 200 with all drift null + noIntrospectedTables true + requestId", async () => {
    // Critical contract: don't 500 the list when an admin lands before any
    // connection is registered. The file tree must still render.
    mockConnectionsHas.mockReturnValue(false);
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities?connection=ghost"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entities: Array<{ drift: unknown }>;
      noIntrospectedTables: boolean;
      requestId: string;
    };
    expect(body.noIntrospectedTables).toBe(true);
    expect(body.entities.length).toBeGreaterThan(0);
    expect(body.entities.every((e) => e.drift === null)).toBe(true);
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);
    expect(mockRunDriftDiff).not.toHaveBeenCalled();
  });

  it("drift success → entities carry drift state from attachDrift envelope", async () => {
    mockRunDriftDiff.mockResolvedValueOnce({
      diff: {
        newTables: [],
        removedTables: ["companies"],
        tableDiffs: [{
          table: "orders",
          addedColumns: [{ name: "shipping_zip", type: "string" }],
          removedColumns: [],
          typeChanges: [{ name: "status", yamlType: "string", dbType: "number" }],
        }],
        unchangedCount: 0,
      },
      introspectedTableCount: 5,
      warnings: [] as string[],
    });
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities?connection=default"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entities: Array<{ table: string; drift: { state: string; changeCount?: number } | null }>;
      noIntrospectedTables: boolean;
    };
    expect(body.noIntrospectedTables).toBe(false);
    const byTable = Object.fromEntries(body.entities.map((e) => [e.table, e.drift]));
    expect(byTable.companies).toEqual({ state: "removed" });
    expect(byTable.orders).toEqual({ state: "changed", changeCount: 2 });
  });

  it("zero introspected tables → flag flips true even with populated diff", async () => {
    // Dogfood regression guard: if introspectedTableCount is 0, attachDrift
    // must short-circuit to all-null drift regardless of diff contents.
    mockRunDriftDiff.mockResolvedValueOnce({
      diff: {
        newTables: [],
        removedTables: ["companies", "orders"],
        tableDiffs: [],
        unchangedCount: 0,
      },
      introspectedTableCount: 0,
      warnings: [] as string[],
    });
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities?connection=default"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entities: Array<{ drift: unknown }>;
      noIntrospectedTables: boolean;
    };
    expect(body.noIntrospectedTables).toBe(true);
    expect(body.entities.every((e) => e.drift === null)).toBe(true);
  });

  it("drift failure → 200 with generic warning + requestId, NOT raw err.message", async () => {
    // Driver errors can leak host / schema / role names. The user-visible
    // warning must be generic; the requestId is the support handoff.
    mockRunDriftDiff.mockRejectedValueOnce(
      new Error("connection refused at internal-prod-host.us-east-1:5432 for role atlas_admin"),
    );
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities?connection=default"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entities: Array<{ drift: unknown }>;
      warnings: string[];
      requestId: string;
    };
    expect(body.entities.every((e) => e.drift === null)).toBe(true);
    expect(body.warnings).toBeDefined();
    const driftWarning = body.warnings.find((w) => w.includes("Drift check failed"));
    expect(driftWarning).toBeDefined();
    expect(driftWarning).not.toContain("internal-prod-host");
    expect(driftWarning).not.toContain("atlas_admin");
    expect(driftWarning).toContain(body.requestId);
  });

  it("rejects empty ?connection= via .min(1)", async () => {
    // `z.string().min(1)` is the express-intent guard — empty string isn't
    // a valid connection id. Hono's Zod validator returns 422 for the
    // schema mismatch (not 400) — the point is "rejected before the
    // handler runs", not a particular status code.
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities?connection="));
    expect(res.status).toBe(422);
    expect(mockRunDriftDiff).not.toHaveBeenCalled();
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

  // #2891: every storage `name` returned by the list endpoint must
  // resolve to a 200 on the detail endpoint. Pre-fix the list was
  // returning the YAML's display `name:` while the detail handler keyed
  // on the file stem / DB row `name`, so the click-to-load path 404'd
  // for any entity whose YAML name differed from its filename. Iterates
  // every row instead of pinning a single fixture so a future
  // entity that drifts on display vs. storage trips this immediately.
  it("every name from the list endpoint resolves on the detail endpoint (#2891)", async () => {
    const listRes = await app.fetch(adminRequest("/api/v1/admin/semantic/entities"));
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { entities: Array<Record<string, unknown>> };
    expect(listBody.entities.length).toBeGreaterThan(0);

    for (const entry of listBody.entities) {
      const name = entry.name;
      expect(typeof name).toBe("string");
      const detailRes = await app.fetch(
        adminRequest(`/api/v1/admin/semantic/entities/${encodeURIComponent(String(name))}`),
      );
      expect(detailRes.status).toBe(200);
    }
  });
});

// Coverage for the org-scoped + DB-overlay fallback path added to
// `getEntityRoute`. The headline regression mode is "every SaaS detail click
// returns 404": the disk endpoint had no awareness of org-scoped overlays
// or DB-backed user-created entities. These tests pin both branches so a
// refactor of the resolve / fallback logic can't silently re-introduce it.
describe("GET /api/v1/admin/semantic/entities/:name — org-scoped + DB overlay", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    mockGetEntityAdmin.mockReset();
    mockHasInternalDB = true;
  });

  it("resolves an entity from the DB overlay when the disk file is missing", async () => {
    setOrgScopedAdmin("org-saas-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "ent-1",
      org_id: "org-saas-1",
      entity_type: "entity",
      name: "apikey",
      yaml_content: "table: api_keys\ndescription: User-issued API keys\ndimensions:\n  id:\n    type: integer\n",
      connection_id: null,
      status: "published",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/apikey"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { entity: Record<string, unknown> };
    expect(body.entity.table).toBe("api_keys");
    expect(body.entity.dimensions).toBeDefined();

    // Confirm the DB lookup was invoked with the org-scoped key, not the
    // base-root probe. Catches a silent revert of the fallback branch.
    // The 4th arg (`connectionGroupId`) is undefined when the request
    // omits the disambiguation query param (#2412).
    // 5th arg is the content-mode gate (#2481): admin route resolves
    // `atlasMode` from middleware context; in the test default the cookie
    // is not set so resolveMode produces "published".
    expect(mockGetEntityAdmin).toHaveBeenCalledWith("org-saas-1", "entity", "apikey", undefined, "published");
  });

  it("returns 404 with requestId when both disk and DB miss", async () => {
    setOrgScopedAdmin("org-saas-1");
    mockGetEntityAdmin.mockResolvedValue(null);

    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/missing"));
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string; requestId?: string };
    expect(body.error).toBe("not_found");
    // The 404 must include a requestId for log correlation per project rules.
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId).not.toBe("");
  });

  it("returns 500 with requestId when DB row contains malformed YAML", async () => {
    setOrgScopedAdmin("org-saas-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "ent-2",
      org_id: "org-saas-1",
      entity_type: "entity",
      name: "broken",
      // Unbalanced quote / colon — js-yaml throws on parse.
      yaml_content: 'table: "broken\ndimensions:\n  id: {{not yaml',
      connection_id: null,
      status: "published",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/broken"));
    expect(res.status).toBe(500);

    const body = (await res.json()) as { error: string; message: string; requestId?: string };
    expect(body.error).toBe("internal_error");
    expect(body.message).toContain("broken");
    expect(typeof body.requestId).toBe("string");
  });

  it("returns 500 when DB-backed YAML parses to a non-object (null/scalar/array)", async () => {
    // js-yaml happily returns null / scalars / arrays for technically-valid
    // YAML that isn't an entity definition. The frontend `<EntityDetail>`
    // would then render garbage instead of failing — the shape guard turns
    // that into an actionable 500.
    setOrgScopedAdmin("org-saas-1");
    for (const yamlContent of ["", "just a string", "- one\n- two\n", "null\n"]) {
      mockGetEntityAdmin.mockResolvedValueOnce({
        id: "ent-3",
        org_id: "org-saas-1",
        entity_type: "entity",
        name: "bad-shape",
        yaml_content: yamlContent,
        connection_id: null,
        status: "published",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/bad-shape"));
      expect(res.status).toBe(500);

      const body = (await res.json()) as { error: string; message: string; requestId?: string };
      expect(body.error).toBe("internal_error");
      expect(body.message).toContain("malformed");
      expect(typeof body.requestId).toBe("string");
    }
  });

  it("scopes the DB lookup when ?connectionGroupId=<group> is passed (#2412)", async () => {
    // Multi-group orgs disambiguate via the query param. The route must
    // forward the value to `getEntity` so the SQL filters to that group.
    setOrgScopedAdmin("org-saas-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "ent-multi",
      org_id: "org-saas-1",
      entity_type: "entity",
      name: "users",
      yaml_content: "table: users\ndescription: prod US\n",
      connection_group_id: "g_prod_us",
      status: "published",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/semantic/entities/users?connectionGroupId=g_prod_us"),
    );
    expect(res.status).toBe(200);
    expect(mockGetEntityAdmin).toHaveBeenCalledWith("org-saas-1", "entity", "users", "g_prod_us", "published");
  });

  it("returns 409 with candidate groups when the name is ambiguous (#2412)", async () => {
    // Without `?connectionGroupId`, the underlying `getEntity` throws
    // `AmbiguousEntityError` when multiple groups carry the entity. The
    // route translates that into a 409 with `groups` so the UI can render
    // a picker instead of silently showing whichever row Postgres saw first.
    setOrgScopedAdmin("org-saas-1");
    mockGetEntityAdmin.mockImplementationOnce(async () => {
      const { AmbiguousEntityError } = await import("@atlas/api/lib/effect/errors");
      throw new AmbiguousEntityError({
        message: 'Entity "users" exists in 2 environments. Pass connectionGroupId to disambiguate.',
        entityName: "users",
        entityType: "entity",
        groups: ["g_prod_eu", "g_prod_us"],
      });
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/users"));
    expect(res.status).toBe(409);

    const body = (await res.json()) as {
      error: string;
      message: string;
      groups: Array<string | null>;
      requestId: string;
    };
    expect(body.error).toBe("entity_ambiguous");
    expect(body.groups).toEqual(["g_prod_eu", "g_prod_us"]);
    expect(typeof body.requestId).toBe("string");
  });

  it("does not consult the DB overlay when no active org is present", async () => {
    // Self-hosted single-tenant — no orgId. The DB lookup must be skipped
    // entirely so we don't leak rows from `__global__` or another tenant
    // into a request that has no org context.
    setAdmin();
    mockGetEntityAdmin.mockReset();

    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/nonexistent"));
    expect(res.status).toBe(404);
    expect(mockGetEntityAdmin).not.toHaveBeenCalled();
  });

  it("does not consult the DB overlay when internal DB is disabled", async () => {
    setOrgScopedAdmin("org-saas-1");
    mockHasInternalDB = false;
    mockGetEntityAdmin.mockReset();

    try {
      const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/nonexistent"));
      expect(res.status).toBe(404);
      expect(mockGetEntityAdmin).not.toHaveBeenCalled();
    } finally {
      mockHasInternalDB = true;
    }
  });

  it("bypasses the disk mirror entirely when DB is available — orphan YAMLs do not leak", async () => {
    // Architectural rule: when `hasInternalDB()` is true, the admin API
    // reads DB only. A stale disk YAML at `.orgs/<orgId>/entities/<name>.yml`
    // with no matching DB row must NOT be visible to the admin route —
    // surfacing it produced ghost duplicates of legitimate DB-backed
    // entities (e.g. legacy lowercase `apikey.yml` alongside a group-
    // scoped `ApiKey` DB row). The disk fixture below is intentionally
    // valid YAML for an entity called `scoped`; a disk-first regression
    // would return 200 + that body. Asserting 404 plus the absence of a
    // disk-derived body is sufficient — no impl-coupled "was DB called?"
    // check needed.
    const orgRoot = path.join(tmpRoot, ".orgs", "org-saas-fs", "entities");
    fs.mkdirSync(orgRoot, { recursive: true });
    fs.writeFileSync(
      path.join(orgRoot, "scoped.yml"),
      `table: scoped
description: From the org overlay
dimensions:
  id:
    type: integer
`,
    );

    setOrgScopedAdmin("org-saas-fs");
    mockGetEntityAdmin.mockReset();
    mockGetEntityAdmin.mockResolvedValue(null);

    try {
      const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/scoped"));
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.entity).toBeUndefined();
    } finally {
      fs.rmSync(path.join(tmpRoot, ".orgs", "org-saas-fs"), { recursive: true, force: true });
    }
  });

  it("falls back to .orgs/<orgId>/ disk when no internal DB is present (pure-YAML self-hosted)", async () => {
    // The disk path is still the source for self-hosted deployments
    // running without an internal DB. With `hasInternalDB()` false, the
    // route resolves the same per-org overlay and returns the YAML
    // content. The 200 + disk-content body is sufficient evidence — the
    // mock DB getter is reset so any spurious call would surface as an
    // empty response, but we don't need to assert that explicitly.
    const orgRoot = path.join(tmpRoot, ".orgs", "org-yaml-only", "entities");
    fs.mkdirSync(orgRoot, { recursive: true });
    fs.writeFileSync(
      path.join(orgRoot, "scoped.yml"),
      `table: scoped
description: From the org overlay
dimensions:
  id:
    type: integer
`,
    );

    setOrgScopedAdmin("org-yaml-only");
    mockGetEntityAdmin.mockReset();
    mockHasInternalDB = false;

    try {
      const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/scoped"));
      expect(res.status).toBe(200);

      const body = (await res.json()) as { entity: Record<string, unknown> };
      expect(body.entity.table).toBe("scoped");
      expect(body.entity.description).toBe("From the org overlay");
    } finally {
      mockHasInternalDB = true;
      fs.rmSync(path.join(tmpRoot, ".orgs", "org-yaml-only"), { recursive: true, force: true });
    }
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

  it("discovers groups/<group>/metrics (attributed to <group>) and keeps legacy <source>/metrics (#3240)", async () => {
    const groupDir = path.join(tmpRoot, "groups", "analytics", "metrics");
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, "sessions.yml"),
      ["id: sessions_count", "sql: SELECT COUNT(*) FROM sessions"].join("\n"),
    );
    // Legacy <source>/metrics must still resolve to <source> (unchanged).
    const legacyDir = path.join(tmpRoot, "warehouse", "metrics");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "events.yml"),
      ["id: events_count", "sql: SELECT COUNT(*) FROM events"].join("\n"),
    );
    try {
      const res = await app.fetch(adminRequest("/api/v1/admin/semantic/metrics"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { metrics: Array<{ source: string; file: string }> };
      expect(body.metrics.find((m) => m.file === "sessions")?.source).toBe("analytics");
      expect(body.metrics.find((m) => m.file === "events")?.source).toBe("warehouse");
      // The reserved groups/ container is never itself a source.
      expect(body.metrics.some((m) => m.source === "groups")).toBe(false);
    } finally {
      fs.rmSync(path.join(tmpRoot, "groups"), { recursive: true, force: true });
      fs.rmSync(path.join(tmpRoot, "warehouse", "metrics"), { recursive: true, force: true });
    }
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

  it("discovers groups/<group>/glossary.yml (attributed to <group>) and keeps legacy <source>/glossary.yml (#3240)", async () => {
    const groupDir = path.join(tmpRoot, "groups", "analytics");
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, "glossary.yml"),
      ["terms:", "  mau:", "    status: defined", "    definition: Monthly active users."].join("\n"),
    );
    // Legacy <source>/glossary.yml must still resolve to <source> (unchanged).
    fs.writeFileSync(
      path.join(tmpRoot, "warehouse", "glossary.yml"),
      ["terms:", "  cohort:", "    status: defined", "    definition: Signup-month group."].join("\n"),
    );
    try {
      const res = await app.fetch(adminRequest("/api/v1/admin/semantic/glossary"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { glossary: Array<{ source: string }> };
      expect(body.glossary.some((g) => g.source === "analytics")).toBe(true);
      expect(body.glossary.some((g) => g.source === "warehouse")).toBe(true);
      expect(body.glossary.some((g) => g.source === "groups")).toBe(false);
    } finally {
      fs.rmSync(path.join(tmpRoot, "groups"), { recursive: true, force: true });
      fs.rmSync(path.join(tmpRoot, "warehouse", "glossary.yml"), { force: true });
    }
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

describe("GET /api/v1/admin/semantic/raw/*", () => {
  // Same-origin success path — DB-backed deployments now serve `yaml_content`
  // from the org's `semantic_entities` row when one exists, with the disk root
  // as a fallback only for self-hosted (no internal DB or no active org).
  // Pre-fix, the route always read from disk root and 404'd for org-scoped
  // entities that lived under `semantic/.orgs/<orgId>/entities/`.
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    mockGetEntityAdmin.mockReset();
    mockGetEntityAdmin.mockResolvedValue(null);
  });

  it("falls back to disk for self-hosted (no internal DB)", async () => {
    mockHasInternalDB = false;
    try {
      setAdmin();
      const res = await app.fetch(adminRequest("/api/v1/admin/semantic/raw/entities/companies.yml"));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/plain");
      const body = await res.text();
      expect(body).toContain("table: companies");
    } finally {
      mockHasInternalDB = true;
    }
  });

  it("falls back to disk when authenticated user has no active org", async () => {
    // Internal DB is configured but the caller lacks an org context → can't
    // resolve a row anyway, so disk is the only honest source.
    setAdmin(); // user has no activeOrganizationId
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/raw/glossary.yml"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("ARR");
  });

  it("serves yaml_content from DB when org + internal DB are present", async () => {
    setOrgScopedAdmin();
    mockGetEntityAdmin.mockResolvedValue({
      id: "1",
      org_id: "org-test-1",
      entity_type: "entity",
      name: "companies",
      yaml_content: "table: companies\n# from DB\n",
      connection_group_id: null,
      status: "published",
      created_at: new Date(),
      updated_at: new Date(),
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/raw/entities/companies.yml"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toBe("table: companies\n# from DB\n");
    // Critical: must be the DB content, NOT the on-disk fixture body, so a
    // disk/DB divergence after admin edits shows the canonical version.
    expect(body).not.toContain("All company records");
    // Route must forward orgId + type + connectionGroupId + mode unchanged.
    expect(mockGetEntityAdmin).toHaveBeenCalledWith(
      "org-test-1",
      "entity",
      "companies",
      undefined,
      "published",
    );
  });

  it("returns 404 (not disk fallback) when DB-backed lookup misses for an entity", async () => {
    // Architectural rule: when hasInternalDB() + orgId, DB is canonical for
    // entity/metric/glossary. A disk fallthrough here would surface a stale
    // demo YAML for an entity the org doesn't actually own.
    setOrgScopedAdmin();
    mockGetEntityAdmin.mockResolvedValue(null);

    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/raw/entities/companies.yml"));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; requestId: string };
    expect(body.error).toBe("not_found");
    expect(body.requestId).toBeTruthy();
  });

  it("translates AmbiguousEntityError into 409 with candidate groups (#2412)", async () => {
    setOrgScopedAdmin();
    mockGetEntityAdmin.mockImplementationOnce(async () => {
      throw new RealAmbiguousEntityError({
        message: 'Entity "users" exists in 2 environments. Pass connectionGroupId to disambiguate.',
        entityName: "users",
        entityType: "entity",
        groups: ["g_prod_us", "g_prod_eu"],
      });
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/raw/entities/users.yml"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; groups: string[] };
    expect(body.error).toBe("entity_ambiguous");
    expect(body.groups).toEqual(["g_prod_us", "g_prod_eu"]);
  });

  it("forwards ?connectionGroupId=<group> to the DB lookup", async () => {
    setOrgScopedAdmin();
    mockGetEntityAdmin.mockResolvedValue({
      id: "1",
      org_id: "org-test-1",
      entity_type: "entity",
      name: "users",
      yaml_content: "table: users\n",
      connection_group_id: "g_prod_us",
      status: "published",
      created_at: new Date(),
      updated_at: new Date(),
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/semantic/raw/entities/users.yml?connectionGroupId=g_prod_us"),
    );
    expect(res.status).toBe(200);
    expect(mockGetEntityAdmin).toHaveBeenCalledWith(
      "org-test-1",
      "entity",
      "users",
      "g_prod_us",
      "published",
    );
  });

  it("falls back to disk for catalog.yml even when DB-backed (catalog isn't mirrored to DB)", async () => {
    setOrgScopedAdmin();
    mockGetEntityAdmin.mockResolvedValue(null);
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/raw/catalog.yml"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Test Catalog");
  });

  it("rejects path traversal probes with 400", async () => {
    setAdmin();
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/raw/entities/..%2Fpasswd.yml"));
    expect([400, 404]).toContain(res.status);
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
    // 3 entities: companies (3 cols) + orders (2 cols) + audit_log (1 col) = 6 total columns
    expect(body.totalEntities).toBe(3);
    expect(body.totalColumns).toBe(6);
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

  it("returns connection detail for the runtime-registered default", async () => {
    // Visibility lookup returns no workspace-owned installs so the runtime-
    // registered `default` falls through to the visible set. Detail SELECT
    // (post-#2744 `SELECT wp.config, pc.config_schema, ...`) returns
    // nothing for `default` (it isn't in workspace_plugins) — the response
    // shape's `managed` flips to false in that case.
    mockInternalQuery.mockImplementation((sql: string) => {
      if (
        typeof sql === "string" &&
        sql.includes("FROM workspace_plugins wp") &&
        sql.includes("DISTINCT wp.install_id")
      ) {
        return Promise.resolve([]);
      }
      // Detail JOIN — no row for the runtime-registered `default`.
      return Promise.resolve([]);
    });
    const res = await app.fetch(adminRequest("/api/v1/admin/connections/default"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe("default");
    // `default` isn't admin-managed (no workspace_plugins row) — the
    // detail JOIN returned 0 rows, so `managed: false`.
    expect(body.managed).toBe(false);
  });

  it("returns 200 with managed: true for a workspace install", async () => {
    mockInternalQuery.mockImplementation((sql: string) => {
      if (
        typeof sql === "string" &&
        sql.includes("FROM workspace_plugins wp") &&
        sql.includes("DISTINCT wp.install_id")
      ) {
        return Promise.resolve([{ install_id: "default" }]);
      }
      if (
        typeof sql === "string" &&
        // Lib seam's single-install load (`loadInstalledConnection`, #4194).
        sql.includes("pc.slug AS catalog_slug") &&
        sql.includes("wp.install_id = $2")
      ) {
        return Promise.resolve([
          {
            config: { url: "postgresql://localhost/db" },
            config_schema: [
              { key: "url", type: "string", required: true, secret: true },
              { key: "schema", type: "string" },
            ],
            group_id: null,
          },
        ]);
      }
      return Promise.resolve([]);
    });
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
  // Post-#2744 the route loads existing config from `workspace_plugins`
  // JOIN `plugin_catalog`, the URL lives inside `config` JSONB, and
  // `decryptSecretFields` walks the catalog schema for `secret: true`
  // keys. The rollback contract on a urlChanged + healthCheck failure
  // is unchanged: register(new URL) → healthCheck throws → register
  // (currentUrl) for rollback. Rollback failure escalates to 500 with
  // restart guidance.
  beforeEach(() => {
    mockAuthenticateRequest.mockReset();
    setOrgScopedAdmin();
    mockInternalQuery.mockReset();
    mockInternalQuery.mockResolvedValue([]);
    mockHealthCheck.mockReset();
    mockRegister.mockReset();
    mockRegister.mockImplementation(() => {});
  });

  function stageExistingInstall(): void {
    mockInternalQuery.mockImplementation((sql: string) => {
      if (
        typeof sql === "string" &&
        // Lib seam's single-install load (`loadInstalledConnection`, #4194).
        sql.includes("pc.slug AS catalog_slug") &&
        sql.includes("wp.install_id = $2")
      ) {
        return Promise.resolve([
          {
            catalog_slug: "postgres",
            // Plain URL — the real `decryptSecret` returns un-prefixed values
            // verbatim, so `currentUrl` resolves to this string and is what
            // the rollback re-registers.
            config: { url: "postgresql://old/db" },
            config_schema: [
              { key: "url", type: "string", required: true, secret: true },
              { key: "schema", type: "string" },
              { key: "description", type: "string" },
            ],
            group_id: null,
          },
        ]);
      }
      return Promise.resolve([]);
    });
  }

  it("returns 400 when URL test fails but rollback succeeds", async () => {
    stageExistingInstall();
    mockHealthCheck.mockRejectedValue(new Error("Connection refused"));

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connections/warehouse", "PUT", {
        url: "postgresql://bad/url",
      }),
    );
    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("connection_failed");
    expect(typeof body.message === "string" && !body.message.includes("restart")).toBe(true);
  });

  it("escalates to 500 with restart guidance when rollback fails", async () => {
    stageExistingInstall();
    mockHealthCheck.mockRejectedValue(new Error("Connection refused"));
    // First call (register new URL) succeeds, second call (rollback) throws.
    let callCount = 0;
    mockRegister.mockImplementation(() => {
      callCount++;
      if (callCount >= 2) throw new Error("rollback failed");
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connections/warehouse", "PUT", {
        url: "postgresql://bad/url",
      }),
    );
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

  // #2067 — MCP filter shape
  it("supports actorKind=mcp filter", async () => {
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

    await app.fetch(adminRequest("/api/v1/admin/audit?actorKind=mcp"));

    expect(capturedSql).toContain("a.actor_kind = $2");
    expect(capturedParams).toEqual(["org-test", "mcp"]);
  });

  it("supports clientId filter", async () => {
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

    await app.fetch(adminRequest("/api/v1/admin/audit?clientId=claude-desktop"));

    expect(capturedSql).toContain("a.client_id = $2");
    expect(capturedParams).toEqual(["org-test", "claude-desktop"]);
  });

  it("supports tool filter", async () => {
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

    await app.fetch(adminRequest("/api/v1/admin/audit?tool=runMetric"));

    expect(capturedSql).toContain("a.tool_name = $2");
    expect(capturedParams).toEqual(["org-test", "runMetric"]);
  });

  it("AND-combines actorKind + clientId + tool with existing filters", async () => {
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
      "/api/v1/admin/audit?actorKind=mcp&clientId=claude-desktop&tool=runMetric&success=true",
    ));

    // Org always $1; success applied first (existing param), then the
    // three #2067 filters in declaration order (actorKind → clientId → tool).
    expect(capturedSql).toContain("a.org_id = $1");
    expect(capturedSql).toContain("a.success = $2");
    expect(capturedSql).toContain("a.actor_kind = $3");
    expect(capturedSql).toContain("a.client_id = $4");
    expect(capturedSql).toContain("a.tool_name = $5");
    expect(capturedParams).toEqual(["org-test", true, "mcp", "claude-desktop", "runMetric"]);
  });

  it("preserves cross-workspace isolation when MCP filters are present", async () => {
    // Org-scoped predicate must remain $1 — a malicious caller adding
    // ?actorKind=mcp must not be able to see another org's MCP rows.
    setOrgAdmin("org-other");
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes("ip_allowlist")) return Promise.resolve([]);
      if (!capturedSql && sql.includes("audit_log") && sql.includes("actor_kind")) {
        capturedSql = sql;
        capturedParams = params ?? [];
      }
      if (sql.includes("COUNT(*)")) return Promise.resolve([{ count: "0" }]);
      return Promise.resolve([]);
    });

    await app.fetch(adminRequest("/api/v1/admin/audit?actorKind=mcp"));

    expect(capturedParams[0]).toBe("org-other");
    expect(capturedParams).toContain("mcp");
    // Pin the AND-junction between org_id and the MCP filter so a
    // future regression that uses OR (or drops the AND entirely) is
    // caught at compile-of-SQL time, not at "why is data leaking?"
    expect(capturedSql).toMatch(/a\.org_id = \$1\s+AND\s+/);
  });

  it("returns 400 for an actorKind value outside the canonical set", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/audit?actorKind=robot"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_request");
    expect(body.message).toContain("actorKind");
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

    // #3616 — duration_ms=0 fanout-parent housekeeping rows must not drag
    // the slow-query average down. The fix excludes zero-duration rows from
    // the AVG via a FILTER (rather than a WHERE) so COUNT/MAX still see every
    // row but the average reflects only real execution cost.
    it("excludes zero-duration rows from the AVG (fanout parents / cache misses)", async () => {
      let capturedSlowSql = "";
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        capturedSlowSql = sql;
        return Promise.resolve([
          { query: "SELECT * FROM big_table", avg_duration: "1500", max_duration: "3000", count: "5" },
        ]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/slow"));
      expect(res.status).toBe(200);

      const normalized = capturedSlowSql.replace(/\s+/g, " ");
      // AVG is filtered to non-zero durations…
      expect(normalized).toContain("AVG(duration_ms) FILTER (WHERE duration_ms > 0)");
      // …and the ranking orders by that same filtered average.
      expect(normalized).toContain("ORDER BY AVG(duration_ms) FILTER (WHERE duration_ms > 0) DESC");
      // Every `duration_ms > 0` predicate must live inside a FILTER, never a
      // bare WHERE — a WHERE would also drop the rows from COUNT(*),
      // under-reporting how often the query ran. Asserting the counts match
      // is robust to whitespace/clause-ordering, unlike a single substring.
      const totalPredicates = normalized.match(/duration_ms > 0/g)?.length ?? 0;
      const filteredPredicates = normalized.match(/FILTER \(WHERE duration_ms > 0\)/g)?.length ?? 0;
      expect(totalPredicates).toBeGreaterThan(0);
      expect(filteredPredicates).toBe(totalPredicates);
    });

    // #3616 — response plumbing: the endpoint must map each aggregate column
    // (avg/max/count) to the right wire field and parse the string values the
    // pg driver returns. Distinct numbers (avg≠max≠count) catch a column-swap.
    // NOTE: the FILTER/COALESCE/NULLS-LAST *SQL semantics* (that the average
    // actually excludes zero rows) are verified against real Postgres in
    // `audit-slow-pg.test.ts` — a mocked query layer can't exercise them, so
    // this test deliberately does NOT re-derive the average in JS.
    it("maps avg/max/count aggregate columns onto the response shape", async () => {
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("ip_allowlist")) return Promise.resolve([]);
        if (!sql.includes("AVG(duration_ms)")) return Promise.resolve([]);
        // Postgres returns numeric aggregates as strings; distinct values so a
        // mis-mapping (e.g. avg↔max) would surface as a wrong field.
        return Promise.resolve([
          { query: "SELECT * FROM big_table", avg_duration: "2250", max_duration: "3000", count: "3" },
        ]);
      });

      const res = await app.fetch(adminRequest("/api/v1/admin/audit/analytics/slow"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { queries: { query: string; avgDuration: number; maxDuration: number; count: number }[] };
      expect(body.queries).toHaveLength(1);
      expect(body.queries[0].query).toBe("SELECT * FROM big_table");
      expect(body.queries[0].avgDuration).toBe(2250);
      expect(body.queries[0].maxDuration).toBe(3000);
      expect(body.queries[0].count).toBe(3);
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
    mockInternalQuery.mockReset();
    mockInternalQuery.mockResolvedValue([]);
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
    // Use org-scoped admin so runDiff receives a concrete orgId; this guards
    // the cross-tenant isolation property delivered by #1431 — if the handler
    // ever regresses and stops forwarding `orgId`, this assertion fails.
    setOrgScopedAdmin("org-diff-test");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/diff?connection=default"));
    expect(res.status).toBe(200);
    expect(mockRunDiff).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({
        atlasMode: expect.any(String),
        orgId: "org-diff-test",
      }),
    );
  });

  it("returns 404 for unknown connection", async () => {
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/diff?connection=unknown"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });

  it("auto-resolves to the org's first visible connection when ?connection= is omitted", async () => {
    // Org-scoped admin owns __demo__ (no `default` row). The handler must
    // pick __demo__ from getVisibleConnectionIds rather than fall back to
    // the literal string "default".
    setOrgScopedAdmin("org-saas");
    // #2744 — getVisibleConnectionIds now queries `workspace_plugins`
    // (pillar='datasource') and returns the `install_id` column. The
    // shape the route consumes (a Set<string>) is unchanged.
    mockInternalQuery.mockImplementation((sql: string) => {
      if (typeof sql === "string" && sql.includes("FROM workspace_plugins") && sql.includes("install_id")) {
        return Promise.resolve([{ install_id: "__demo__" }]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/diff"));
    expect(res.status).toBe(200);
    expect(mockRunDiff).toHaveBeenCalledWith(
      "__demo__",
      expect.objectContaining({ orgId: "org-saas" }),
    );
  });

  // Note: the explicit `no_connections` 404 branch (admin.ts) fires when the
  // org has zero visible connections AND `default` isn't registered. The shared
  // connection mock hardcodes `has: () => true`, so the branch isn't reachable
  // through this app.fetch suite without re-stubbing the registry. Covered by
  // unit logic; not duplicated as an integration test here.

  it("returns 500 with sanitized message when runDiff throws", async () => {
    // Raw error from runDiff (e.g., pg detail) must NOT leak in the response
    // body. The requestId is the operator's correlation handle.
    mockRunDiff.mockRejectedValueOnce(new Error("DB unreachable: column users.api_key"));
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/diff"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("internal_error");
    expect(body.message).not.toContain("api_key");
    expect(body.message).not.toContain("DB unreachable");
    expect(body.requestId).toBeTruthy();
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
    user: {
      id: "admin-1",
      mode: "managed",
      label: "admin@test.com",
      role: "admin",
      activeOrganizationId: orgId,
      claims: { twoFactorEnabled: true },
    },
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
    expect(body.error).toBe("bad_request");
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

  it("returns the canonical bad_request 400 when no active organization (#4356)", async () => {
    setAdmin();
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities/users", "PUT", { yamlContent: "table: users" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("bad_request");
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

  it("upserts valid entity (#2177: stages as draft)", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities/users", "PUT", {
      yamlContent: "table: users\ndescription: User accounts",
    }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).ok).toBe(true);
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpsertEntityAdmin).not.toHaveBeenCalled();
  });

  it("rejects invalid entityType", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities/users", "PUT", {
      yamlContent: "table: users",
      entityType: "DROP TABLE",
    }));
    expect(res.status).toBe(400);
  });

  it("returns 422 for yamlContent over the max length bound (#4780 — YAML parse DoS cap)", async () => {
    setOrgAdmin("org-1");
    // Prior tests in this block exercise the draft-upsert path; reset so the
    // "never persisted" assertion below is about THIS request only.
    mockUpsertDraftEntityAdmin.mockReset();
    // An over-cap `yamlContent` is rejected at the request schema BEFORE it ever
    // reaches the js-yaml parser or the draft upsert — the missing byte ceiling
    // that let a 3 MB body persist on staging.
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities/users", "PUT", {
      yamlContent: `table: users\n${"a".repeat(256_001)}`,
    }));
    expect(res.status).toBe(422);
    // Short-circuited at validation — the persistence path never ran.
    expect(mockUpsertDraftEntityAdmin).not.toHaveBeenCalled();
    expect(mockUpsertEntityAdmin).not.toHaveBeenCalled();
  });

  it("accepts yamlContent at exactly the max length bound (#4780 — cap is inclusive)", async () => {
    setOrgAdmin("org-1");
    mockUpsertDraftEntityAdmin.mockReset();
    mockUpsertDraftEntityAdmin.mockResolvedValue(undefined);
    // Boundary guard: valid entity YAML sized to EXACTLY the ceiling must pass
    // the schema and reach the handler (catches an off-by-one that made the
    // bound stricter than intended). Pad with a YAML comment js-yaml ignores.
    const cap = 256_000; // mirrors MAX_ENTITY_YAML_LEN in admin.ts
    const prefix = "table: users\n# ";
    const yamlContent = prefix + "a".repeat(cap - prefix.length);
    expect(yamlContent).toHaveLength(cap);
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities/users", "PUT", { yamlContent }));
    expect(res.status).toBe(200);
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /api/v1/admin/semantic/org/entities/:name", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockDeleteEntityAdmin.mockReset();
    mockGetEntityAdmin.mockReset();
    mockUpsertTombstoneAdmin.mockReset();
    mockUpsertTombstoneAdmin.mockResolvedValue(undefined);
    mockDeleteDraftEntityAdmin.mockReset();
    mockDeleteDraftEntityAdmin.mockResolvedValue(true);
  });

  it("returns the canonical bad_request 400 when no active organization (#4356)", async () => {
    setAdmin();
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities/users", "DELETE"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("bad_request");
  });

  it("returns 404 when entity not found", async () => {
    setOrgAdmin("org-1");
    // Post-#2177 the route resolves the existing row first and 404s if it
    // doesn't exist — no need to mock the (now unused) `deleteEntity` path.
    mockGetEntityAdmin.mockResolvedValue(null);
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities/nonexistent", "DELETE"));
    expect(res.status).toBe(404);
  });

  it("tombstones existing published entity (#2177: no hard delete)", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-1", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n", connection_id: null, status: "published",
    });
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/org/entities/users", "DELETE"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).ok).toBe(true);
    expect(mockUpsertTombstoneAdmin).toHaveBeenCalledTimes(1);
    expect(mockDeleteEntityAdmin).not.toHaveBeenCalled();
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
    mockUpsertDraftEntityAdmin.mockReset();
    mockUpsertDraftEntityAdmin.mockResolvedValue(undefined);
    mockUpsertDraftEntityForGroupAdmin.mockReset();
    mockUpsertDraftEntityForGroupAdmin.mockResolvedValue(undefined);
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
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpsertEntityAdmin).not.toHaveBeenCalled();

    // Verify YAML round-trip: parse back and check structure
    const call = (mockUpsertDraftEntityAdmin.mock.calls as unknown[][])[0];
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
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);

    const yamlContent = (mockUpsertDraftEntityAdmin.mock.calls as unknown[][])[0]?.[3] as string;
    expect(yamlContent).toContain("table: orders");
    expect(yamlContent).not.toContain("dimensions:");
    expect(yamlContent).not.toContain("measures:");
    expect(yamlContent).not.toContain("joins:");
    expect(yamlContent).not.toContain("query_patterns:");
  });

  it("forwards connectionId to upsertDraftEntity", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/orders", "PUT", {
      table: "orders",
      connectionId: "warehouse",
    }));
    expect(res.status).toBe(200);
    const call = (mockUpsertDraftEntityAdmin.mock.calls as unknown[][])[0];
    expect(call?.[4]).toBe("warehouse");
    // connectionGroupId path must NOT be taken when only connectionId is given.
    expect(mockUpsertDraftEntityForGroupAdmin).not.toHaveBeenCalled();
  });

  it("writes via upsertDraftEntityForGroup when connectionGroupId is provided (#3854)", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/test_orders", "PUT", {
      table: "test_orders",
      connectionGroupId: "mysql-staging",
    }));
    expect(res.status).toBe(200);
    // The row must land in the requested group scope, NOT the default null scope.
    expect(mockUpsertDraftEntityForGroupAdmin).toHaveBeenCalledTimes(1);
    const call = (mockUpsertDraftEntityForGroupAdmin.mock.calls as unknown[][])[0];
    expect(call?.[0]).toBe("org-1");
    expect(call?.[1]).toBe("entity");
    expect(call?.[2]).toBe("test_orders");
    expect(call?.[4]).toBe("mysql-staging");
    // The connectionId-resolving path must NOT be taken.
    expect(mockUpsertDraftEntityAdmin).not.toHaveBeenCalled();
  });

  it("treats empty-string connectionGroupId as the explicit null/legacy scope (#3854)", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/demo_users", "PUT", {
      table: "demo_users",
      connectionGroupId: "",
    }));
    expect(res.status).toBe(200);
    expect(mockUpsertDraftEntityForGroupAdmin).toHaveBeenCalledTimes(1);
    // "" → null (legacy/unscoped), addressed directly via the group write.
    const call = (mockUpsertDraftEntityForGroupAdmin.mock.calls as unknown[][])[0];
    expect(call?.[4]).toBeNull();
    expect(mockUpsertDraftEntityAdmin).not.toHaveBeenCalled();
  });

  it("rejects a conflicting connectionId + connectionGroupId pair with 400 (#3854)", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/orders", "PUT", {
      table: "orders",
      connectionId: "warehouse",
      connectionGroupId: "mysql-staging",
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("conflicting_scope");
    // Neither write path runs — the request is rejected, not silently resolved.
    expect(mockUpsertDraftEntityAdmin).not.toHaveBeenCalled();
    expect(mockUpsertDraftEntityForGroupAdmin).not.toHaveBeenCalled();
  });

  it("treats empty-string connectionId as absent — not a conflict, normalized to undefined (#3854)", async () => {
    setOrgAdmin("org-1");
    // `connectionId: ""` is meaningless (asymmetric with connectionGroupId);
    // it must NOT trip the conflict guard alongside a real group, and on the
    // legacy path it must be normalized to undefined, never passed as "".
    const conflictRes = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/orders", "PUT", {
      table: "orders",
      connectionId: "",
      connectionGroupId: "mysql-staging",
    }));
    expect(conflictRes.status).toBe(200);
    expect(mockUpsertDraftEntityForGroupAdmin).toHaveBeenCalledTimes(1);
    expect((mockUpsertDraftEntityForGroupAdmin.mock.calls as unknown[][])[0]?.[4]).toBe("mysql-staging");

    mockUpsertDraftEntityAdmin.mockClear();
    const legacyRes = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/orders", "PUT", {
      table: "orders",
      connectionId: "",
    }));
    expect(legacyRes.status).toBe(200);
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
    // "" normalized to undefined → default/null scope, not the literal "".
    expect((mockUpsertDraftEntityAdmin.mock.calls as unknown[][])[0]?.[4]).toBeUndefined();
  });

  it("returns 500 when upsertDraftEntity throws", async () => {
    setOrgAdmin("org-1");
    mockUpsertDraftEntityAdmin.mockRejectedValue(new Error("DB connection lost"));
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
    mockGetEntityAdmin.mockReset();
    mockUpsertTombstoneAdmin.mockReset();
    mockUpsertTombstoneAdmin.mockResolvedValue(undefined);
    mockDeleteDraftEntityAdmin.mockReset();
    mockDeleteDraftEntityAdmin.mockResolvedValue(true);
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
    mockGetEntityAdmin.mockResolvedValue(null);
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/nonexistent", "DELETE"));
    expect(res.status).toBe(404);
  });

  it("tombstones existing published entity and calls sync (#2177)", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-1", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n", connection_id: null, status: "published",
    });
    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities/edit/users", "DELETE"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.name).toBe("users");
    expect(body.entityType).toBe("entity");
    expect(mockUpsertTombstoneAdmin).toHaveBeenCalledTimes(1);
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
    mockUpsertDraftEntityAdmin.mockReset();
    mockUpsertDraftEntityAdmin.mockResolvedValue(undefined);
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

    // Verify rollback staged a draft of the target YAML (#2177: rollback
    // does not mutate the published row directly anymore — the admin
    // publishes via /api/v1/admin/publish to materialize it).
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpsertEntityAdmin).not.toHaveBeenCalled();
    const upsertCall = (mockUpsertDraftEntityAdmin.mock.calls as unknown[][])[0];
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
    // Rollback still succeeds — draft was staged for the entity (#2177)
    expect(res.status).toBe(200);
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
  });
});

describe("PUT /api/v1/admin/semantic/entities/edit/:name — version creation", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockUpsertEntityAdmin.mockReset();
    mockUpsertEntityAdmin.mockResolvedValue(undefined);
    mockUpsertDraftEntityAdmin.mockReset();
    mockUpsertDraftEntityAdmin.mockResolvedValue(undefined);
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
    // Save still succeeds (drafted via #2177)
    expect(res.status).toBe(200);
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Semantic entity write-path always-draft semantics (#2177, supersedes #1428)
// ---------------------------------------------------------------------------
//
// Pre-#2177 these handlers branched on the resolved `atlasMode` header —
// published-mode writes wrote the published row directly and demo-owned
// entities 4xx'd. Post-#2177 every write stages as a draft regardless of
// the header; the pending-changes pill surfaces it and
// `/api/v1/admin/publish` promotes it. The demo-readonly 403 is gone (the
// org_id scoping makes it redundant — workspace drafts can't mutate the
// `__global__` demo row).

describe("PUT /api/v1/admin/semantic/entities/edit/:name — always stages as draft (#2177)", () => {
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

  it("published mode (default) creates a draft (NOT the published row)", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue(null);
    const res = await app.fetch(
      adminRequest("/api/v1/admin/semantic/entities/edit/users", "PUT", {
        table: "users",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpsertEntityAdmin).not.toHaveBeenCalled();
  });

  it("developer mode also creates a draft (header is irrelevant)", async () => {
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

  it("editing a published entity inserts a draft copy (published untouched)", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-published", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n", connection_id: null, status: "published",
      created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
    });
    const res = await app.fetch(
      adminRequest("/api/v1/admin/semantic/entities/edit/users", "PUT", {
        table: "users", description: "edited",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpsertEntityAdmin).not.toHaveBeenCalled();
  });

  it("editing an existing draft updates the draft row in place", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-draft", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n", connection_id: null, status: "draft",
      created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
    });
    const res = await app.fetch(
      adminRequest("/api/v1/admin/semantic/entities/edit/users", "PUT", {
        table: "users", description: "edited again",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
  });

  it("accepts demo-connection writes in published mode (no 403, drafts instead)", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue(null);
    const res = await app.fetch(
      adminRequest("/api/v1/admin/semantic/entities/edit/users", "PUT", {
        table: "users",
        connectionId: "__demo__",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpsertEntityAdmin).not.toHaveBeenCalled();
  });

  it("accepts edits to a demo-owned published entity (no 403, drafts instead)", async () => {
    setOrgAdmin("org-1");
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
    expect(res.status).toBe(200);
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpsertEntityAdmin).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/v1/admin/semantic/entities/edit/:name — always stages as draft (#2177)", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockDeleteEntityAdmin.mockReset();
    mockUpsertTombstoneAdmin.mockReset();
    mockDeleteDraftEntityAdmin.mockReset();
    mockGetEntityAdmin.mockReset();
    mockSyncEntityDeleteFromDisk.mockReset();
    mockSyncEntityDeleteFromDisk.mockResolvedValue(undefined);
  });

  it("returns 404 when the row does not exist", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue(null);
    const res = await app.fetch(
      adminRequest("/api/v1/admin/semantic/entities/edit/users", "DELETE"),
    );
    expect(res.status).toBe(404);
    expect(mockDeleteEntityAdmin).not.toHaveBeenCalled();
    expect(mockUpsertTombstoneAdmin).not.toHaveBeenCalled();
    expect(mockDeleteDraftEntityAdmin).not.toHaveBeenCalled();
  });

  it("published mode (default) inserts a tombstone instead of hard-deleting", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-published", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n", connection_id: null, status: "published",
      created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
    });
    mockUpsertTombstoneAdmin.mockResolvedValue(undefined);
    const res = await app.fetch(
      adminRequest("/api/v1/admin/semantic/entities/edit/users", "DELETE"),
    );
    expect(res.status).toBe(200);
    expect(mockUpsertTombstoneAdmin).toHaveBeenCalledTimes(1);
    expect(mockDeleteEntityAdmin).not.toHaveBeenCalled();
  });

  it("deleting an existing draft row removes the draft only", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-draft", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n", connection_id: null, status: "draft",
      created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
    });
    mockDeleteDraftEntityAdmin.mockResolvedValue(true);
    const res = await app.fetch(
      adminRequest("/api/v1/admin/semantic/entities/edit/users", "DELETE"),
    );
    expect(res.status).toBe(200);
    expect(mockDeleteDraftEntityAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpsertTombstoneAdmin).not.toHaveBeenCalled();
    expect(mockDeleteEntityAdmin).not.toHaveBeenCalled();
  });

  it("discarding an existing tombstone calls deleteDraftEntity", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-tomb", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "", connection_id: null, status: "draft_delete",
      created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
    });
    mockDeleteDraftEntityAdmin.mockResolvedValue(true);
    const res = await app.fetch(
      adminRequest("/api/v1/admin/semantic/entities/edit/users", "DELETE"),
    );
    expect(res.status).toBe(200);
    expect(mockDeleteDraftEntityAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpsertTombstoneAdmin).not.toHaveBeenCalled();
  });

  it("accepts DELETE on demo-connection entity (no 403, tombstones it)", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-demo", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n", connection_id: "__demo__", status: "published",
      created_at: "2026-04-01T10:00:00Z", updated_at: "2026-04-01T10:00:00Z",
    });
    mockUpsertTombstoneAdmin.mockResolvedValue(undefined);
    const res = await app.fetch(
      adminRequest("/api/v1/admin/semantic/entities/edit/users", "DELETE"),
    );
    expect(res.status).toBe(200);
    expect(mockUpsertTombstoneAdmin).toHaveBeenCalledTimes(1);
    expect(mockDeleteEntityAdmin).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// POST /api/v1/admin/semantic/entities/:name/reconcile (#2462)
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/semantic/entities/:name/reconcile (#2462)", () => {
  const RECONCILE_PATH = "/api/v1/admin/semantic/entities/users/reconcile";

  beforeEach(() => {
    mockHasInternalDB = true;
    mockGetEntityAdmin.mockReset();
    mockUpsertDraftEntityAdmin.mockReset();
    mockUpsertDraftEntityAdmin.mockResolvedValue(undefined);
    mockUpsertTombstoneAdmin.mockReset();
    mockUpsertTombstoneAdmin.mockResolvedValue(undefined);
    mockDeleteDraftEntityAdmin.mockReset();
    mockDeleteDraftEntityAdmin.mockResolvedValue(true);
    mockSyncEntityToDisk.mockReset();
    mockSyncEntityDeleteFromDisk.mockReset();
    mockRunDriftDiff.mockReset();
    mockRunDriftDiff.mockResolvedValue({
      diff: { newTables: [], removedTables: [], tableDiffs: [], unchangedCount: 0 },
      introspectedTableCount: 1,
      warnings: [] as string[],
    });
    mockGetDBSchemaRaw.mockReset();
    mockGetDBSchemaRaw.mockResolvedValue(new Map());
  });

  it("returns 403 for a non-admin caller", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true,
      mode: "managed",
      user: { id: "u-1", mode: "managed", label: "member@test", role: "member", activeOrganizationId: "org-1" },
    });
    mockCheckRateLimit.mockReturnValue({ allowed: true });
    const res = await app.fetch(adminRequest(RECONCILE_PATH, "POST", { action: "sync_yaml" }));
    expect(res.status).toBe(403);
    expect(mockUpsertDraftEntityAdmin).not.toHaveBeenCalled();
  });

  it("returns 501 when the internal DB isn't configured", async () => {
    setOrgAdmin("org-1");
    mockHasInternalDB = false;
    const res = await app.fetch(adminRequest(RECONCILE_PATH, "POST", { action: "sync_yaml" }));
    expect(res.status).toBe(501);
  });

  it("sync_yaml: returns 200 and stages a draft when the entity exists", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-1", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\ndimensions: []\n",
      connection_group_id: null, status: "published",
      created_at: "2026-05-16T00:00:00Z", updated_at: "2026-05-16T00:00:00Z",
    });
    const res = await app.fetch(adminRequest(RECONCILE_PATH, "POST", { action: "sync_yaml" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.action).toBe("sync_yaml");
    expect(body.name).toBe("users");
    // Always stages as draft regardless of atlasMode (#2177).
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpsertEntityAdmin).not.toHaveBeenCalled();
  });

  it("sync_yaml: rewrites dimensions to match the diff's added column", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-1", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\ndimensions: []\n",
      connection_group_id: null, status: "published",
      created_at: "2026-05-16T00:00:00Z", updated_at: "2026-05-16T00:00:00Z",
    });
    mockRunDriftDiff.mockResolvedValueOnce({
      diff: {
        newTables: [],
        removedTables: [],
        tableDiffs: [{
          table: "users",
          addedColumns: [{ name: "email", type: "string" }],
          removedColumns: [],
          typeChanges: [],
        }],
        unchangedCount: 0,
      },
      introspectedTableCount: 1,
      warnings: [],
    });
    const res = await app.fetch(adminRequest(RECONCILE_PATH, "POST", { action: "sync_yaml" }));
    expect(res.status).toBe(200);
    // Inspect the 4th positional arg of `upsertDraftEntity` — the YAML payload
    // must reflect the diff, not echo the original empty-dimensions YAML.
    const call = mockUpsertDraftEntityAdmin.mock.calls[0] as unknown as [string, string, string, string, string];
    const writtenYaml = call[3];
    expect(writtenYaml).toContain("email");
    expect(writtenYaml).toContain("string");
  });

  it("sync_yaml: accepts demo+published writes via drafts (parity with editor, no 403)", async () => {
    // The PRD acceptance criterion "403 for demo_readonly workspaces in
    // published mode" is intentionally implemented as draft-staging
    // parity with the editor — drafts handle the safety, FE gates the
    // button via `useDemoReadonly`. This locks the contract: a write to
    // a demo-owned entity in published mode succeeds with a 200 + draft.
    setOrgAdmin("org-demo-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-1", org_id: "org-demo-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n", connection_id: "__demo__",
      connection_group_id: null, status: "published",
      created_at: "2026-05-16T00:00:00Z", updated_at: "2026-05-16T00:00:00Z",
    });
    const res = await app.fetch(adminRequest(RECONCILE_PATH, "POST", { action: "sync_yaml" }));
    expect(res.status).toBe(200);
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpsertEntityAdmin).not.toHaveBeenCalled();
  });

  it("sync_yaml: returns 404 when the entity row doesn't exist", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue(null);
    const res = await app.fetch(adminRequest(RECONCILE_PATH, "POST", { action: "sync_yaml" }));
    expect(res.status).toBe(404);
    expect(mockUpsertDraftEntityAdmin).not.toHaveBeenCalled();
  });

  it("remove: hard-deletes a draft entity", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-1", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n",
      connection_group_id: null, status: "draft",
      created_at: "2026-05-16T00:00:00Z", updated_at: "2026-05-16T00:00:00Z",
    });
    const res = await app.fetch(adminRequest(RECONCILE_PATH, "POST", { action: "remove" }));
    expect(res.status).toBe(200);
    expect(mockDeleteDraftEntityAdmin).toHaveBeenCalledTimes(1);
    expect(mockUpsertTombstoneAdmin).not.toHaveBeenCalled();
  });

  it("remove: tombstones a published entity", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-1", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n",
      connection_group_id: null, status: "published",
      created_at: "2026-05-16T00:00:00Z", updated_at: "2026-05-16T00:00:00Z",
    });
    const res = await app.fetch(adminRequest(RECONCILE_PATH, "POST", { action: "remove" }));
    expect(res.status).toBe(200);
    expect(mockUpsertTombstoneAdmin).toHaveBeenCalledTimes(1);
    expect(mockDeleteDraftEntityAdmin).not.toHaveBeenCalled();
  });

  it("create_from_db: returns 404 with error=mismatch when an entity already exists", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-1", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n",
      connection_group_id: null, status: "published",
      created_at: "2026-05-16T00:00:00Z", updated_at: "2026-05-16T00:00:00Z",
    });
    const res = await app.fetch(adminRequest(RECONCILE_PATH, "POST", { action: "create_from_db" }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    // FE branches on this code to switch CTA from "create" → "sync_yaml".
    expect(body.error).toBe("mismatch");
    expect(mockUpsertDraftEntityAdmin).not.toHaveBeenCalled();
  });

  it("create_from_db: returns 404 with error=mismatch when no DB table matches the name", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue(null);
    // Default `getDBSchemaRaw` mock returns an empty Map — no table matches.
    const res = await app.fetch(adminRequest(RECONCILE_PATH, "POST", { action: "create_from_db" }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("mismatch");
    expect(mockUpsertDraftEntityAdmin).not.toHaveBeenCalled();
  });

  it("create_from_db: returns 200 + writes a starter draft when the DB table exists", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue(null);
    mockGetDBSchemaRaw.mockResolvedValueOnce(
      new Map([
        [
          "users",
          {
            table: "users",
            columns: new Map<string, string>([
              ["id", "number"],
              ["email", "string"],
            ]),
          },
        ],
      ]),
    );
    const res = await app.fetch(adminRequest(RECONCILE_PATH, "POST", { action: "create_from_db" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.action).toBe("create_from_db");
    expect(mockUpsertDraftEntityAdmin).toHaveBeenCalledTimes(1);
    const call = mockUpsertDraftEntityAdmin.mock.calls[0] as unknown as [string, string, string, string, string];
    const writtenYaml = call[3];
    expect(writtenYaml).toContain("table: users");
    expect(writtenYaml).toContain("id");
    expect(writtenYaml).toContain("email");
  });

  it("remove: returns 404 with error=not_found (distinct from mismatch) when entity missing", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue(null);
    const res = await app.fetch(adminRequest(RECONCILE_PATH, "POST", { action: "remove" }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });

  it("remove: 200 response omits the entity field (no payload on delete)", async () => {
    setOrgAdmin("org-1");
    mockGetEntityAdmin.mockResolvedValue({
      id: "e-1", org_id: "org-1", entity_type: "entity", name: "users",
      yaml_content: "table: users\n",
      connection_group_id: null, status: "draft",
      created_at: "2026-05-16T00:00:00Z", updated_at: "2026-05-16T00:00:00Z",
    });
    const res = await app.fetch(adminRequest(RECONCILE_PATH, "POST", { action: "remove" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.action).toBe("remove");
    expect(body.entity).toBeNull();
  });

  it("rejects an unknown action with a client error", async () => {
    setOrgAdmin("org-1");
    const res = await app.fetch(
      adminRequest(RECONCILE_PATH, "POST", { action: "wat" }),
    );
    // Hono's zod-openapi validator emits 4xx on schema mismatch (Hono uses
    // 400; the OpenAPI validator middleware may surface 422). Either is a
    // valid contract — we just need to confirm we don't 500 or 200 on a
    // body that fails the discriminator.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
