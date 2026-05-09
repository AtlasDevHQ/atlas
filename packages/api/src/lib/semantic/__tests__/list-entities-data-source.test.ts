/**
 * Contract test for the unified `listEntities(opts)` export (#2150).
 *
 * Pins the data-source-per-call shape so the two formerly-parallel
 * `listEntities` exports can never re-emerge:
 *
 * - When `orgId` is bound AND the internal DB is configured →
 *   reads per-org rows from `semantic_entities` and projects to the
 *   summary shape. This is the SaaS / multi-tenant call shape; it
 *   matches what `loadOrgWhitelist` and `executeSQL` see, so MCP
 *   tool discovery can never drift away from execution again
 *   (the #2142 class).
 * - When `orgId` is undefined OR no internal DB is configured →
 *   falls back to the on-disk YAML scanner. This is the self-hosted
 *   stdio + boot-time semantic-discovery surface.
 *
 * The return shape is the same `EntityListEntry[]` summary regardless
 * of source — callers that need the full DB row (yaml_content,
 * status, timestamps) keep using the explicit `listEntityRows` export.
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

const mockInternalQuery = mock(async (_sql: string, params: unknown[]) => {
  // listEntityRows passes [orgId, entityType?, statusFilter?]; we don't
  // care about scoping here, just return whatever the test set up.
  void params;
  return internalRows.map((r) => ({
    id: `id-${r.name}`,
    org_id: "org-1",
    entity_type: "entity" as const,
    name: r.name,
    yaml_content: `table: ${r.table}\n${
      r.description ? `description: ${r.description}\n` : ""
    }`,
    connection_id: r.connection_id ?? null,
    status: "published" as const,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  }));
});

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => internalDBAvailable,
  internalQuery: mockInternalQuery,
  internalExecute: async () => {},
  encryptUrl: (u: string) => u,
  decryptUrl: (u: string) => u,
  encryptSecret: (s: string) => s,
  decryptSecret: (s: string) => s,
  getInternalDB: () => {
    throw new Error("not configured");
  },
  _resetPool: () => {},
}));

// ---------------------------------------------------------------------------
// Disk fixture — exercised by the no-orgId / no-DB branches
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
  mockInternalQuery.mockClear();
});

// Cache-bust the SUT after the mocks are installed.
const entitiesMod = (await import(
  `../entities.ts?t=${Date.now()}`
)) as typeof import("../entities");
const listEntities = entitiesMod.listEntities;

// ---------------------------------------------------------------------------
// Contract — data-source selection
// ---------------------------------------------------------------------------

describe("listEntities — data-source selection", () => {
  it("orgId provided + internal DB configured → reads per-org from DB", async () => {
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

  it("orgId undefined → reads from disk YAML (no DB hit)", async () => {
    internalDBAvailable = true;
    internalRows = [{ name: "Should not appear", table: "shadow" }];

    const result = await listEntities({ semanticRoot: tmpRoot });

    expect(mockInternalQuery).not.toHaveBeenCalled();
    const tables = result.map((e) => e.table).sort();
    expect(tables).toEqual(["orders", "users"]);
  });

  it("orgId provided BUT no internal DB → falls back to disk", async () => {
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
    // Caller-facing fields — same as disk-side EntityListEntry.
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
    const result = await listEntities({
      filter: "ORDER",
      semanticRoot: tmpRoot,
    });

    expect(result.map((e) => e.table)).toEqual(["orders"]);
  });
});
