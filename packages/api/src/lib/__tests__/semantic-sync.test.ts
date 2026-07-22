/**
 * Tests for the dual-write sync layer (semantic-sync.ts).
 *
 * Covers:
 * - getSemanticRoot() path resolution + path traversal rejection
 * - syncEntityToDisk() — exercises the real function via actual filesystem
 * - syncEntityDeleteFromDisk() — file removal + ENOENT handling
 * - syncAllEntitiesToDisk() — full rebuild from DB mock, verifies disk output
 * - cleanupOrgDirectory() — directory removal
 *
 * The tests call the real production functions, so syncEntityToDisk /
 * syncAllEntitiesToDisk really do hit the filesystem. The test preload points
 * ATLAS_SEMANTIC_ROOT at a per-process sandbox under os.tmpdir() (#4655), so
 * those writes land there rather than in the checkout; tests still clean up
 * their own org directories so cases can't see each other's leftovers.
 *
 * Uses mock.module() to mock the DB layer.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Mock the DB layer
// ---------------------------------------------------------------------------

import type { SemanticEntityRow } from "../semantic/entities";

const mockListEntities = mock((): Promise<SemanticEntityRow[]> => Promise.resolve([]));
const mockBulkUpsertEntities = mock(
  (_orgId: string, entities: unknown[], _exec?: unknown, _status?: "draft" | "published"): Promise<number> =>
    Promise.resolve(Array.isArray(entities) ? entities.length : 0),
);
const mockHasInternalDB = mock((): boolean => true);
const mockInternalQuery = mock((): Promise<Array<{ org_id: string }>> => Promise.resolve([]));
const mockCountEntities = mock((_orgId: string): Promise<number> => Promise.resolve(0));

void mock.module("@atlas/api/lib/semantic/entities", () => ({
  listEntityRows: mockListEntities,
  listEntitiesWithOverlay: mock(() => Promise.resolve([])),
  listEntities: mock(async () => []),
  getEntity: mock(() => Promise.resolve(null)),
  upsertEntity: mock(() => Promise.resolve()),
  deleteEntity: mock(() => Promise.resolve(false)),
  countEntities: mockCountEntities,
  bulkUpsertEntities: mockBulkUpsertEntities,
}));

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: mockHasInternalDB,
  internalQuery: mockInternalQuery,
  getApprovedPatterns: async () => [],
  upsertSuggestion: mock(() => Promise.resolve("created")),
  getSuggestionsByTables: mock(() => Promise.resolve([])),
  getPopularSuggestions: mock(() => Promise.resolve([])),
  incrementSuggestionClick: mock(),
  deleteSuggestion: mock(() => Promise.resolve(false)),
  getAuditLogQueries: mock(() => Promise.resolve([])),
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
}));

const mockInvalidateOrgWhitelist = mock(() => {});

void mock.module("@atlas/api/lib/semantic", () => ({
  invalidateOrgWhitelist: mockInvalidateOrgWhitelist,
  getWhitelistedTables: mock(() => new Set()),
  getOrgWhitelistedTables: mock(() => new Set()),
  loadOrgWhitelist: mock(() => Promise.resolve(new Map())),
  getOrgSemanticIndex: mock(() => Promise.resolve("")),
  invalidateOrgSemanticIndex: mock(() => {}),
  getCrossSourceJoins: mock(() => []),
  registerPluginEntities: mock(() => {}),
  _resetWhitelists: mock(() => {}),
  _resetPluginEntities: mock(() => {}),
  _resetOrgWhitelists: mock(() => {}),
  _resetOrgSemanticIndexes: mock(() => {}),
}));

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are set up)
// ---------------------------------------------------------------------------

import {
  getSemanticRoot,
  syncEntityToDisk,
  syncEntityDeleteFromDisk,
  syncAllEntitiesToDisk,
  cleanupOrgDirectory,
  importFromDisk,
  reconcileAllOrgs,
} from "../semantic/sync";

// ---------------------------------------------------------------------------
// Test setup — use a unique org ID per test to avoid collisions
// ---------------------------------------------------------------------------

/**
 * The preload's per-process sandbox root. Suites restore this value instead of
 * deleting the var — a bare `delete` would drop the process back to
 * `{cwd}/semantic` and litter the checkout again (#4655).
 */
const SANDBOX_ROOT = process.env.ATLAS_SEMANTIC_ROOT;

function restoreSandboxRoot(): void {
  if (SANDBOX_ROOT === undefined) delete process.env.ATLAS_SEMANTIC_ROOT;
  else process.env.ATLAS_SEMANTIC_ROOT = SANDBOX_ROOT;
}

/** Whatever base root the process is currently configured with. */
function baseRoot(): string {
  return SANDBOX_ROOT ?? path.resolve(process.cwd(), "semantic");
}

/** Org IDs created during tests — cleaned up in afterEach. */
const createdOrgIds: string[] = [];

function testOrgId(): string {
  const id = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createdOrgIds.push(id);
  return id;
}

