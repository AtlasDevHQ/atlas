/**
 * Tenant isolation validation tests.
 *
 * Proves that queries, cache, semantic layers, and explore roots never
 * cross organization boundaries. Uses two mock orgs (org-alpha, org-beta)
 * with distinct entity sets.
 *
 * Covers:
 * 1. SQL whitelist isolation — org-alpha's tables never appear in org-beta's whitelist
 * 2. Semantic index isolation — per-org indexes only mention their own entities
 * 3. Cache key isolation — same SQL + different orgId = different cache entries
 * 4. Explore root isolation — per-org semantic roots are distinct and under .orgs/
 * 5. Request context isolation — org-scoped and file-based whitelists are separate codepaths
 * 6. Audit log isolation — org_id from request context is persisted per-org
 * 7. Conversation isolation — conversations are created and listed per-org
 *
 * Uses mock.module() — all named exports mocked.
 *
 * @see https://github.com/AtlasDevHQ/atlas/issues/510
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Mock the DB layer — all named exports
// ---------------------------------------------------------------------------

import type { SemanticEntityRow } from "../db/semantic-entities";

const mockListEntities = mock((): Promise<SemanticEntityRow[]> => Promise.resolve([]));
const mockGetEntity = mock((): Promise<SemanticEntityRow | null> => Promise.resolve(null));
const mockUpsertEntity = mock((): Promise<void> => Promise.resolve());
const mockDeleteEntity = mock((): Promise<boolean> => Promise.resolve(false));
const mockCountEntities = mock((): Promise<number> => Promise.resolve(0));
const mockBulkUpsertEntities = mock((): Promise<number> => Promise.resolve(0));
const mockInternalQuery = mock((): Promise<Record<string, unknown>[]> => Promise.resolve([]));
const mockInternalExecute = mock((_sql: string, _params?: unknown[]) => {});

/** Controls the activeOrganizationId returned by the mocked getRequestContext. */
let mockActiveOrgId: string | undefined;

mock.module("@atlas/api/lib/db/semantic-entities", () => ({
  listEntities: mockListEntities,
  getEntity: mockGetEntity,
  upsertEntity: mockUpsertEntity,
  deleteEntity: mockDeleteEntity,
  countEntities: mockCountEntities,
  bulkUpsertEntities: mockBulkUpsertEntities,
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  internalQuery: mockInternalQuery,
  internalExecute: mockInternalExecute,
  getInternalDB: () => ({}),
  closeInternalDB: () => Promise.resolve(),
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  migrateInternalDB: () => Promise.resolve(),
  loadSavedConnections: () => Promise.resolve(0),
  getEncryptionKey: () => null,
  _resetEncryptionKeyCache: () => {},
  encryptUrl: (u: string) => u,
  decryptUrl: (u: string) => u,
  isPlaintextUrl: () => true,
  getApprovedPatterns: async () => [],
  upsertSuggestion: mock(() => Promise.resolve("created")),
  getSuggestionsByTables: mock(() => Promise.resolve([])),
  getPopularSuggestions: mock(() => Promise.resolve([])),
  incrementSuggestionClick: mock(),
  deleteSuggestion: mock(() => Promise.resolve(false)),
  getAuditLogQueries: mock(() => Promise.resolve([])),
}));

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => null,
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getRequestContext: () =>
    mockActiveOrgId
      ? {
          requestId: "test-req",
          user: {
            id: "user-1",
            mode: "managed" as const,
            label: "test@test.com",
            activeOrganizationId: mockActiveOrgId,
          },
        }
      : undefined,
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  redactPaths: [],
}));

mock.module("@atlas/api/lib/security", () => ({
  SENSITIVE_PATTERNS: /^$/,
  maskConnectionUrl: (url: string) => url,
}));

// ---------------------------------------------------------------------------
// Cache-busting imports for modules with internal state
// ---------------------------------------------------------------------------

import { resolve } from "path";

const semanticPath = resolve(__dirname, "../semantic.ts");
const semanticMod = await import(`${semanticPath}?t=${Date.now()}`);
const loadOrgWhitelist = semanticMod.loadOrgWhitelist as typeof import("../semantic").loadOrgWhitelist;
const getOrgWhitelistedTables = semanticMod.getOrgWhitelistedTables as typeof import("../semantic").getOrgWhitelistedTables;
const _resetOrgWhitelists = semanticMod._resetOrgWhitelists as typeof import("../semantic")._resetOrgWhitelists;
const _resetOrgSemanticIndexes = semanticMod._resetOrgSemanticIndexes as typeof import("../semantic")._resetOrgSemanticIndexes;
const getOrgSemanticIndex = semanticMod.getOrgSemanticIndex as typeof import("../semantic").getOrgSemanticIndex;
const getWhitelistedTables = semanticMod.getWhitelistedTables as typeof import("../semantic").getWhitelistedTables;

