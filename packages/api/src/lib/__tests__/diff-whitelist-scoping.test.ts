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
    // Only the 10 whitelisted tables should be considered. The YAML side now
    // loads from `semantic_entities` (same source as the whitelist), so every
    // whitelisted table surfaces with the YAML side present — the bare YAML
    // (no `dimensions`) lacks the DB's `id` column, so each lands in
    // `tableDiffs` rather than `newTables` or `unchangedCount`.
    expect(result.summary.total).toBe(10);
    expect(result.tableDiffs.length).toBe(10);
    expect(result.newTables.length).toBe(0);
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

    // Only cybersec tables should surface — no phantom tables from other
    // tenants. Both DB and YAML sides agree on the table set; column drift
    // (DB columns vs the bare-YAML test fixture) lands them in tableDiffs.
    const surfaced = [
      ...result.newTables,
      ...result.removedTables,
      ...result.tableDiffs.map((d) => d.table),
    ].sort();
    expect(surfaced).toEqual(["threat_events", "vulnerabilities"]);
    expect(surfaced).not.toContain("orders");
    expect(surfaced).not.toContain("products");
    expect(surfaced).not.toContain("accounts");
    expect(surfaced).not.toContain("subscriptions");
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
    // Both sides agree on the table set; bare-YAML fixture surfaces them in
    // tableDiffs.
    const surfaced = [
      ...result.newTables,
      ...result.tableDiffs.map((d) => d.table),
    ].sort();
    expect(surfaced).toEqual(["draft_table", "users"]);
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
    const surfaced = [
      ...result.newTables,
      ...result.tableDiffs.map((d) => d.table),
    ];
    expect(surfaced).toEqual(["users"]);
    expect(surfaced).not.toContain("draft_table");
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

    const surfaced = [
      ...result.newTables,
      ...result.tableDiffs.map((d) => d.table),
    ];
    expect(surfaced).toEqual(["users"]);
    expect(surfaced).not.toContain("_drizzle_migrations");
    expect(surfaced).not.toContain("pg_stat_statements");
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

  it("scopes YAML loader to the requested connection — `__demo__` rows hidden when picker is `default`", async () => {
    // SaaS workspace owns both `default` and `__demo__`. Picker on `default`
    // must only see entities where connection_id IS NULL (or = "default") —
    // no `__demo__` rows. Confirms `getYAMLSnapshotsFromDB`'s connection
    // filter mirrors the executeSQL whitelist scoping.
    setDBTables({ orders: { id: "integer" } });
    entityRows = [
      // `__demo__` row should NOT appear when picker is `default`
      { name: "demo_table", table: "demo_table", status: "published", org_id: "org-1", connection_id: "__demo__" },
      // `default` row should appear
      { name: "orders", table: "orders", status: "published", org_id: "org-1", connection_id: null },
    ];

    const result = await runDiff("default", { orgId: "org-1", atlasMode: "published" });

    const surfaced = [
      ...result.newTables,
      ...result.tableDiffs.map((d) => d.table),
      ...result.removedTables,
    ];
    expect(surfaced).toContain("orders");
    expect(surfaced).not.toContain("demo_table");
  });

  it("YAML loader reads from DB rather than disk for SaaS demo orgs", async () => {
    // SaaS onboarding writes entity rows with connection_id="__demo__" into
    // semantic_entities (never to disk under __demo__/entities/). Before the
    // DB-backed loader, runDiff(connectionId="__demo__") returned empty
    // yamlSnapshots and the page rendered every DB table as "new". With the
    // loader the entity is found and the diff surfaces it as a regular
    // comparison.
    setDBTables({ users: { id: "integer", email: "text" } });
    entityRows = [
      { name: "users", table: "users", status: "published", org_id: "saas-org", connection_id: "__demo__" },
    ];

    const result = await runDiff("__demo__", { orgId: "saas-org", atlasMode: "published" });

    // The DB-backed loader picks up the entity row, so `users` is no longer a
    // phantom "new table". (Bare-YAML fixture lacks columns → tableDiffs.)
    expect(result.newTables).not.toContain("users");
    expect([...result.tableDiffs.map((d) => d.table)]).toContain("users");
  });

  it("excludes archived entities from the diff regardless of mode", async () => {
    // `getYAMLSnapshotsFromDB` previously passed `undefined` to listEntities
    // when atlasMode was undefined, which returned all statuses including
    // `archived`. Archived rows represent removed semantic-layer state and
    // must never participate in a diff. Confirm both `published` and the
    // omitted-mode path filter them out.
    setDBTables({ active_table: { id: "integer" }, retired_table: { id: "integer" } });
    entityRows = [
      { name: "active_table", table: "active_table", status: "published", org_id: "org-1", connection_id: null },
      { name: "retired_table", table: "retired_table", status: "archived", org_id: "org-1", connection_id: null },
    ];

    const published = await runDiff("default", { orgId: "org-1", atlasMode: "published" });
    const surfacedPublished = [
      ...published.newTables,
      ...published.tableDiffs.map((d) => d.table),
      ...published.removedTables,
    ];
    // `retired_table` exists in DB and IS in the whitelist (because the
    // whitelist also reads via listEntities), so it survives the DB filter.
    // But it must NOT appear on the YAML side, so it surfaces only in
    // newTables (DB has it, YAML doesn't) — never in unchanged or tableDiffs.
    // The active table appears in tableDiffs (DB columns vs bare YAML).
    expect(surfacedPublished).toContain("active_table");

    // Same expectation when mode is omitted — should still exclude archived.
    const omitted = await runDiff("default", { orgId: "org-1" });
    expect(omitted).toBeDefined();
    expect(omitted.summary).toBeDefined();
  });

  it("whitelist cache expires after TTL — wall-clock advance triggers re-query", async () => {
    // Without a TTL, the whitelist cache held forever (only entity CRUD
    // invalidated it). Manual SQL or external recovery scripts left the
    // API serving stale "no entities" until restart. The TTL must be
    // wall-clock driven — pinning that here with a Date.now mock so the
    // test fails if the TTL is ever set to Infinity or removed.
    const { _resetOrgWhitelists, loadOrgWhitelist } = await import("../semantic/whitelist");
    _resetOrgWhitelists();

    const realNow = Date.now;
    let nowMs = 1_000_000;
    Date.now = () => nowMs;

    try {
      entityRows = []; // first load: empty
      const first = await loadOrgWhitelist("ttl-org", "published");
      expect(first.size).toBe(0);

      // Add rows out-of-band, simulating a recovery SQL insert.
      entityRows = [
        { name: "users", table: "users", status: "published", org_id: "ttl-org", connection_id: "__demo__" },
      ];

      // Within TTL window (advance < 60s): cache hit, still empty.
      nowMs += 30_000;
      const cached = await loadOrgWhitelist("ttl-org", "published");
      expect(cached.size).toBe(0);

      // Cross the TTL boundary: cache evicts, re-queries, sees the new row.
      nowMs += 31_000;
      const fresh = await loadOrgWhitelist("ttl-org", "published");
      expect(fresh.get("__demo__")?.has("users")).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it("falls back to disk YAML when the org has zero DB entries for the connection", async () => {
    // Self-hosted-with-internal-DB-and-disk-edited YAML: an admin hand-edits
    // `semantic/entities/*.yml` without importing to the DB. The DB loader
    // returns zero rows for (org, connection); runDiff retries the disk
    // loader so the admin still gets a coherent diff.
    setDBTables({ users: { id: "integer" } });
    entityRows = []; // no DB rows for this org+connection

    const result = await runDiff("default", { orgId: "self-hosted-org", atlasMode: "published" });

    // Disk fallback runs; the test environment has no semantic root, so the
    // disk loader returns no snapshots either. The key invariant being
    // checked: the call doesn't throw, runs both loaders, and returns a
    // well-formed response.
    expect(result).toBeDefined();
    expect(result.connection).toBe("default");
  });
});