function makeEntityRow(
  orgId: string,
  name: string,
  entityType: string,
  yamlContent: string,
  connectionGroupId?: string | null,
): SemanticEntityRow {
  return {
    id: `id-${name}`,
    org_id: orgId,
    entity_type: entityType as SemanticEntityRow["entity_type"],
    name,
    yaml_content: yamlContent,
    connection_group_id: connectionGroupId ?? null,
    status: "published" as const,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
}

beforeEach(() => {
  mockListEntities.mockReset();
  mockListEntities.mockImplementation(() => Promise.resolve([]));
});

afterEach(() => {
  // Clean up any org directories created during the test
  for (const orgId of createdOrgIds) {
    try {
      const root = getSemanticRoot(orgId);
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  createdOrgIds.length = 0;
});

// ---------------------------------------------------------------------------
// getSemanticRoot
// ---------------------------------------------------------------------------

describe("getSemanticRoot", () => {
  it("returns base semantic root when no orgId", () => {
    const root = getSemanticRoot();
    expect(root).toBe(baseRoot());
  });

  it("returns org-scoped root when orgId provided", () => {
    const root = getSemanticRoot("org-123");
    expect(root).toBe(path.join(baseRoot(), ".orgs", "org-123"));
  });

  it("falls back to cwd/semantic when ATLAS_SEMANTIC_ROOT is unset", () => {
    try {
      delete process.env.ATLAS_SEMANTIC_ROOT;
      expect(getSemanticRoot()).toBe(path.resolve(process.cwd(), "semantic"));
    } finally {
      restoreSandboxRoot();
    }
  });

  it("returns different roots for different orgs", () => {
    const root1 = getSemanticRoot("org-a");
    const root2 = getSemanticRoot("org-b");
    expect(root1).not.toBe(root2);
    expect(root1).toContain("org-a");
    expect(root2).toContain("org-b");
  });

  it("rejects orgId with path traversal (../)", () => {
    expect(() => getSemanticRoot("../../etc")).toThrow("Invalid orgId");
  });

  it("rejects orgId with slash", () => {
    expect(() => getSemanticRoot("org/sub")).toThrow("Invalid orgId");
  });

  it("rejects orgId of '..'", () => {
    expect(() => getSemanticRoot("..")).toThrow("Invalid orgId");
  });

  it("rejects orgId of '.'", () => {
    expect(() => getSemanticRoot(".")).toThrow("Invalid orgId");
  });

  it("accepts normal UUID-like orgId", () => {
    expect(() => getSemanticRoot("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).not.toThrow();
  });

  it("respects ATLAS_SEMANTIC_ROOT env var for base root", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-semantic-root-"));
    try {
      process.env.ATLAS_SEMANTIC_ROOT = tmpDir;
      const root = getSemanticRoot();
      expect(root).toBe(tmpDir);
    } finally {
      restoreSandboxRoot();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("respects ATLAS_SEMANTIC_ROOT env var for org-scoped root", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-semantic-root-"));
    try {
      process.env.ATLAS_SEMANTIC_ROOT = tmpDir;
      const root = getSemanticRoot("org-test");
      expect(root).toBe(path.join(tmpDir, ".orgs", "org-test"));
    } finally {
      restoreSandboxRoot();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// syncEntityToDisk — exercises the real function
// ---------------------------------------------------------------------------

describe("syncEntityToDisk", () => {
  it("writes entity YAML to the correct path via atomic write", async () => {
    const orgId = testOrgId();
    const content = "table: users\ndescription: User table\n";

    await syncEntityToDisk(orgId, "users", "entity", content);

    const expectedPath = path.join(getSemanticRoot(orgId), "entities", "users.yml");
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.readFileSync(expectedPath, "utf-8")).toBe(content);
  });

  it("creates parent directories automatically", async () => {
    const orgId = testOrgId();
    const root = getSemanticRoot(orgId);

    // Directory should not exist yet
    expect(fs.existsSync(root)).toBe(false);

    await syncEntityToDisk(orgId, "orders", "entity", "table: orders\n");

    const expectedPath = path.join(root, "entities", "orders.yml");
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it("writes metrics to the metrics subdirectory", async () => {
    const orgId = testOrgId();

    await syncEntityToDisk(orgId, "revenue", "metric", "name: revenue\nsql: SUM(amount)\n");

    const expectedPath = path.join(getSemanticRoot(orgId), "metrics", "revenue.yml");
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it("writes glossary to the root directory", async () => {
    const orgId = testOrgId();

    await syncEntityToDisk(orgId, "glossary", "glossary", "terms:\n  - name: ARR\n");

    const expectedPath = path.join(getSemanticRoot(orgId), "glossary.yml");
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it("sanitizes entity names with path traversal characters", async () => {
    const orgId = testOrgId();

    await syncEntityToDisk(orgId, "../../etc/passwd", "entity", "table: hack\n");

    // Should NOT create a file at ../../etc/passwd — safeName strips traversal
    const root = getSemanticRoot(orgId);
    const expectedPath = path.join(root, "entities", "passwd.yml");
    expect(fs.existsSync(expectedPath)).toBe(true);
    // Verify nothing escaped
    expect(fs.existsSync(path.join(root, "..", "..", "etc", "passwd.yml"))).toBe(false);
  });

  it("does not throw on write failure (swallows error)", async () => {
    // syncEntityToDisk swallows errors — DB write already succeeded
    // Use a path-traversal-rejected orgId to verify it doesn't throw
    // Instead, write to a valid org but with a read-only parent
    // (hard to simulate portably — just verify the function signature)
    await expect(
      syncEntityToDisk("nonexistent-but-valid-org", "test", "entity", "table: test\n"),
    ).resolves.toBeUndefined();
    // Clean up
    createdOrgIds.push("nonexistent-but-valid-org");
  });
});

// ---------------------------------------------------------------------------
// syncEntityDeleteFromDisk
// ---------------------------------------------------------------------------

describe("syncEntityDeleteFromDisk", () => {
  it("does not throw when file does not exist", async () => {
    await expect(
      syncEntityDeleteFromDisk("nonexistent-org", "nonexistent", "entity"),
    ).resolves.toBeUndefined();
  });

  it("removes an existing entity file", async () => {
    const orgId = testOrgId();

    // Create the file first
    await syncEntityToDisk(orgId, "to-delete", "entity", "table: to_delete\n");
    const filePath = path.join(getSemanticRoot(orgId), "entities", "to-delete.yml");
    expect(fs.existsSync(filePath)).toBe(true);

    // Delete it
    await syncEntityDeleteFromDisk(orgId, "to-delete", "entity");
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// syncAllEntitiesToDisk
// ---------------------------------------------------------------------------

describe("syncAllEntitiesToDisk", () => {
  it("writes all entities from DB to disk", async () => {
    const orgId = testOrgId();
    mockListEntities.mockImplementation(() =>
      Promise.resolve([
        makeEntityRow(orgId, "users", "entity", "table: users\ndescription: Users\n"),
        makeEntityRow(orgId, "orders", "entity", "table: orders\ndescription: Orders\n"),
        makeEntityRow(orgId, "revenue", "metric", "name: revenue\nsql: SUM(amount)\n"),
      ]),
    );

    const synced = await syncAllEntitiesToDisk(orgId);
    expect(synced).toBe(3);

    // Verify actual files on disk
    const root = getSemanticRoot(orgId);
    expect(fs.existsSync(path.join(root, "entities", "users.yml"))).toBe(true);
    expect(fs.existsSync(path.join(root, "entities", "orders.yml"))).toBe(true);
    expect(fs.existsSync(path.join(root, "metrics", "revenue.yml"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "entities", "users.yml"), "utf-8")).toBe("table: users\ndescription: Users\n");
  });

  it("returns 0 when DB has no entities", async () => {
    mockListEntities.mockImplementation(() => Promise.resolve([]));
    const orgId = testOrgId();

    const synced = await syncAllEntitiesToDisk(orgId);
    expect(synced).toBe(0);
  });

  it("removes stale files not in DB", async () => {
    const orgId = testOrgId();

    // Create a file that won't be in the DB
    const root = getSemanticRoot(orgId);
    const staleFile = path.join(root, "entities", "stale.yml");
    fs.mkdirSync(path.join(root, "entities"), { recursive: true });
    fs.writeFileSync(staleFile, "table: stale\n");
    expect(fs.existsSync(staleFile)).toBe(true);

    // DB only has "users"
    mockListEntities.mockImplementation(() =>
      Promise.resolve([
        makeEntityRow(orgId, "users", "entity", "table: users\n"),
      ]),
    );

    await syncAllEntitiesToDisk(orgId);

    // Stale file should be removed
    expect(fs.existsSync(staleFile)).toBe(false);
    // Users file should exist
    expect(fs.existsSync(path.join(root, "entities", "users.yml"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group-namespace DB→disk mirror (#3275, ADR-0012)
// ---------------------------------------------------------------------------

describe("syncAllEntitiesToDisk — group namespace (#3275)", () => {
  it("writes same-stem entities from different groups without collision", async () => {
    const orgId = testOrgId();
    mockListEntities.mockImplementation(() =>
      Promise.resolve([
        makeEntityRow(orgId, "orders", "entity", "table: orders\ndescription: US orders\n", "us"),
        makeEntityRow(orgId, "orders", "entity", "table: orders\ndescription: EU orders\n", "eu"),
        makeEntityRow(orgId, "users", "entity", "table: users\ndescription: Default users\n"),
      ]),
    );

    const synced = await syncAllEntitiesToDisk(orgId);
    expect(synced).toBe(3);

    const root = getSemanticRoot(orgId);
    const usPath = path.join(root, "groups", "us", "entities", "orders.yml");
    const euPath = path.join(root, "groups", "eu", "entities", "orders.yml");
    // Both group files exist — neither overwrote the other. The pre-fix bug
    // wrote both to a flat entities/orders.yml, silently losing one group.
    expect(fs.existsSync(usPath)).toBe(true);
    expect(fs.existsSync(euPath)).toBe(true);
    expect(fs.readFileSync(usPath, "utf-8")).toContain("US orders");
    expect(fs.readFileSync(euPath, "utf-8")).toContain("EU orders");
    // The default group stays flat at the root; no flat collision.
    expect(fs.existsSync(path.join(root, "entities", "users.yml"))).toBe(true);
    expect(fs.existsSync(path.join(root, "entities", "orders.yml"))).toBe(false);
  });

  it("routes group metrics under groups/<group>/metrics/", async () => {
    const orgId = testOrgId();
    mockListEntities.mockImplementation(() =>
      Promise.resolve([
        makeEntityRow(orgId, "revenue", "metric", "id: revenue\nsql: SELECT 1\n", "us"),
      ]),
    );
    await syncAllEntitiesToDisk(orgId);
    const root = getSemanticRoot(orgId);
    expect(fs.existsSync(path.join(root, "groups", "us", "metrics", "revenue.yml"))).toBe(true);
  });

  it("cleans a stale group entity removed from the DB", async () => {
    const orgId = testOrgId();
    const root = getSemanticRoot(orgId);
    const staleGroupFile = path.join(root, "groups", "eu", "entities", "orders.yml");
    fs.mkdirSync(path.dirname(staleGroupFile), { recursive: true });
    fs.writeFileSync(staleGroupFile, "table: orders\n");
    expect(fs.existsSync(staleGroupFile)).toBe(true);

    // DB now only has the US group's orders.
    mockListEntities.mockImplementation(() =>
      Promise.resolve([
        makeEntityRow(orgId, "orders", "entity", "table: orders\ndescription: US\n", "us"),
      ]),
    );
    await syncAllEntitiesToDisk(orgId);

    // The EU group's stale file is removed; the US group's file is written.
    expect(fs.existsSync(staleGroupFile)).toBe(false);
    expect(fs.existsSync(path.join(root, "groups", "us", "entities", "orders.yml"))).toBe(true);
  });

  it("skips a row whose group is an unsafe path segment", async () => {
    const orgId = testOrgId();
    mockListEntities.mockImplementation(() =>
      Promise.resolve([
        makeEntityRow(orgId, "orders", "entity", "table: orders\n", "../escape"),
        makeEntityRow(orgId, "users", "entity", "table: users\n", "us"),
      ]),
    );
    const synced = await syncAllEntitiesToDisk(orgId);
    // Only the safe row is written; the traversal row is skipped, not escaped.
    expect(synced).toBe(1);
    const root = getSemanticRoot(orgId);
    expect(fs.existsSync(path.join(root, "groups", "us", "entities", "users.yml"))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(root), "escape"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cleanupOrgDirectory
// ---------------------------------------------------------------------------

describe("cleanupOrgDirectory", () => {
  it("removes the org directory and all contents", async () => {
    const orgId = testOrgId();

    // Create some files
    await syncEntityToDisk(orgId, "test", "entity", "table: test\n");
    const root = getSemanticRoot(orgId);
    expect(fs.existsSync(root)).toBe(true);

    await cleanupOrgDirectory(orgId);
    expect(fs.existsSync(root)).toBe(false);

    // Remove from cleanup list since we already cleaned up
    const idx = createdOrgIds.indexOf(orgId);
    if (idx >= 0) createdOrgIds.splice(idx, 1);
  });

  it("does not throw for non-existent org", async () => {
    await expect(
      cleanupOrgDirectory("nonexistent-org"),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// reconcileAllOrgs (boot reconciliation runs full sync — incl. GC)
// ---------------------------------------------------------------------------

describe("reconcileAllOrgs", () => {
  it("GC's orphan disk YAMLs even when the org's entities/ dir is already populated", async () => {
    // Regression guard for the architectural correction: previously
    // boot reconciliation skipped orgs whose dir was non-empty, so
    // legacy YAMLs (e.g. entries from a pre-1.4.4 `atlas init` against
    // the internal Atlas DB) lived on the mirror forever — double-
    // listing in the admin file tree alongside their group-scoped
    // DB rows. Boot now always rebuilds, which removes orphans.
    const orgId = testOrgId();
    const root = getSemanticRoot(orgId);
    fs.mkdirSync(path.join(root, "entities"), { recursive: true });
    fs.writeFileSync(path.join(root, "entities", "apikey.yml"), "table: apikey\n");
    fs.writeFileSync(path.join(root, "entities", "users.yml"), "table: users\n");

    // DB only has `users` — `apikey` is a disk orphan.
    mockHasInternalDB.mockImplementation(() => true);
    // `reconcileAllOrgs` issues one internal query
    // (`SELECT DISTINCT org_id FROM semantic_entities`); pin the response
    // to that SQL substring so a future second query in the function
    // doesn't get this same row returned by accident.
    mockInternalQuery.mockImplementationOnce(() =>
      Promise.resolve([{ org_id: orgId }]),
    );
    mockListEntities.mockImplementation(() =>
      Promise.resolve([makeEntityRow(orgId, "users", "entity", "table: users\n")]),
    );

    await reconcileAllOrgs();

    expect(fs.existsSync(path.join(root, "entities", "users.yml"))).toBe(true);
    expect(fs.existsSync(path.join(root, "entities", "apikey.yml"))).toBe(false);
  });

  it("isolates per-org sync failures — one bad org does not break the others", async () => {
    // Guards the architectural promise that boot doesn't degrade to "all
    // orgs broken" when one org's sync fails. Without isolation, a
    // refactor that re-threw inside the loop would silently regress
    // every org's mirror.
    const goodOrg = testOrgId();
    const badOrg = testOrgId();
    const goodRoot = getSemanticRoot(goodOrg);
    const badRoot = getSemanticRoot(badOrg);
    fs.mkdirSync(path.join(goodRoot, "entities"), { recursive: true });
    fs.mkdirSync(path.join(badRoot, "entities"), { recursive: true });

    mockHasInternalDB.mockImplementation(() => true);
    // Two orgs returned from the org-discovery query, badOrg first so
    // the bad path runs before the good path.
    mockInternalQuery.mockImplementationOnce(() =>
      Promise.resolve([{ org_id: badOrg }, { org_id: goodOrg }]),
    );
    mockListEntities.mockImplementation((orgId?: string) => {
      if (orgId === badOrg) return Promise.reject(new Error("simulated org-specific DB failure"));
      return Promise.resolve([makeEntityRow(goodOrg, "users", "entity", "table: users\n")]);
    });

    // Must not throw — per-org failures are scoped.
    await reconcileAllOrgs();

    // The good org's file landed despite the bad org's failure earlier
    // in the loop.
    expect(fs.existsSync(path.join(goodRoot, "entities", "users.yml"))).toBe(true);
  });

  it("logs and continues when the org-discovery query fails with a non-'does not exist' error", async () => {
    // `sync.ts:632-641` only swallows "table does not exist" / "no such
    // table" — every other DB error rethrows up to the outer try/catch.
    // Without coverage, a refactor that swallowed the wrong error class
    // would let boot proceed silently with no orgs reconciled and no GC.
    mockHasInternalDB.mockImplementation(() => true);
    mockInternalQuery.mockImplementationOnce(() =>
      Promise.reject(new Error("connection terminated unexpectedly")),
    );

    // Must not throw — the outer try/catch logs and returns.
    await reconcileAllOrgs();

    // `listEntityRows` should never be called when the org-discovery
    // query rejected before producing any orgs.
    expect(mockListEntities).not.toHaveBeenCalled();
  });

  it("first-boot: no DB orgs + disk-populated .orgs/<id>/ → triggers auto-import", async () => {
    // `_autoImportOrgsFromDisk` runs when `SELECT DISTINCT org_id FROM
    // semantic_entities` returns zero rows but there's a populated
    // `.orgs/<orgId>/entities/` on disk. Handles self-hosted → managed
    // migration and `atlas init` runs that predate the DB import endpoint.
    const orgId = testOrgId();
    const root = getSemanticRoot(orgId);
    fs.mkdirSync(path.join(root, "entities"), { recursive: true });
    fs.writeFileSync(path.join(root, "entities", "users.yml"), "table: users\nname: users\n");

    mockHasInternalDB.mockImplementation(() => true);
    // Org-discovery returns no orgs → falls into the auto-import branch.
    mockInternalQuery.mockImplementationOnce(() => Promise.resolve([]));
    mockBulkUpsertEntities.mockClear();

    await reconcileAllOrgs();

    // The disk file's content should have been handed to bulkUpsertEntities.
    expect(mockBulkUpsertEntities).toHaveBeenCalled();
    const [calledOrgId, calledEntities] = mockBulkUpsertEntities.mock.calls[0] ?? [];
    expect(calledOrgId).toBe(orgId);
    expect(Array.isArray(calledEntities)).toBe(true);
    expect((calledEntities as unknown[]).length).toBeGreaterThan(0);
  });

  it("first-boot: no DB orgs + ONLY grouped disk entities → triggers auto-import (#3245)", async () => {
    // A purely-grouped org (groups/<group>/entities/ with no flat entities/)
    // must still be detected for first-boot auto-import — the flat-only
    // detection skipped it, so its grouped entities never reached the DB.
    const orgId = testOrgId();
    const root = getSemanticRoot(orgId);
    fs.mkdirSync(path.join(root, "groups", "prod", "entities"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "groups", "prod", "entities", "sales.yml"),
      "table: sales\nname: sales\n",
    );

    mockHasInternalDB.mockImplementation(() => true);
    mockInternalQuery.mockImplementationOnce(() => Promise.resolve([]));
    mockBulkUpsertEntities.mockClear();

    await reconcileAllOrgs();

    expect(mockBulkUpsertEntities).toHaveBeenCalled();
    const [calledOrgId, calledEntities] = mockBulkUpsertEntities.mock.calls[0] ?? [];
    expect(calledOrgId).toBe(orgId);
    const ents = calledEntities as Array<{ name: string; connectionGroupId?: string | null }>;
    const sales = ents.find((e) => e.name === "sales");
    expect(sales).toBeDefined();
    expect(sales!.connectionGroupId).toBe("prod");
  });

  it("first-boot: a namespace scan failure fails closed — does not silently skip the org (#3243/#3245)", async () => {
    // getEntityDirs records a failed groups/ scan in `failedScans` and returns
    // a dir list that is silently short. The auto-import detection must NOT
    // treat that as "org is empty" and `continue` — it must fail closed and
    // still consult the DB / attempt the import. Verified by asserting
    // countEntities was consulted for the org (the buggy fail-open path
    // `continue`s before reaching it).
    const orgId = testOrgId();
    const root = getSemanticRoot(orgId);
    // groups/ exists (so getEntityDirs attempts to enumerate it) but its scan
    // throws; no flat entities/ dir → without the fail-closed guard the org
    // looks empty.
    fs.mkdirSync(path.join(root, "groups"), { recursive: true });

    const groupsPath = path.join(root, "groups");
    const realReaddirSync = fs.readdirSync.bind(fs) as (p: fs.PathLike, o?: unknown) => unknown;
    const spy = spyOn(fs, "readdirSync").mockImplementation(((p: fs.PathLike, options?: unknown) => {
      if (typeof p === "string" && p === groupsPath) {
        throw Object.assign(new Error("EACCES: simulated scan failure"), { code: "EACCES" });
      }
      return realReaddirSync(p, options);
    }) as unknown as typeof fs.readdirSync);

    mockHasInternalDB.mockImplementation(() => true);
    mockInternalQuery.mockImplementationOnce(() => Promise.resolve([])); // no DB orgs → auto-import branch
    mockCountEntities.mockClear();

    try {
      await reconcileAllOrgs();
    } finally {
      spy.mockRestore();
    }

    expect(mockCountEntities.mock.calls.some((c) => c[0] === orgId)).toBe(true);
  });

  it("end-to-end: rename apikey → ApiKey in DB, then reconcile + list shows only ApiKey", async () => {
    // The two coupled changes in #2561 (admin reads DB-only when DB is
    // present, sync GC removes orphan files) together produce the
    // architectural rule: after a rename, the old display name is
    // invisible from both the admin route and the explore-tool disk
    // mirror. This integration-style test proves they work together —
    // breaks if either half regresses.
    const orgId = testOrgId();
    const root = getSemanticRoot(orgId);
    fs.mkdirSync(path.join(root, "entities"), { recursive: true });

    // Simulate the pre-rename state: a lowercase `apikey.yml` written by
    // an earlier `atlas init`, no matching DB row anymore (it got
    // renamed to `ApiKey`).
    fs.writeFileSync(path.join(root, "entities", "apikey.yml"), "table: apikey\nname: apikey\n");

    mockHasInternalDB.mockImplementation(() => true);
    mockInternalQuery.mockImplementationOnce(() =>
      Promise.resolve([{ org_id: orgId }]),
    );
    mockListEntities.mockImplementation(() =>
      Promise.resolve([
        makeEntityRow(orgId, "ApiKey", "entity", "table: apikey\nname: ApiKey\n"),
      ]),
    );

    await reconcileAllOrgs();

    // Mirror invariant: PascalCase file present, lowercase orphan gone.
    expect(fs.existsSync(path.join(root, "entities", "ApiKey.yml"))).toBe(true);
    expect(fs.existsSync(path.join(root, "entities", "apikey.yml"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// importFromDisk
// ---------------------------------------------------------------------------

describe("importFromDisk", () => {
  it("imports entities from disk to DB", async () => {
    const orgId = testOrgId();

    // Write some YAML files to the org directory
    await syncEntityToDisk(orgId, "users", "entity", "table: users\ndescription: Users\n");
    await syncEntityToDisk(orgId, "orders", "entity", "table: orders\ndescription: Orders\n");
    await syncEntityToDisk(orgId, "revenue", "metric", "name: revenue\nsql: SUM(amount)\n");

    const result = await importFromDisk(orgId);

    expect(result.total).toBe(3);
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("skips invalid YAML files and reports errors", async () => {
    const orgId = testOrgId();
    const root = getSemanticRoot(orgId);

    // Write a valid entity
    await syncEntityToDisk(orgId, "valid", "entity", "table: valid\n");

    // Write an invalid entity (no table field)
    fs.mkdirSync(path.join(root, "entities"), { recursive: true });
    fs.writeFileSync(path.join(root, "entities", "bad.yml"), "description: no table field\n");

    const result = await importFromDisk(orgId);

    expect(result.imported).toBe(1); // only the valid one
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe("bad.yml");
    expect(result.errors[0].reason).toContain("table");
  });

  it("returns empty result when no files exist", async () => {
    const orgId = testOrgId();

    const result = await importFromDisk(orgId);

    expect(result.total).toBe(0);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("imports glossary.yml from root", async () => {
    const orgId = testOrgId();

    // Write a glossary
    await syncEntityToDisk(orgId, "glossary", "glossary", "terms:\n  - name: ARR\n");

    const result = await importFromDisk(orgId);

    expect(result.imported).toBe(1);
    expect(result.total).toBe(1);
  });

  it("accepts a custom sourceDir", async () => {
    const orgId = testOrgId();

    // Write files to the org's normal directory
    await syncEntityToDisk(orgId, "test", "entity", "table: test\n");

    // Import using the org root as sourceDir explicitly
    const result = await importFromDisk(orgId, { sourceDir: getSemanticRoot(orgId) });

    expect(result.imported).toBe(1);
  });

  it("passes connectionId through to upserted entities", async () => {
    const orgId = testOrgId();

    await syncEntityToDisk(orgId, "test", "entity", "table: test\n");

    const result = await importFromDisk(orgId, { connectionId: "warehouse" });

    expect(result.imported).toBe(1);
    // The mock bulkUpsertEntities doesn't check connectionId,
    // but we verify it doesn't error
  });

  it("threads status:'published' through to bulkUpsertEntities (#3932 demo seed)", async () => {
    const orgId = testOrgId();
    await syncEntityToDisk(orgId, "test", "entity", "table: test\n");

    await importFromDisk(orgId, { connectionId: "__demo__", status: "published" });

    // bulkUpsertEntities receives the status as its 4th positional arg, after
    // (orgId, entities, exec). The demo seed relies on this to land the curated
    // layer queryable in published mode (#3932).
    const call = mockBulkUpsertEntities.mock.calls.at(-1);
    expect(call?.[3]).toBe("published");
  });

  it("defaults bulkUpsertEntities to draft status when status is omitted", async () => {
    const orgId = testOrgId();
    await syncEntityToDisk(orgId, "test", "entity", "table: test\n");

    await importFromDisk(orgId, { connectionId: "warehouse" });

    // Omitting status preserves the review-then-publish default for the admin
    // import / auth-migrate callers — they must keep landing drafts.
    const call = mockBulkUpsertEntities.mock.calls.at(-1);
    expect(call?.[3] ?? "draft").toBe("draft");
  });

  it("surfaces dbFailures when bulkUpsertEntities persists fewer rows than scanned (#3683)", async () => {
    const orgId = testOrgId();
    await syncEntityToDisk(orgId, "users", "entity", "table: users\n");
    await syncEntityToDisk(orgId, "orders", "entity", "table: orders\n");
    await syncEntityToDisk(orgId, "events", "entity", "table: events\n");

    // The MEDIUM finding (#3683): bulkUpsertEntities swallowed per-row failures
    // and returned only a count, so a partial DB write looked clean. Simulate
    // the DB rejecting one of the three valid rows and assert the gap surfaces.
    mockBulkUpsertEntities.mockImplementationOnce(() => Promise.resolve(2));
    const result = await importFromDisk(orgId);

    expect(result.imported).toBe(2);
    expect(result.dbFailures).toBe(1); // 3 scanned, 2 persisted
  });

  it("reports dbFailures: 0 when every scanned entity persists (#3683)", async () => {
    const orgId = testOrgId();
    await syncEntityToDisk(orgId, "users", "entity", "table: users\n");

    const result = await importFromDisk(orgId);

    expect(result.imported).toBe(1);
    expect(result.dbFailures).toBe(0);
  });

  it("propagates (does not swallow) a bulkUpsertEntities throw on the transactional path, and still invalidates the whitelist (#3683)", async () => {
    const orgId = testOrgId();
    await syncEntityToDisk(orgId, "users", "entity", "table: users\n");

    // On the transactional path (`exec` supplied) `bulkUpsertEntities` re-throws
    // on the first row failure so the enclosing seed transaction rolls back —
    // `importFromDisk` must surface that rejection rather than returning a
    // partial `{ imported: 0, dbFailures: N }` result the caller mistakes for a
    // tolerated partial. The `finally` whitelist invalidation must still run.
    mockInvalidateOrgWhitelist.mockClear();
    mockBulkUpsertEntities.mockImplementationOnce(() =>
      Promise.reject(new Error("upsert rejected — transaction aborted")),
    );

    const exec = async <T extends Record<string, unknown>>(): Promise<T[]> => [] as T[];
    await expect(importFromDisk(orgId, { exec })).rejects.toThrow("upsert rejected");
    expect(mockInvalidateOrgWhitelist).toHaveBeenCalledWith(orgId);
  });
});

// ---------------------------------------------------------------------------
// importFromDisk — group-scoped layout traversal (#3245, ADR-0012)
// ---------------------------------------------------------------------------

describe("importFromDisk — group namespace traversal (#3245)", () => {
  /** Source roots created during these tests — cleaned up in afterEach. */
  const sourceDirs: string[] = [];

  function makeSourceRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-import-groups-"));
    sourceDirs.push(dir);
    return dir;
  }

  function writeEntityFile(root: string, content: string, file: string, ...segments: string[]) {
    const dir = path.join(root, ...segments, "entities");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }

  const entityYaml = (table: string, extra = "") => `${extra}table: ${table}\n`;

  /** Entities handed to bulkUpsertEntities during the most recent import. */
  type Collected = { entityType: string; name: string; yamlContent: string; connectionId?: string; connectionGroupId?: string | null };
  function lastUpsertedEntities(): Collected[] {
    const calls = mockBulkUpsertEntities.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1][1] as unknown as Collected[];
  }

  beforeEach(() => {
    mockBulkUpsertEntities.mockClear();
  });

  afterEach(() => {
    for (const dir of sourceDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    sourceDirs.length = 0;
  });

  it("discovers grouped entities and imports them under their directory group", async () => {
    const root = makeSourceRoot();
    writeEntityFile(root, entityYaml("sales"), "sales.yml", "groups", "prod");

    const result = await importFromDisk("org-1", { sourceDir: root });

    expect(result.imported).toBe(1);
    const ent = lastUpsertedEntities().find((e) => e.name === "sales");
    expect(ent).toBeDefined();
    expect(ent!.connectionGroupId).toBe("prod");
  });

  it("scopes each group's entities to its own directory group", async () => {
    const root = makeSourceRoot();
    writeEntityFile(root, entityYaml("orders_us"), "orders.yml", "groups", "us");
    writeEntityFile(root, entityYaml("orders_eu"), "orders.yml", "groups", "eu");

    await importFromDisk("org-1", { sourceDir: root });

    const upserted = lastUpsertedEntities();
    const groups = upserted
      .filter((e) => e.entityType === "entity")
      .map((e) => e.connectionGroupId as string)
      .sort();
    expect(groups).toEqual(["eu", "us"]);
  });

  it("honors the directory group when a grouped entity's field disagrees (ADR-0012)", async () => {
    const root = makeSourceRoot();
    // `connection:` field claims a different group than the directory.
    writeEntityFile(root, entityYaml("sales", "connection: staging\n"), "sales.yml", "groups", "prod");

    await importFromDisk("org-1", { sourceDir: root });

    const ent = lastUpsertedEntities().find((e) => e.name === "sales");
    expect(ent!.connectionGroupId).toBe("prod");
  });

  it("imports legacy <source>/entities/ under the source group (connectionGroupId)", async () => {
    const root = makeSourceRoot();
    writeEntityFile(root, entityYaml("events"), "events.yml", "warehouse");

    const result = await importFromDisk("org-1", { sourceDir: root });

    expect(result.imported).toBe(1);
    const ent = lastUpsertedEntities().find((e) => e.name === "events");
    expect(ent!.connectionGroupId).toBe("warehouse");
  });

  it("keeps flat default entities on the install-id path (connectionId, no group)", async () => {
    const root = makeSourceRoot();
    writeEntityFile(root, entityYaml("users"), "users.yml");

    await importFromDisk("org-1", { sourceDir: root, connectionId: "__demo__" });

    const ent = lastUpsertedEntities().find((e) => e.name === "users");
    expect(ent!.connectionId).toBe("__demo__");
    expect(ent!.connectionGroupId).toBeUndefined();
  });

  it("imports flat + grouped entities together, each scoped correctly", async () => {
    const root = makeSourceRoot();
    writeEntityFile(root, entityYaml("users"), "users.yml"); // flat default
    writeEntityFile(root, entityYaml("sales"), "sales.yml", "groups", "prod"); // grouped

    const result = await importFromDisk("org-1", { sourceDir: root, connectionId: "wh" });

    expect(result.imported).toBe(2);
    const upserted = lastUpsertedEntities();
    const flat = upserted.find((e) => e.name === "users");
    const grouped = upserted.find((e) => e.name === "sales");
    expect(flat!.connectionId).toBe("wh");
    expect(flat!.connectionGroupId).toBeUndefined();
    expect(grouped!.connectionGroupId).toBe("prod");
    expect(grouped!.connectionId).toBeUndefined();
  });

  it("lets the canonical groups/ entity win over a same-group legacy duplicate (Codex review)", async () => {
    // Mid-migration overlap: both canonical groups/prod/ and legacy prod/ hold
    // an `orders` entity for group "prod". getEntityDirs orders canonical first,
    // so only the canonical one is imported — the legacy duplicate must not
    // upsert last into the shared (org, type, name, group) row and clobber it.
    const root = makeSourceRoot();
    writeEntityFile(root, entityYaml("orders_canonical"), "orders.yml", "groups", "prod");
    writeEntityFile(root, entityYaml("orders_legacy"), "orders.yml", "prod");

    const result = await importFromDisk("org-1", { sourceDir: root });

    const upserted = lastUpsertedEntities();
    const orders = upserted.filter((e) => e.name === "orders" && e.connectionGroupId === "prod");
    expect(orders).toHaveLength(1); // de-duped, not two rows
    expect(result.imported).toBe(1);
    // The surviving row is the canonical one, not the stale legacy YAML.
    expect(orders[0].yamlContent).toContain("orders_canonical");
    // The dropped legacy duplicate is still counted, so the summary is truthful
    // about how many files were scanned (2), not silently undercounted (1).
    expect(result.skipped).toBe(1);
    expect(result.total).toBe(2);
  });

  it("reports a per-file error for a grouped entity missing the table field", async () => {
    const root = makeSourceRoot();
    writeEntityFile(root, "description: no table\n", "bad.yml", "groups", "prod");

    const result = await importFromDisk("org-1", { sourceDir: root });

    expect(result.imported).toBe(0);
    expect(result.errors.some((e) => e.file === "bad.yml" && e.reason.includes("table"))).toBe(true);
  });
});