import { getSemanticRoot } from "../semantic-sync";
import { buildCacheKey } from "../cache/keys";
import { logQueryAudit } from "../auth/audit";
import { createConversation, listConversations } from "../conversations";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_ALPHA = "org-alpha";
const ORG_BETA = "org-beta";

/** Entity rows for org-alpha: users and orders tables. */
const ALPHA_ENTITIES: SemanticEntityRow[] = [
  {
    id: "id-alpha-users",
    org_id: ORG_ALPHA,
    entity_type: "entity" as const,
    name: "users",
    yaml_content: "table: users\ndescription: User accounts\n",
    connection_id: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  },
  {
    id: "id-alpha-orders",
    org_id: ORG_ALPHA,
    entity_type: "entity" as const,
    name: "orders",
    yaml_content: "table: public.orders\ndescription: Customer orders\n",
    connection_id: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  },
];

/** Entity rows for org-beta: products and inventory tables (completely different). */
const BETA_ENTITIES: SemanticEntityRow[] = [
  {
    id: "id-beta-products",
    org_id: ORG_BETA,
    entity_type: "entity" as const,
    name: "products",
    yaml_content: "table: products\ndescription: Product catalog\n",
    connection_id: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  },
  {
    id: "id-beta-inventory",
    org_id: ORG_BETA,
    entity_type: "entity" as const,
    name: "inventory",
    yaml_content: "table: warehouse.inventory\ndescription: Warehouse inventory\n",
    connection_id: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  },
];

/** Track org directories created during tests for cleanup. */
const createdOrgIds: string[] = [];

