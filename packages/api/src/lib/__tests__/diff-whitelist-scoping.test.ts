/**
 * Tests for semantic diff whitelist scoping (#1431).
 *
 * Covers the phantom-tables fix: `getDBSchema` and `runDiff` now filter the
 * DB snapshot to only include tables present in the org's mode-aware semantic
 * whitelist. Before this fix, demo orgs sharing a physical DB saw tables from
 * every tenant's dataset (cybersec + ecommerce + SaaS).
 *
 * Structure:
 * 1. `filterSnapshotsByWhitelist` — pure unit tests (bare + schema-qualified).
 * 2. `runDiff` — integration tests with mocked connection + internal DB that
 *    verify the right whitelist source is consulted per (orgId, mode) tuple.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shared in-memory DB schema — what information_schema returns for tests
// ---------------------------------------------------------------------------

type ColumnRow = { table_name: string; column_name: string; data_type: string };
let dbRows: ColumnRow[] = [];

function setDBTables(tables: Record<string, Record<string, string>>): void {
  dbRows = [];
  for (const [table, cols] of Object.entries(tables)) {
    for (const [col, dt] of Object.entries(cols)) {
      dbRows.push({ table_name: table, column_name: col, data_type: dt });
    }
  }
}

// ---------------------------------------------------------------------------
// Mock internal DB — backs loadOrgWhitelist via listEntities/…WithOverlay
// ---------------------------------------------------------------------------

type EntityRow = {
  name: string;
  table: string;
  status: "published" | "draft" | "draft_delete" | "archived";
  org_id: string;
  connection_id?: string | null;
};

let entityRows: EntityRow[] = [];
let internalDBAvailable = true;

const mockListEntities = mock(
  async (orgId: string, _type?: string, statusFilter?: string) => {
    return entityRows
      .filter((r) => r.org_id === orgId)
      .filter((r) => (statusFilter ? r.status === statusFilter : true))
      .map((r) => ({
        id: `id-${r.name}-${r.status}`,
        org_id: r.org_id,
        entity_type: "entity" as const,
        name: r.name,
        yaml_content: `table: ${r.table}\n`,
        connection_id: r.connection_id ?? null,
        status: r.status,
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      }));
  },
);

// Developer-mode overlay: published + draft, tombstones/archived excluded.
const mockListEntitiesWithOverlay = mock(
  async (orgId: string, _type?: string) => {
    return entityRows
      .filter((r) => r.org_id === orgId)
      .filter((r) => r.status === "published" || r.status === "draft")
      .map((r) => ({
        id: `id-${r.name}-${r.status}`,
        org_id: r.org_id,
        entity_type: "entity" as const,
        name: r.name,
        yaml_content: `table: ${r.table}\n`,
        connection_id: r.connection_id ?? null,
        status: r.status,
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      }));
  },
);

mock.module("@atlas/api/lib/semantic/entities", () => ({
  listEntities: mockListEntities,
  listEntitiesWithOverlay: mockListEntitiesWithOverlay,
  getEntity: async () => null,
  upsertEntity: async () => {},
  deleteEntity: async () => false,
  countEntities: async () => 0,
  bulkUpsertEntities: async () => 0,
  createVersion: async () => "v1",
  listVersions: async () => ({ versions: [], total: 0 }),
  getVersion: async () => null,
  generateChangeSummary: async () => null,
  SEMANTIC_ENTITY_STATUSES: ["published", "draft", "draft_delete", "archived"] as const,
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => internalDBAvailable,
  internalQuery: async () => [],
  internalExecute: async () => {},
  encryptUrl: (u: string) => u,
  decryptUrl: (u: string) => u,
  getInternalDB: () => {
    throw new Error("not configured");
  },
  _resetPool: () => {},
}));

// ---------------------------------------------------------------------------
// Mock the datasource connection — returns dbRows for information_schema
// ---------------------------------------------------------------------------

const mockDBConnection = {
  query: async (_sql: string, _timeoutMs?: number) => ({
    columns: ["table_name", "column_name", "data_type"],
    rows: dbRows as unknown as Record<string, unknown>[],
  }),
  close: async () => {},
};

mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => mockDBConnection,
  connections: {
    get: () => mockDBConnection,
    getDefault: () => mockDBConnection,
    getDBType: () => "postgres" as const,
    getTargetHost: () => "localhost",
    list: () => ["default"],
    has: () => true,
  },
  detectDBType: () => "postgres" as const,
  extractTargetHost: () => "localhost",
}));

// ---------------------------------------------------------------------------
// Imports under test — mock.module registrations above take effect here
// ---------------------------------------------------------------------------

const { filterSnapshotsByWhitelist, runDiff, getDBSchema } = await import("../semantic/diff");
const { _resetOrgWhitelists } = await import("../semantic/whitelist");

// ---------------------------------------------------------------------------
// filterSnapshotsByWhitelist — pure
// ---------------------------------------------------------------------------

function snapshot(table: string, cols: string[] = ["id"]): import("../semantic/diff").EntitySnapshot {
  return {
    table,
    columns: new Map(cols.map((c) => [c, "string"])),
    foreignKeys: new Set(),
  };
}

describe("filterSnapshotsByWhitelist", () => {
  it("returns the input unchanged when allowed is undefined", () => {
    const input = new Map([["users", snapshot("users")]]);
    const out = filterSnapshotsByWhitelist(input, undefined);
    expect(out).toBe(input);
  });

  it("returns an empty map when allowed is an empty set", () => {
    const input = new Map([["users", snapshot("users")]]);
    const out = filterSnapshotsByWhitelist(input, new Set());
    expect(out.size).toBe(0);
  });

  it("filters out tables missing from the whitelist", () => {
    const input = new Map([
      ["users", snapshot("users")],
      ["orders", snapshot("orders")],
      ["phantom", snapshot("phantom")],
    ]);
    const out = filterSnapshotsByWhitelist(input, new Set(["users", "orders"]));
    expect(out.size).toBe(2);
    expect(out.has("users")).toBe(true);
    expect(out.has("orders")).toBe(true);
    expect(out.has("phantom")).toBe(false);
  });

  it("matches case-insensitively — DB returns any case, whitelist is lowercased", () => {
    const input = new Map([["Users", snapshot("Users")]]);
    const out = filterSnapshotsByWhitelist(input, new Set(["users"]));
    expect(out.has("Users")).toBe(true);
  });

  it("matches a bare DB table against a schema-qualified whitelist entry", () => {
    // Simulates a whitelist that only stored `public.users` — the DB-returned
    // bare `users` should still match so schema-prefixed entities work.
    const input = new Map([["users", snapshot("users")]]);
    const out = filterSnapshotsByWhitelist(input, new Set(["public.users"]));
    expect(out.has("users")).toBe(true);
  });

  it("excludes system tables that aren't in the semantic layer", () => {
    const input = new Map([
      ["users", snapshot("users")],
      ["_migrations", snapshot("_migrations")],
      ["pg_stat_statements", snapshot("pg_stat_statements")],
    ]);
    const out = filterSnapshotsByWhitelist(input, new Set(["users"]));
    expect(out.size).toBe(1);
    expect(out.has("_migrations")).toBe(false);
    expect(out.has("pg_stat_statements")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getDBSchema — applies the allowed filter to its output
// ---------------------------------------------------------------------------

describe("getDBSchema — allowedTables filter", () => {
  beforeEach(() => {
    setDBTables({
      users: { id: "integer", email: "text" },
      orders: { id: "integer", total: "numeric" },
      phantom: { id: "integer" },
    });
  });

  it("returns every table when no filter is given (legacy behavior)", async () => {
    const out = await getDBSchema("default");
    expect(out.size).toBe(3);
    expect(out.has("phantom")).toBe(true);
  });

  it("filters to the whitelist when allowedTables is provided", async () => {
    const out = await getDBSchema("default", new Set(["users", "orders"]));
    expect(out.size).toBe(2);
    expect(out.has("phantom")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runDiff — mode + org scoping
// ---------------------------------------------------------------------------

describe("runDiff — org+mode scoping (#1431)", () => {
  beforeEach(() => {
    _resetOrgWhitelists();
    entityRows = [];
    internalDBAvailable = true;
    mockListEntities.mockClear();
    mockListEntitiesWithOverlay.mockClear();
    // Default DB: 100 tables, only 10 in the semantic layer.
    const tables: Record<string, Record<string, string>> = {};
    for (let i = 0; i < 100; i++) {
      tables[`t${i}`] = { id: "integer" };
    }
    setDBTables(tables);
  });

  it("scopes DB snapshot to the 10 whitelisted tables when 100 exist", async () => {
    entityRows = Array.from({ length: 10 }, (_, i) => ({
      name: `t${i}`,
      table: `t${i}`,
      status: "published" as const,
      org_id: "org-1",
    }));

    const result = await runDiff("default", { orgId: "org-1", atlasMode: "published" });
    // Only the 10 whitelisted tables should be considered.
    // All 10 are "new" because no YAML snapshots exist in this test setup.
    expect(result.newTables.length).toBe(10);
    expect(result.summary.total).toBe(10);
  });

  it("cybersec org does not see ecommerce or SaaS tables in a shared DB", async () => {
    // Shared DB with 3 datasets. Cybersec org only has cybersec entities.
    setDBTables({
      // cybersec tables
      threat_events: { id: "integer", severity: "text" },
      vulnerabilities: { id: "integer", cvss_score: "numeric" },
      // ecommerce tables (NOT in cybersec org's whitelist)
      orders: { id: "integer", total: "numeric" },
      products: { id: "integer", sku: "text" },
      // saas tables (NOT in cybersec org's whitelist)
      accounts: { id: "integer", plan: "text" },
      subscriptions: { id: "integer", status: "text" },
    });

    entityRows = [
      { name: "threat_events", table: "threat_events", status: "published", org_id: "cybersec-org" },
      { name: "vulnerabilities", table: "vulnerabilities", status: "published", org_id: "cybersec-org" },
    ];

    const result = await runDiff("default", {
      orgId: "cybersec-org",
      atlasMode: "published",
    });

    // Only cybersec tables should surface — no phantom tables from other tenants.
    expect(result.newTables.sort()).toEqual(["threat_events", "vulnerabilities"]);
    expect(result.newTables).not.toContain("orders");
    expect(result.newTables).not.toContain("products");
    expect(result.newTables).not.toContain("accounts");
    expect(result.newTables).not.toContain("subscriptions");
  });

  it("developer mode includes draft-only tables via overlay", async () => {
    setDBTables({
      users: { id: "integer" },
      draft_table: { id: "integer" },
    });
    entityRows = [
      { name: "users", table: "users", status: "published", org_id: "org-1" },
      { name: "draft_table", table: "draft_table", status: "draft", org_id: "org-1" },
    ];

    const result = await runDiff("default", { orgId: "org-1", atlasMode: "developer" });

    // Developer mode's overlay should include both published + draft entities.
    expect(result.newTables.sort()).toEqual(["draft_table", "users"]);
  });

  it("published mode excludes draft-only tables (drafts are invisible to end users)", async () => {
    setDBTables({
      users: { id: "integer" },
      draft_table: { id: "integer" },
    });
    entityRows = [
      { name: "users", table: "users", status: "published", org_id: "org-1" },
      { name: "draft_table", table: "draft_table", status: "draft", org_id: "org-1" },
    ];

    const result = await runDiff("default", { orgId: "org-1", atlasMode: "published" });

    // Published mode only sees the published entity — the draft table should
    // be treated as if it isn't part of the semantic layer.
    expect(result.newTables).toEqual(["users"]);
    expect(result.newTables).not.toContain("draft_table");
  });

  it("non-demo org — system tables not in the semantic layer are excluded", async () => {
    setDBTables({
      users: { id: "integer" },
      _drizzle_migrations: { id: "integer" },
      pg_stat_statements: { queryid: "integer" },
    });
    entityRows = [
      { name: "users", table: "users", status: "published", org_id: "solo-org" },
    ];

    const result = await runDiff("default", { orgId: "solo-org", atlasMode: "published" });

    expect(result.newTables).toEqual(["users"]);
    expect(result.newTables).not.toContain("_drizzle_migrations");
    expect(result.newTables).not.toContain("pg_stat_statements");
  });

  it("fails closed when loadOrgWhitelist throws — returns no DB tables", async () => {
    // Simulate a DB outage during whitelist loading.
    mockListEntities.mockImplementationOnce(async () => {
      throw new Error("simulated DB outage");
    });
    setDBTables({
      users: { id: "integer" },
      sensitive_table: { id: "integer" },
    });
    entityRows = [
      { name: "users", table: "users", status: "published", org_id: "org-1" },
    ];

    const result = await runDiff("default", { orgId: "org-1", atlasMode: "published" });

    // Empty whitelist on error beats leaking the full schema across tenants.
    expect(result.newTables).toEqual([]);
    expect(result.unchangedCount).toBe(0);
  });

  it("runs without an orgId (self-hosted CLI path) without throwing", async () => {
    // Self-hosted with no internal DB — falls back to the file-based whitelist
    // path. In this test environment there are no YAML files, so the file
    // whitelist is empty and the diff should report no DB tables.
    internalDBAvailable = false;
    setDBTables({ users: { id: "integer" } });

    const result = await runDiff("default");
    expect(result).toBeDefined();
    expect(result.connection).toBe("default");
    // With an empty file-based whitelist, the DB snapshot is filtered to empty.
    expect(result.newTables).toEqual([]);
  });
});
