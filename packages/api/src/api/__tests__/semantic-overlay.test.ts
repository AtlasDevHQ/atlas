/**
 * Tests for the DB-overlay path on the public semantic API.
 *
 * Lives in a separate file from `semantic.test.ts` so we can mock the
 * `admin-source.ts` helpers without affecting the auth/rate-limit/file-only
 * tests, which exercise the real disk path.
 *
 * Covers #2481: the chat empty-state hook reads `/api/v1/semantic/entities`,
 * which used to be filesystem-only. With the route now wired through
 * `listAdminEntities` / `getAdminEntity`, DB-overlay rows participate and the
 * chat composer unlocks on a fresh workspace with N DB entities + 0 on-disk
 * YAMLs.
 *
 * Strategy: mock `admin-source.ts` (a small surface area — list, getEntity,
 * two error classes) rather than `entities.ts` (50+ exports). The merge
 * shadow-rule itself is unit-tested in `lib/semantic/__tests__/admin-source.test.ts`;
 * here we're only verifying the route plumbing — that the public route
 * actually consumes `listAdminEntities` and projects its output to the
 * narrow public shape.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  mock,
  type Mock,
} from "bun:test";
import { Effect } from "effect";
import { createConnectionMock } from "@atlas/api/testing/connection";
import {
  MockInternalDB,
  makeMockInternalDBShimLayer,
} from "@atlas/api/testing/api-test-mocks";
import type { AdminEntitySummary, AdminEntityListResult } from "@atlas/api/lib/semantic/admin-source";

// --- Mutable fixture state ---------------------------------------------------

// Each test sets these to control the route's view of the world.
let listResult: AdminEntityListResult = { entities: [], warnings: [] };
let detailResult: { entity: Record<string, unknown>; status: string; source: string } | null = null;
let detailThrow: Error | null = null;

function makeDbSummary(over: Partial<AdminEntitySummary> & Pick<AdminEntitySummary, "table">): AdminEntitySummary {
  return {
    name: over.name ?? over.table,
    table: over.table,
    description: over.description ?? "",
    columnCount: over.columnCount ?? 0,
    joinCount: over.joinCount ?? 0,
    measureCount: over.measureCount ?? 0,
    source: over.source ?? "default",
    connection: over.connection ?? null,
    type: over.type ?? null,
    status: "published",
    sourceKind: "db",
    connectionId: null,
    updatedAt: "2026-01-02T00:00:00Z",
  } as AdminEntitySummary;
}

function makeDiskSummary(over: Partial<AdminEntitySummary> & Pick<AdminEntitySummary, "table">): AdminEntitySummary {
  return {
    name: over.name ?? over.table,
    table: over.table,
    description: over.description ?? "",
    columnCount: over.columnCount ?? 0,
    joinCount: over.joinCount ?? 0,
    measureCount: over.measureCount ?? 0,
    source: over.source ?? "default",
    connection: over.connection ?? null,
    type: over.type ?? null,
    status: "published",
    sourceKind: "disk",
    connectionId: null,
    updatedAt: null,
  } as AdminEntitySummary;
}

// --- Mocks (hoisted) ---------------------------------------------------------

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: {
        id: "user-1",
        mode: "simple-key",
        label: "User",
        role: "member",
        activeOrganizationId: "org-1",
      },
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

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      describe: () => [{ id: "default", dbType: "postgres", description: "Test DB" }],
      healthCheck: mock(() => Promise.resolve({ status: "healthy", latencyMs: 5, checkedAt: new Date() })),
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
  getWhitelistedTables: () => new Set(),
  getCrossSourceJoins: () => [],
  _resetWhitelists: () => {},
  registerPluginEntities: () => {},
  _resetPluginEntities: () => {},
}));

// Mock the unified admin source so we can drive list + detail behavior
// from per-test fixtures. The shadow rule itself is unit-tested in
// admin-source.test.ts; these tests verify the route plumbing.
class _AdminEntityYamlErrorBase extends Error {
  constructor(
    public readonly kind: "parse" | "shape",
    public readonly entityName: string,
    public readonly entitySource: "db" | "disk",
  ) {
    super(`Admin entity YAML ${kind} error for "${entityName}"`);
    this.name = kind === "parse" ? "AdminEntityYamlParseError" : "AdminEntityYamlShapeError";
  }
}

mock.module("@atlas/api/lib/semantic/admin-source", () => ({
  listAdminEntities: async () => listResult,
  getAdminEntity: async () => {
    if (detailThrow) throw detailThrow;
    return detailResult;
  },
  AdminEntityYamlParseError: class extends _AdminEntityYamlErrorBase {
    constructor(entityName: string, entitySource: "db" | "disk") {
      super("parse", entityName, entitySource);
    }
  },
  AdminEntityYamlShapeError: class extends _AdminEntityYamlErrorBase {
    constructor(entityName: string, entitySource: "db" | "disk") {
      super("shape", entityName, entitySource);
    }
  },
}));

// Full-surface mock — partial mocks break unrelated imports that pull in
// the same module transitively (admin-publish, admin-archive, etc.).
mock.module("@atlas/api/lib/semantic/entities", () => ({
  AmbiguousEntityError: class AmbiguousEntityError extends Error {
    readonly groups: ReadonlyArray<string | null>;
    constructor(over: { entityName?: string; groups?: ReadonlyArray<string | null> } | string = "", groups: ReadonlyArray<string | null> = []) {
      const name = typeof over === "string" ? over : (over.entityName ?? "");
      const resolvedGroups = typeof over === "string" ? groups : (over.groups ?? []);
      super(`Entity "${name}" is ambiguous`);
      this.groups = resolvedGroups;
    }
  },
  listEntityRows: mock(() => Promise.resolve([])),
  listEntitiesWithOverlay: mock(() => Promise.resolve([])),
  listEntities: mock(() => Promise.resolve([])),
  listConnectionGroupMembers: mock(() => Promise.resolve([])),
  getEntity: mock(() => Promise.resolve(null)),
  upsertEntity: mock(() => Promise.resolve()),
  deleteEntity: mock(() => Promise.resolve(false)),
  upsertDraftEntity: mock(() => Promise.resolve()),
  upsertTombstone: mock(() => Promise.resolve()),
  deleteDraftEntity: mock(() => Promise.resolve(false)),
  upsertTombstoneForGroup: mock(() => Promise.resolve()),
  deleteDraftEntityForGroup: mock(() => Promise.resolve(false)),
  countEntities: mock(() => Promise.resolve(0)),
  bulkUpsertEntities: mock(() => Promise.resolve(0)),
  createVersion: mock(() => Promise.resolve(null)),
  listVersions: mock(() => Promise.resolve([])),
  getVersion: mock(() => Promise.resolve(null)),
  generateChangeSummary: mock(() => ""),
  applyTombstones: mock(() => Promise.resolve(0)),
  promoteDraftEntities: mock(() => Promise.resolve(0)),
  DEMO_CONNECTION_ID: "__demo__",
  archiveSingleConnection: mock(() => Promise.resolve({ status: "not_found" as const })),
  restoreSingleConnection: mock(() => Promise.resolve({ status: "not_found" as const })),
  SEMANTIC_ENTITY_STATUSES: ["published", "draft", "draft_delete", "archived"] as const,
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  InternalDB: MockInternalDB,
  makeInternalDBShimLayer: () =>
    makeMockInternalDBShimLayer(() => Promise.resolve([]), { available: true }),
  hasInternalDB: () => true,
  internalQuery: mock(() => Promise.resolve([])),
  queryEffect: mock(() => Effect.succeed([])),
  internalExecute: mock(() => {}),
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
  persistAssistantSteps: mock(() => {}),
  reserveConversationBudget: mock(() => Promise.resolve({ status: "ok" as const, totalStepsBefore: 0 })),
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
  updateNotebookState: mock(() => Promise.resolve({ ok: true })),
  forkConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  convertToNotebook: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  deleteBranch: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  renameBranch: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  resolveGroupForConnection: mock(() => Promise.resolve(null)),
  verifyGroupBelongsToOrg: mock(() => Promise.resolve("ok")),
}));

const { app } = await import("../index");

function apiRequest(urlPath: string): Request {
  return new Request(`http://localhost${urlPath}`, {
    method: "GET",
    headers: { Authorization: "Bearer test-key" },
  });
}

beforeEach(() => {
  listResult = { entities: [], warnings: [] };
  detailResult = null;
  detailThrow = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/semantic/entities — DB overlay", () => {
  it("surfaces DB-overlay entities on a fresh workspace with zero on-disk YAML (#2481)", async () => {
    listResult = {
      entities: [
        makeDbSummary({ table: "users", description: "User accounts", columnCount: 3, joinCount: 1, type: "table" }),
        makeDbSummary({ table: "orders", description: "Customer orders", columnCount: 5, joinCount: 2, type: "table" }),
      ],
      warnings: [],
    };

    const res = await app.fetch(apiRequest("/api/v1/semantic/entities"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { entities: Array<Record<string, unknown>> };
    expect(body.entities).toHaveLength(2);

    const tables = body.entities.map((e) => e.table).sort();
    expect(tables).toEqual(["orders", "users"]);

    const users = body.entities.find((e) => e.table === "users")!;
    expect(users.description).toBe("User accounts");
    expect(users.columnCount).toBe(3);
    expect(users.joinCount).toBe(1);
    expect(users.type).toBe("table");
  });

  it("emits a merged list when DB and disk both contribute (post-shadow-merge)", async () => {
    // `listAdminEntities` already applied the shadow rule; the route just
    // projects the result to the public shape. We verify that mixed
    // sourceKinds flow through unchanged.
    listResult = {
      entities: [
        makeDbSummary({ table: "users", description: "From DB" }),
        makeDiskSummary({ table: "products", description: "From disk only" }),
      ],
      warnings: [],
    };

    const res = await app.fetch(apiRequest("/api/v1/semantic/entities"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entities: Array<Record<string, unknown>> };
    expect(body.entities).toHaveLength(2);
    expect(body.entities.find((e) => e.table === "users")?.description).toBe("From DB");
    expect(body.entities.find((e) => e.table === "products")?.description).toBe("From disk only");
  });

  it("returns disk-only entries when the DB has none (back-compat with self-hosted)", async () => {
    listResult = {
      entities: [makeDiskSummary({ table: "companies", description: "From disk" })],
      warnings: [],
    };

    const res = await app.fetch(apiRequest("/api/v1/semantic/entities"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entities: Array<Record<string, unknown>> };
    expect(body.entities).toHaveLength(1);
    expect(body.entities[0]!.table).toBe("companies");
  });

  it("excludes admin-only fields (measureCount, connection, source, name, status, sourceKind) from the public response", async () => {
    listResult = {
      entities: [
        makeDbSummary({
          table: "users",
          measureCount: 5,
          source: "warehouse",
          connection: "warehouse",
          type: "view",
        }),
      ],
      warnings: [],
    };

    const res = await app.fetch(apiRequest("/api/v1/semantic/entities"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entities: Array<Record<string, unknown>> };

    const users = body.entities[0]!;
    expect(Object.keys(users).toSorted()).toEqual(["columnCount", "description", "joinCount", "table", "type"]);
    expect(users.measureCount).toBeUndefined();
    expect(users.connection).toBeUndefined();
    expect(users.source).toBeUndefined();
    expect(users.name).toBeUndefined();
    expect(users.status).toBeUndefined();
    expect(users.sourceKind).toBeUndefined();
  });

  it("propagates warnings from listAdminEntities", async () => {
    listResult = {
      entities: [],
      warnings: ["broken.yml failed to parse"],
    };

    const res = await app.fetch(apiRequest("/api/v1/semantic/entities"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entities: unknown[]; warnings?: unknown[] };
    expect(body.warnings).toEqual(["broken.yml failed to parse"]);
  });

});

describe("GET /api/v1/semantic/entities/{name} — DB overlay", () => {
  it("returns the entity payload from getAdminEntity", async () => {
    detailResult = {
      entity: { table: "orders", description: "From DB", dimensions: { id: { type: "integer" } } },
      status: "published",
      source: "db",
    };

    const res = await app.fetch(apiRequest("/api/v1/semantic/entities/orders"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entity: Record<string, unknown> };
    expect(body.entity.table).toBe("orders");
    expect(body.entity.description).toBe("From DB");
  });

  it("returns 404 when getAdminEntity returns null", async () => {
    detailResult = null;

    const res = await app.fetch(apiRequest("/api/v1/semantic/entities/nonexistent"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
    expect(body.requestId).toBeDefined();
  });

  it("returns 400 for invalid entity names without invoking getAdminEntity", async () => {
    const res = await app.fetch(apiRequest("/api/v1/semantic/entities/..%2Fetc%2Fpasswd"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_request");
  });

  it("returns 500 with requestId when getAdminEntity throws", async () => {
    detailThrow = new Error("DB connection refused");

    const res = await app.fetch(apiRequest("/api/v1/semantic/entities/orders"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("internal_error");
    expect(body.requestId).toBeDefined();
  });
});