function cleanupOrgDirs() {
  for (const orgId of createdOrgIds) {
    try {
      const root = getSemanticRoot(orgId);
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  createdOrgIds.length = 0;
}

// ---------------------------------------------------------------------------
// 1. SQL whitelist isolation
// ---------------------------------------------------------------------------

describe("SQL whitelist isolation", () => {
  beforeEach(() => {
    _resetOrgWhitelists();
    _resetOrgSemanticIndexes();
    mockListEntities.mockReset();
  });

  it("org-alpha whitelist contains only org-alpha tables", async () => {
    mockListEntities.mockImplementationOnce(() => Promise.resolve(ALPHA_ENTITIES));

    await loadOrgWhitelist(ORG_ALPHA);
    const tables = getOrgWhitelistedTables(ORG_ALPHA, "default");

    expect(tables.has("users")).toBe(true);
    expect(tables.has("orders")).toBe(true);
    expect(tables.has("public.orders")).toBe(true);
    // Must NOT contain beta's tables
    expect(tables.has("products")).toBe(false);
    expect(tables.has("inventory")).toBe(false);
    expect(tables.has("warehouse.inventory")).toBe(false);
  });

  it("org-beta whitelist contains only org-beta tables", async () => {
    mockListEntities.mockImplementationOnce(() => Promise.resolve(BETA_ENTITIES));

    await loadOrgWhitelist(ORG_BETA);
    const tables = getOrgWhitelistedTables(ORG_BETA, "default");

    expect(tables.has("products")).toBe(true);
    expect(tables.has("inventory")).toBe(true);
    expect(tables.has("warehouse.inventory")).toBe(true);
    // Must NOT contain alpha's tables
    expect(tables.has("users")).toBe(false);
    expect(tables.has("orders")).toBe(false);
    expect(tables.has("public.orders")).toBe(false);
  });

  it("loading both orgs simultaneously maintains isolation", async () => {
    // First call → alpha entities
    mockListEntities.mockImplementationOnce(() => Promise.resolve(ALPHA_ENTITIES));
    await loadOrgWhitelist(ORG_ALPHA);

    // Second call → beta entities
    mockListEntities.mockImplementationOnce(() => Promise.resolve(BETA_ENTITIES));
    await loadOrgWhitelist(ORG_BETA);

    const alphaTables = getOrgWhitelistedTables(ORG_ALPHA, "default");
    const betaTables = getOrgWhitelistedTables(ORG_BETA, "default");

    // Alpha has alpha's tables only
    expect(alphaTables.has("users")).toBe(true);
    expect(alphaTables.has("products")).toBe(false);

    // Beta has beta's tables only
    expect(betaTables.has("products")).toBe(true);
    expect(betaTables.has("users")).toBe(false);

    // Sets are completely disjoint
    for (const t of alphaTables) {
      expect(betaTables.has(t)).toBe(false);
    }
    for (const t of betaTables) {
      expect(alphaTables.has(t)).toBe(false);
    }
  });

  it("getOrgWhitelistedTables for unloaded org returns empty set", () => {
    const tables = getOrgWhitelistedTables("org-never-loaded", "default");
    expect(tables.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Semantic index isolation
// ---------------------------------------------------------------------------

describe("semantic index isolation", () => {
  beforeEach(() => {
    _resetOrgWhitelists();
    _resetOrgSemanticIndexes();
    mockListEntities.mockReset();
  });

  afterEach(() => {
    cleanupOrgDirs();
  });

  it("org-alpha index mentions only org-alpha entities", async () => {
    createdOrgIds.push(ORG_ALPHA);
    mockListEntities.mockImplementation(() => Promise.resolve(ALPHA_ENTITIES));

    const index = await getOrgSemanticIndex(ORG_ALPHA);

    expect(index).toContain("users");
    expect(index).toContain("orders");
    expect(index).not.toContain("products");
    expect(index).not.toContain("inventory");
  });

  it("org-beta index mentions only org-beta entities", async () => {
    createdOrgIds.push(ORG_BETA);
    mockListEntities.mockImplementation(() => Promise.resolve(BETA_ENTITIES));

    const index = await getOrgSemanticIndex(ORG_BETA);

    expect(index).toContain("products");
    expect(index).toContain("inventory");
    expect(index).not.toContain("users");
    expect(index).not.toContain("orders");
  });

  it("cached indexes do not cross-contaminate", async () => {
    createdOrgIds.push(ORG_ALPHA, ORG_BETA);

    // Load alpha first
    mockListEntities.mockImplementationOnce(() => Promise.resolve(ALPHA_ENTITIES));
    const alphaIndex = await getOrgSemanticIndex(ORG_ALPHA);

    // Load beta second
    mockListEntities.mockImplementationOnce(() => Promise.resolve(BETA_ENTITIES));
    const betaIndex = await getOrgSemanticIndex(ORG_BETA);

    // Re-read from cache — should be the same
    const alphaIndex2 = await getOrgSemanticIndex(ORG_ALPHA);
    const betaIndex2 = await getOrgSemanticIndex(ORG_BETA);

    expect(alphaIndex2).toBe(alphaIndex);
    expect(betaIndex2).toBe(betaIndex);

    // Content assertions
    expect(alphaIndex).not.toContain("products");
    expect(betaIndex).not.toContain("users");
  });
});

// ---------------------------------------------------------------------------
// 3. Cache key isolation
// ---------------------------------------------------------------------------

describe("cache key isolation", () => {
  it("same SQL with different orgIds produces different cache keys", () => {
    const sql = "SELECT * FROM users LIMIT 10";
    const connection = "default";

    const keyAlpha = buildCacheKey(sql, connection, ORG_ALPHA);
    const keyBeta = buildCacheKey(sql, connection, ORG_BETA);

    expect(keyAlpha).not.toBe(keyBeta);
  });

  it("same SQL with same orgId produces identical cache keys", () => {
    const sql = "SELECT count(*) FROM orders";
    const connection = "default";

    const key1 = buildCacheKey(sql, connection, ORG_ALPHA);
    const key2 = buildCacheKey(sql, connection, ORG_ALPHA);

    expect(key1).toBe(key2);
  });

  it("orgId=undefined produces a different key than any specific orgId", () => {
    const sql = "SELECT 1";
    const connection = "default";

    const keyNoOrg = buildCacheKey(sql, connection, undefined);
    const keyAlpha = buildCacheKey(sql, connection, ORG_ALPHA);
    const keyBeta = buildCacheKey(sql, connection, ORG_BETA);

    expect(keyNoOrg).not.toBe(keyAlpha);
    expect(keyNoOrg).not.toBe(keyBeta);
  });

  it("different SQL with same orgId produces different keys", () => {
    const connection = "default";

    const key1 = buildCacheKey("SELECT * FROM users", connection, ORG_ALPHA);
    const key2 = buildCacheKey("SELECT * FROM orders", connection, ORG_ALPHA);

    expect(key1).not.toBe(key2);
  });

  it("keys are deterministic SHA-256 hex strings", () => {
    const key = buildCacheKey("SELECT 1", "default", ORG_ALPHA);

    // SHA-256 hex = 64 chars
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// 4. Explore root isolation
// ---------------------------------------------------------------------------

describe("explore root isolation", () => {
  it("org-alpha and org-beta have different semantic roots", () => {
    const rootAlpha = getSemanticRoot(ORG_ALPHA);
    const rootBeta = getSemanticRoot(ORG_BETA);

    expect(rootAlpha).not.toBe(rootBeta);
  });

  it("org roots are under semantic/.orgs/", () => {
    const rootAlpha = getSemanticRoot(ORG_ALPHA);
    const rootBeta = getSemanticRoot(ORG_BETA);

    expect(rootAlpha).toContain(path.join("semantic", ".orgs", ORG_ALPHA));
    expect(rootBeta).toContain(path.join("semantic", ".orgs", ORG_BETA));
  });

  it("neither org root is a prefix of the other", () => {
    const rootAlpha = getSemanticRoot(ORG_ALPHA);
    const rootBeta = getSemanticRoot(ORG_BETA);

    expect(rootAlpha.startsWith(rootBeta)).toBe(false);
    expect(rootBeta.startsWith(rootAlpha)).toBe(false);
  });

  it("no-org root is the base semantic/ directory (self-hosted fallback)", () => {
    const root = getSemanticRoot();
    const expected = path.resolve(process.cwd(), "semantic");

    expect(root).toBe(expected);
    // Base root should NOT be under .orgs/
    expect(root).not.toContain(".orgs");
  });

  it("org root never resolves to the base semantic/ directory", () => {
    const baseRoot = getSemanticRoot();
    const rootAlpha = getSemanticRoot(ORG_ALPHA);
    const rootBeta = getSemanticRoot(ORG_BETA);

    expect(rootAlpha).not.toBe(baseRoot);
    expect(rootBeta).not.toBe(baseRoot);
  });
});

// ---------------------------------------------------------------------------
// 5. Request context isolation
// ---------------------------------------------------------------------------

describe("request context isolation", () => {
  beforeEach(() => {
    _resetOrgWhitelists();
    _resetOrgSemanticIndexes();
    mockListEntities.mockReset();
  });

  it("org whitelist not loaded when no activeOrganizationId (falls back to file-based)", () => {
    // When no org is active, getOrgWhitelistedTables returns empty
    // (it's the caller's responsibility to use getWhitelistedTables instead)
    const tables = getOrgWhitelistedTables("", "default");
    expect(tables.size).toBe(0);
  });

  it("file-based whitelist is separate from org whitelists", async () => {
    mockListEntities.mockImplementationOnce(() => Promise.resolve(ALPHA_ENTITIES));
    await loadOrgWhitelist(ORG_ALPHA);

    // File-based whitelist uses getWhitelistedTables (not org-scoped)
    // It reads from disk, not the org cache
    const fileTables = getWhitelistedTables("default");
    const orgTables = getOrgWhitelistedTables(ORG_ALPHA, "default");

    // They are different Set instances from different sources
    expect(fileTables).not.toBe(orgTables);
  });
});

// ---------------------------------------------------------------------------
// 6. Audit log isolation
// ---------------------------------------------------------------------------

describe("audit log isolation", () => {
  beforeEach(() => {
    mockActiveOrgId = undefined;
    mockInternalExecute.mockReset();
  });

  it("audit entry includes org-alpha org_id from request context", () => {
    mockActiveOrgId = ORG_ALPHA;
    logQueryAudit({ sql: "SELECT 1", durationMs: 10, rowCount: 1, success: true });

    expect(mockInternalExecute).toHaveBeenCalledTimes(1);
    const params = mockInternalExecute.mock.calls[0][1] as unknown[];
    // org_id is the 14th parameter (index 13) in the INSERT
    expect(params[13]).toBe(ORG_ALPHA);
  });

  it("audit entry includes org-beta org_id from request context", () => {
    mockActiveOrgId = ORG_BETA;
    logQueryAudit({ sql: "SELECT 1", durationMs: 5, rowCount: 0, success: true });

    expect(mockInternalExecute).toHaveBeenCalledTimes(1);
    const params = mockInternalExecute.mock.calls[0][1] as unknown[];
    expect(params[13]).toBe(ORG_BETA);
  });

  it("audit entry has null org_id when no org context", () => {
    mockActiveOrgId = undefined;
    logQueryAudit({ sql: "SELECT 1", durationMs: 1, rowCount: 1, success: true });

    expect(mockInternalExecute).toHaveBeenCalledTimes(1);
    const params = mockInternalExecute.mock.calls[0][1] as unknown[];
    expect(params[13]).toBeNull();
  });

  it("consecutive audits under different orgs do not cross-contaminate", () => {
    mockActiveOrgId = ORG_ALPHA;
    logQueryAudit({ sql: "SELECT * FROM users", durationMs: 10, rowCount: 5, success: true });

    mockActiveOrgId = ORG_BETA;
    logQueryAudit({ sql: "SELECT * FROM products", durationMs: 8, rowCount: 3, success: true });

    expect(mockInternalExecute).toHaveBeenCalledTimes(2);
    const paramsAlpha = mockInternalExecute.mock.calls[0][1] as unknown[];
    const paramsBeta = mockInternalExecute.mock.calls[1][1] as unknown[];
    expect(paramsAlpha[13]).toBe(ORG_ALPHA);
    expect(paramsBeta[13]).toBe(ORG_BETA);
  });
});

// ---------------------------------------------------------------------------
// 7. Conversation isolation
// ---------------------------------------------------------------------------

describe("conversation isolation", () => {
  beforeEach(() => {
    mockInternalQuery.mockReset();
    mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  });

  it("createConversation persists org-alpha orgId", async () => {
    mockInternalQuery.mockImplementationOnce(() =>
      Promise.resolve([{ id: "conv-alpha" }]),
    );

    const result = await createConversation({
      userId: "user-1",
      title: "Alpha query",
      orgId: ORG_ALPHA,
    });

    expect(result).toEqual({ id: "conv-alpha" });
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const params = (mockInternalQuery.mock.calls as unknown[][])[0][1] as unknown[];
    // orgId is the last parameter in the INSERT
    expect(params[params.length - 1]).toBe(ORG_ALPHA);
  });

  it("createConversation persists org-beta orgId separately", async () => {
    mockInternalQuery.mockImplementationOnce(() =>
      Promise.resolve([{ id: "conv-beta" }]),
    );

    const result = await createConversation({
      userId: "user-2",
      title: "Beta query",
      orgId: ORG_BETA,
    });

    expect(result).toEqual({ id: "conv-beta" });
    const params = (mockInternalQuery.mock.calls as unknown[][])[0][1] as unknown[];
    expect(params[params.length - 1]).toBe(ORG_BETA);
  });

  it("listConversations filters by orgId in SQL query", async () => {
    // Mock: first call = COUNT, second call = data rows
    mockInternalQuery
      .mockImplementationOnce(() => Promise.resolve([{ total: 1 }]))
      .mockImplementationOnce(() =>
        Promise.resolve([{
          id: "conv-alpha",
          user_id: "user-1",
          title: "Alpha query",
          surface: "web",
          connection_id: null,
          starred: false,
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
        }]),
      );

    const result = await listConversations({ orgId: ORG_ALPHA });

    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].id).toBe("conv-alpha");
    // Verify org_id was passed as a SQL parameter
    const countParams = (mockInternalQuery.mock.calls as unknown[][])[0][1] as unknown[];
    expect(countParams).toContain(ORG_ALPHA);
    // Verify the SQL includes org_id filter
    const countSql = (mockInternalQuery.mock.calls as unknown[][])[0][0] as string;
    expect(countSql).toContain("org_id");
  });

  it("different orgIds produce different SQL filter parameters", async () => {
    // Alpha list
    mockInternalQuery
      .mockImplementationOnce(() => Promise.resolve([{ total: 0 }]))
      .mockImplementationOnce(() => Promise.resolve([]));
    await listConversations({ orgId: ORG_ALPHA });

    // Beta list
    mockInternalQuery
      .mockImplementationOnce(() => Promise.resolve([{ total: 0 }]))
      .mockImplementationOnce(() => Promise.resolve([]));
    await listConversations({ orgId: ORG_BETA });

    // Alpha call params (calls 0 and 1)
    const alphaParams = (mockInternalQuery.mock.calls as unknown[][])[0][1] as unknown[];
    expect(alphaParams).toContain(ORG_ALPHA);
    expect(alphaParams).not.toContain(ORG_BETA);

    // Beta call params (calls 2 and 3)
    const betaParams = (mockInternalQuery.mock.calls as unknown[][])[2][1] as unknown[];
    expect(betaParams).toContain(ORG_BETA);
    expect(betaParams).not.toContain(ORG_ALPHA);
  });
});

// ---------------------------------------------------------------------------
// TODO(#509): Add connection pool isolation tests after tenant-scoped pooling ships
// ---------------------------------------------------------------------------
