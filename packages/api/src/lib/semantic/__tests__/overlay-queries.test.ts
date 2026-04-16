/**
 * Tests for developer mode overlay queries (#1427).
 *
 * The overlay is the read path that lets admins in developer mode see drafts
 * superimposed on published content. For semantic entities this is a CTE with
 * 3-way priority (draft_delete > draft > published). For connections and
 * prompt collections it's a simple union of statuses.
 *
 * Covers:
 * - `listEntitiesWithOverlay` executes the CTE overlay against the internal DB
 * - The overlay excludes tombstones from the final projection (they only hide)
 * - The overlay excludes entities whose parent connection is archived
 * - `loadOrgWhitelist` in developer mode routes through the overlay
 * - Overlay returns empty array when internal DB is not configured
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// Capture internalQuery calls so we can assert on SQL + params
// ---------------------------------------------------------------------------

interface CapturedCall {
  sql: string;
  params: unknown[] | undefined;
}

const capturedCalls: CapturedCall[] = [];
let mockRows: Record<string, unknown>[] = [];
let hasDB = true;

function resetCapture(): void {
  capturedCalls.length = 0;
  mockRows = [];
  hasDB = true;
}

const mockInternalQuery = mock(async (sql: string, params?: unknown[]) => {
  capturedCalls.push({ sql, params });
  return mockRows;
});

const mockHasInternalDB = mock(() => hasDB);

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mockHasInternalDB,
  // Satisfy other consumers that may import these — not exercised in this file
  internalExecute: mock(async () => 0),
  getInternalDB: mock(() => {
    throw new Error("not configured");
  }),
  _resetPool: mock(() => {}),
  encryptUrl: mock((u: string) => u),
  decryptUrl: mock((u: string) => u),
}));

// Cache-busting import so the mocked module is picked up
const entitiesPath = resolve(__dirname, "../entities.ts");
const entitiesMod = await import(`${entitiesPath}?t=${Date.now()}`);
const listEntitiesWithOverlay =
  entitiesMod.listEntitiesWithOverlay as typeof import("../entities").listEntitiesWithOverlay;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MakeRowOpts {
  name: string;
  table?: string;
  status?: "published" | "draft" | "draft_delete" | "archived";
  connectionId?: string | null;
  id?: string;
}

function makeRow(opts: MakeRowOpts): Record<string, unknown> {
  const status = opts.status ?? "published";
  return {
    id: opts.id ?? `id-${opts.name}-${status}`,
    org_id: "org-1",
    entity_type: "entity",
    name: opts.name,
    yaml_content: `table: ${opts.table ?? opts.name}\n`,
    connection_id: opts.connectionId ?? null,
    status,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("listEntitiesWithOverlay — SQL shape", () => {
  beforeEach(() => {
    resetCapture();
  });

  it("issues a CTE that selects DISTINCT ON the entity key with status priority", async () => {
    await listEntitiesWithOverlay("org-1", "entity");
    expect(capturedCalls.length).toBe(1);
    const sql = capturedCalls[0].sql;
    // CTE pattern
    expect(sql).toMatch(/WITH\s+overlay\s+AS/i);
    // DISTINCT ON the entity key
    expect(sql).toMatch(/DISTINCT\s+ON\s*\(\s*org_id\s*,\s*name\s*,\s*connection_id\s*\)/i);
    // Priority ordering with draft_delete first, then draft, then published
    expect(sql).toMatch(/CASE\s+status\s+WHEN\s+'draft_delete'\s+THEN\s+0/i);
    expect(sql).toMatch(/WHEN\s+'draft'\s+THEN\s+1/i);
    // Final projection filters out tombstones
    expect(sql).toMatch(/WHERE\s+status\s*!=\s*'draft_delete'/i);
  });

  it("restricts to entities whose parent connection is not archived", async () => {
    await listEntitiesWithOverlay("org-1", "entity");
    const sql = capturedCalls[0].sql;
    // Inner check: connection_id IN (SELECT id FROM connections WHERE status IN ('published','draft'))
    // Or equivalent: connection is NULL (unscoped) OR in published/draft set
    expect(sql).toMatch(/connections/i);
    expect(sql).toMatch(/status\s+IN\s*\(\s*'published'\s*,\s*'draft'\s*\)/i);
  });

  it("includes status IN ('published','draft','draft_delete') for the entity side", async () => {
    await listEntitiesWithOverlay("org-1", "entity");
    const sql = capturedCalls[0].sql;
    expect(sql).toMatch(/status\s+IN\s*\(\s*'published'\s*,\s*'draft'\s*,\s*'draft_delete'\s*\)/i);
  });

  it("binds orgId as the first parameter", async () => {
    await listEntitiesWithOverlay("org-xyz", "entity");
    expect(capturedCalls[0].params?.[0]).toBe("org-xyz");
  });

  it("filters by entity type when provided", async () => {
    await listEntitiesWithOverlay("org-1", "metric");
    const sql = capturedCalls[0].sql;
    expect(sql).toMatch(/entity_type\s*=\s*\$/i);
    expect(capturedCalls[0].params).toContain("metric");
  });

  it("omits entity_type filter when not provided", async () => {
    await listEntitiesWithOverlay("org-1");
    const sql = capturedCalls[0].sql;
    expect(sql).not.toMatch(/entity_type\s*=\s*\$/i);
  });

  it("returns an empty array without querying when internal DB is not configured", async () => {
    hasDB = false;
    const result = await listEntitiesWithOverlay("org-1", "entity");
    expect(result).toEqual([]);
    expect(capturedCalls.length).toBe(0);
  });
});

describe("listEntitiesWithOverlay — return shape", () => {
  beforeEach(() => {
    resetCapture();
  });

  it("returns the rows produced by internalQuery as SemanticEntityRow[]", async () => {
    mockRows = [makeRow({ name: "users", status: "published" })];
    const result = await listEntitiesWithOverlay("org-1", "entity");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("users");
    expect(result[0].status).toBe("published");
  });

  it("propagates draft rows through when the DB returns them (simulating draft supersedes)", async () => {
    // The DB is the source of truth for the overlay — this test documents the
    // contract that whatever survives the CTE is returned unchanged.
    mockRows = [makeRow({ name: "users", status: "draft" })];
    const result = await listEntitiesWithOverlay("org-1", "entity");
    expect(result[0].status).toBe("draft");
  });

  it("never returns draft_delete rows (caller relies on the SQL to exclude them)", async () => {
    // Simulating what the SQL would return — draft_delete excluded by final WHERE
    mockRows = [
      makeRow({ name: "users", status: "published" }),
      makeRow({ name: "orders", status: "draft" }),
    ];
    const result = await listEntitiesWithOverlay("org-1", "entity");
    expect(result.every((r) => r.status !== "draft_delete")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadOrgWhitelist — routes through the overlay in developer mode
// ---------------------------------------------------------------------------

describe("loadOrgWhitelist — developer mode uses overlay", () => {
  // Separate mocks so we can observe which entity loader was called
  const mockListEntities = mock(async () => [] as Record<string, unknown>[]);
  const mockListEntitiesWithOverlay = mock(async () => [] as Record<string, unknown>[]);

  mock.module("@atlas/api/lib/semantic/entities", () => ({
    listEntities: mockListEntities,
    listEntitiesWithOverlay: mockListEntitiesWithOverlay,
    getEntity: mock(async () => null),
    upsertEntity: mock(async () => {}),
    deleteEntity: mock(async () => false),
    countEntities: mock(async () => 0),
    bulkUpsertEntities: mock(async () => 0),
    createVersion: mock(async () => "v1"),
    listVersions: mock(async () => ({ versions: [], total: 0 })),
    getVersion: mock(async () => null),
    generateChangeSummary: mock(async () => null),
    SEMANTIC_ENTITY_STATUSES: ["published", "draft", "draft_delete", "archived"] as const,
  }));

  // Cache-bust whitelist module
  const modPath = resolve(__dirname, "../whitelist.ts");
  let whitelistMod: typeof import("../whitelist");

  beforeEach(async () => {
    mockListEntities.mockClear();
    mockListEntitiesWithOverlay.mockClear();
    mockListEntities.mockImplementation(async () => []);
    mockListEntitiesWithOverlay.mockImplementation(async () => []);

    whitelistMod = (await import(`${modPath}?t=${Date.now()}`)) as typeof import("../whitelist");
    whitelistMod._resetOrgWhitelists();
  });

  it("developer mode routes through listEntitiesWithOverlay, not listEntities", async () => {
    await whitelistMod.loadOrgWhitelist("org-1", "developer");
    expect(mockListEntitiesWithOverlay).toHaveBeenCalledTimes(1);
    expect(mockListEntitiesWithOverlay).toHaveBeenCalledWith("org-1", "entity");
    expect(mockListEntities).not.toHaveBeenCalled();
  });

  it("published mode still uses listEntities with the published status filter", async () => {
    await whitelistMod.loadOrgWhitelist("org-1", "published");
    expect(mockListEntities).toHaveBeenCalledTimes(1);
    expect(mockListEntities).toHaveBeenCalledWith("org-1", "entity", "published");
    expect(mockListEntitiesWithOverlay).not.toHaveBeenCalled();
  });

  it("caches developer and published modes separately", async () => {
    await whitelistMod.loadOrgWhitelist("org-1", "developer");
    await whitelistMod.loadOrgWhitelist("org-1", "published");
    await whitelistMod.loadOrgWhitelist("org-1", "developer"); // cache hit
    await whitelistMod.loadOrgWhitelist("org-1", "published"); // cache hit

    expect(mockListEntitiesWithOverlay).toHaveBeenCalledTimes(1);
    expect(mockListEntities).toHaveBeenCalledTimes(1);
  });

  it("invalidateOrgWhitelist clears both caches so next load re-runs the overlay", async () => {
    await whitelistMod.loadOrgWhitelist("org-1", "developer");
    await whitelistMod.loadOrgWhitelist("org-1", "published");
    expect(mockListEntitiesWithOverlay).toHaveBeenCalledTimes(1);
    expect(mockListEntities).toHaveBeenCalledTimes(1);

    whitelistMod.invalidateOrgWhitelist("org-1");

    await whitelistMod.loadOrgWhitelist("org-1", "developer");
    await whitelistMod.loadOrgWhitelist("org-1", "published");
    expect(mockListEntitiesWithOverlay).toHaveBeenCalledTimes(2);
    expect(mockListEntities).toHaveBeenCalledTimes(2);
  });

  it("developer mode builds the whitelist from overlay rows", async () => {
    mockListEntitiesWithOverlay.mockImplementation(async () => [
      makeRow({ name: "users", table: "users", status: "published" }),
      makeRow({ name: "orders", table: "orders", status: "draft" }),
    ]);

    const byConn = await whitelistMod.loadOrgWhitelist("org-1", "developer");
    const tables = byConn.get("default") ?? new Set<string>();
    expect(tables.has("users")).toBe(true);
    expect(tables.has("orders")).toBe(true);
  });
});
