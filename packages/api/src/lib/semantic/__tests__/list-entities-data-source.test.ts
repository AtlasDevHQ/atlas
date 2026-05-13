/**
 * Contract test for the unified `listEntities(opts)` export (#2150).
 *
 * Pins the data-source-per-call shape so the two formerly-parallel
 * `listEntities` exports can never re-emerge:
 *
 * - `orgId` bound + internal DB → reads per-org rows from
 *   `semantic_entities` and projects to the summary shape. SaaS /
 *   multi-tenant call shape; matches what `loadOrgWhitelist` and
 *   `executeSQL` see (kills the #2142 class).
 * - No internal DB → falls back to the on-disk YAML scanner. The
 *   self-hosted stdio + boot-time semantic-discovery surface.
 * - Internal DB configured BUT no orgId → throws (the SaaS guard).
 *   Disk fallback would leak the pod's baked-in fixture across tenants.
 *
 * Also pins the published-mode default so MCP discovery cannot surface
 * a draft entity that the published-mode SQL whitelist would reject.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Shared switches the tests flip per-case
// ---------------------------------------------------------------------------

let internalDBAvailable = true;
type InternalRow = {
  name: string;
  table: string;
  description?: string | null;
  connection_id?: string | null;
};
let internalRows: InternalRow[] = [];
let lastQueryParams: unknown[] = [];

const mockInternalQuery = mock(async (_sql: string, params: unknown[]) => {
  lastQueryParams = params;
  return internalRows.map((r) => ({
    id: `id-${r.name}`,
    org_id: "org-1",
    entity_type: "entity" as const,
    name: r.name,
    yaml_content: `table: ${r.table}\n${
      r.description ? `description: ${r.description}\n` : ""
    }`,
    connection_id: r.connection_id ?? null,
    connection_group_id: null,
    status: "published" as const,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  }));
});

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => internalDBAvailable,
  internalQuery: mockInternalQuery,
  internalExecute: async () => {},
  encryptSecret: (s: string) => s,
  decryptSecret: (s: string) => s,
  encryptUrl: (u: string) => u,
  decryptUrl: (u: string) => u,
  getInternalDB: () => {
    throw new Error("not configured");
  },
  _resetPool: () => {},
}));

// ---------------------------------------------------------------------------
// Disk fixture — exercised by the no-DB / no-orgId branches
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-list-entities-"));
  fs.mkdirSync(path.join(tmpRoot, "entities"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, "entities", "users.yml"),
    "name: User\ntable: users\ndescription: Disk-side users\n",
  );
  fs.writeFileSync(
    path.join(tmpRoot, "entities", "orders.yml"),
    "table: orders\ndescription: Disk-side orders\n",
  );
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  internalDBAvailable = true;
  internalRows = [];
  lastQueryParams = [];
  mockInternalQuery.mockClear();
});

const entitiesMod = (await import(
  `../entities.ts?t=${Date.now()}`
)) as typeof import("../entities");
const listEntities = entitiesMod.listEntities;

// ---------------------------------------------------------------------------
// SaaS misroute guard — DB configured + missing orgId → throw
// ---------------------------------------------------------------------------

describe("listEntities — SaaS guard", () => {
  it("throws when internal DB is configured but orgId is missing", async () => {
    internalDBAvailable = true;
    await expect(listEntities({ semanticRoot: tmpRoot })).rejects.toThrow(
      /listEntities requires `orgId`/,
    );
    // Must not have hit the DB or the disk before the throw.
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("does not guard when no internal DB is configured (disk-only deploy)", async () => {
    internalDBAvailable = false;
    await expect(listEntities({ semanticRoot: tmpRoot })).resolves.toEqual(
      expect.any(Array),
    );
  });
});

// ---------------------------------------------------------------------------
// Data-source selection
// ---------------------------------------------------------------------------

describe("listEntities — data-source selection", () => {
  it("orgId bound + internal DB → reads per-org from DB", async () => {
    internalDBAvailable = true;
    internalRows = [
      { name: "Customer", table: "customers", description: "DB customers" },
    ];

    const result = await listEntities({
      orgId: "org-1",
      semanticRoot: tmpRoot,
    });

    expect(mockInternalQuery).toHaveBeenCalled();
    expect(result.map((e) => e.table)).toEqual(["customers"]);
    expect(result[0].description).toBe("DB customers");
    // Disk fixture has `users` and `orders` — they must NOT leak in.
    expect(result.find((e) => e.table === "users")).toBeUndefined();
  });

  it("no internal DB → reads from disk YAML", async () => {
    internalDBAvailable = false;
    internalRows = [{ name: "Should not appear", table: "shadow" }];

    const result = await listEntities({ semanticRoot: tmpRoot });

    expect(mockInternalQuery).not.toHaveBeenCalled();
    const tables = result.map((e) => e.table).sort();
    expect(tables).toEqual(["orders", "users"]);
  });

  it("orgId bound + no internal DB → falls back to disk", async () => {
    internalDBAvailable = false;
    internalRows = [{ name: "Should not appear", table: "shadow" }];

    const result = await listEntities({
      orgId: "org-1",
      semanticRoot: tmpRoot,
    });

    expect(mockInternalQuery).not.toHaveBeenCalled();
    const tables = result.map((e) => e.table).sort();
    expect(tables).toEqual(["orders", "users"]);
  });
});

// ---------------------------------------------------------------------------
// Mode handling — published mode default kills the #2142 drift class
// ---------------------------------------------------------------------------

describe("listEntities — mode handling", () => {
  it("default applies published-only status filter so drafts cannot leak", async () => {
    internalDBAvailable = true;
    internalRows = [{ name: "Customer", table: "customers" }];

    await listEntities({ orgId: "org-1", semanticRoot: tmpRoot });

    // `listEntityRows(orgId, "entity", "published")` → params [orgId, "entity", "published"]
    expect(lastQueryParams).toEqual(["org-1", "entity", "published"]);
  });

  it("explicit mode='published' applies the same filter", async () => {
    internalDBAvailable = true;
    internalRows = [{ name: "Customer", table: "customers" }];

    await listEntities({
      orgId: "org-1",
      mode: "published",
      semanticRoot: tmpRoot,
    });

    expect(lastQueryParams).toEqual(["org-1", "entity", "published"]);
  });

  it("mode='developer' routes through the overlay query (drafts visible)", async () => {
    internalDBAvailable = true;
    internalRows = [{ name: "Customer", table: "customers" }];

    await listEntities({
      orgId: "org-1",
      mode: "developer",
      semanticRoot: tmpRoot,
    });

    // listEntitiesWithOverlay → params [orgId, "entity"] (no statusFilter)
    expect(lastQueryParams).toEqual(["org-1", "entity"]);
  });
});

// ---------------------------------------------------------------------------
// Return shape — same EntityListEntry from both branches
// ---------------------------------------------------------------------------

describe("listEntities — return shape is consistent across sources", () => {
  it("DB branch returns the same EntityListEntry summary shape as disk", async () => {
    internalDBAvailable = true;
    internalRows = [
      {
        name: "Customer",
        table: "customers",
        description: "DB customers",
        connection_id: "warehouse",
      },
    ];

    const dbResult = await listEntities({
      orgId: "org-1",
      semanticRoot: tmpRoot,
    });

    expect(dbResult).toHaveLength(1);
    const entry = dbResult[0];
    expect(typeof entry.name).toBe("string");
    expect(typeof entry.table).toBe("string");
    expect(entry.description === null || typeof entry.description === "string").toBe(true);
    expect(typeof entry.source).toBe("string");
    // For DB rows, `source` mirrors connection_id (or "default" when null).
    expect(entry.source).toBe("warehouse");
  });

  it("DB row with null connection_id surfaces as source: 'default'", async () => {
    internalDBAvailable = true;
    internalRows = [
      { name: "Customer", table: "customers", connection_id: null },
    ];

    const result = await listEntities({
      orgId: "org-1",
      semanticRoot: tmpRoot,
    });

    expect(result[0].source).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// Filter applies in both branches
// ---------------------------------------------------------------------------

describe("listEntities — filter applies in both branches", () => {
  it("filter narrows DB results", async () => {
    internalDBAvailable = true;
    internalRows = [
      { name: "Customer", table: "customers", description: "Buyer rows" },
      { name: "Order", table: "orders", description: "Checkout records" },
    ];

    const result = await listEntities({
      orgId: "org-1",
      filter: "BUYER",
      semanticRoot: tmpRoot,
    });

    expect(result.map((e) => e.table)).toEqual(["customers"]);
  });

  it("filter narrows disk results", async () => {
    internalDBAvailable = false;
    const result = await listEntities({
      filter: "ORDER",
      semanticRoot: tmpRoot,
    });

    expect(result.map((e) => e.table)).toEqual(["orders"]);
  });
});

// ---------------------------------------------------------------------------
// EntityShape parity with loadOrgWhitelist — drops rows the whitelist drops
// ---------------------------------------------------------------------------

describe("listEntities — EntityShape parity with loadOrgWhitelist", () => {
  it("drops a DB row whose YAML has no `table` field (matches whitelist behavior)", async () => {
    internalDBAvailable = true;
    // Override mock to return a row with no `table` field in the YAML.
    mockInternalQuery.mockImplementationOnce(async () => [
      {
        id: "id-broken",
        org_id: "org-1",
        entity_type: "entity",
        name: "broken",
        yaml_content: "description: missing table field\n",
        connection_id: null,
        connection_group_id: null,
        status: "published",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    ]);

    const result = await listEntities({
      orgId: "org-1",
      semanticRoot: tmpRoot,
    });

    // Without the EntityShape gate, `rowToEntry` would fall back to
    // `row.name` and surface a phantom "broken" entity that executeSQL
    // would reject. With the gate, the row is dropped (#2142 class).
    expect(result.find((e) => e.name === "broken")).toBeUndefined();
    expect(result).toHaveLength(0);
  });

  it("drops a DB row whose YAML fails to parse", async () => {
    internalDBAvailable = true;
    mockInternalQuery.mockImplementationOnce(async () => [
      {
        id: "id-malformed",
        org_id: "org-1",
        entity_type: "entity",
        name: "malformed",
        yaml_content: "table: orders\ndimensions:\n  - {invalid",
        connection_id: null,
        connection_group_id: null,
        status: "published",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    ]);

    const result = await listEntities({
      orgId: "org-1",
      semanticRoot: tmpRoot,
    });

    expect(result).toHaveLength(0);
  });
});
