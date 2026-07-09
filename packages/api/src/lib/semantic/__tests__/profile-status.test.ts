/**
 * Durable partial-profile marker helpers (#3682).
 *
 * `upsertProfileStatus` writes the marker that makes a sub-threshold partial
 * semantic layer durably incomplete; `listIncompleteProfileLayers` is the read
 * the publish flow uses to warn before promoting a degraded layer. These tests
 * pin the SQL contract (so the durable row survives a restart and the publish
 * read finds it) and the row→shape mapping, mocking `db/internal` so no live DB
 * is needed — matching the repo's `internalQuery`-spy pattern.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

let mockHasDB = true;
const dbCalls: Array<{ sql: string; params: unknown[] }> = [];
let nextRows: Record<string, unknown>[] = [];

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasDB,
  internalQuery: async (sql: string, params: unknown[]) => {
    dbCalls.push({ sql, params });
    return nextRows;
  },
  internalExecute: () => {},
  getInternalDB: () => ({}),
}));

const { upsertProfileStatus, listIncompleteProfileLayers } = await import(
  "../entities"
);

beforeEach(() => {
  mockHasDB = true;
  dbCalls.length = 0;
  nextRows = [];
});

describe("upsertProfileStatus", () => {
  it("writes a partial marker (partial=true) keyed on the COALESCE sentinel", async () => {
    await upsertProfileStatus("org_1", "g_prod", {
      totalTables: 10,
      failedTables: [{ table: "locked", error: "permission denied" }],
    });

    expect(dbCalls).toHaveLength(1);
    const { sql, params } = dbCalls[0];
    // Durable upsert keyed on (org_id, COALESCE(connection_group_id,'__default__'))
    // so the row survives a restart and a re-profile updates it in place.
    expect(sql).toContain("INSERT INTO semantic_profile_status");
    expect(sql).toContain("ON CONFLICT (org_id, COALESCE(connection_group_id, '__default__'))");
    expect(sql).toContain("DO UPDATE SET");
    // org, group, totalTables, failedCount, json, partial
    expect(params[0]).toBe("org_1");
    expect(params[1]).toBe("g_prod");
    expect(params[2]).toBe(10);
    expect(params[3]).toBe(1); // failed_count
    expect(JSON.parse(params[4] as string)).toEqual([
      { table: "locked", error: "permission denied" },
    ]);
    expect(params[5]).toBe(true); // partial
  });

  it("writes a complete marker (partial=false) when no tables failed — clears a prior partial", async () => {
    await upsertProfileStatus("org_1", null, { totalTables: 5, failedTables: [] });
    const { params } = dbCalls[0];
    expect(params[1]).toBeNull(); // default group
    expect(params[3]).toBe(0); // failed_count
    expect(params[5]).toBe(false); // partial cleared
  });

  it("normalizes an empty-string group to null (single default-scope bucket)", async () => {
    await upsertProfileStatus("org_1", "", { totalTables: 1, failedTables: [] });
    expect(dbCalls[0].params[1]).toBeNull();
  });

  it("throws when no internal DB is configured", async () => {
    mockHasDB = false;
    await expect(
      upsertProfileStatus("org_1", null, { totalTables: 1, failedTables: [] }),
    ).rejects.toThrow(/Internal DB required/);
  });
});

describe("listIncompleteProfileLayers", () => {
  it("filters to partial rows and maps them to the publish-flow shape", async () => {
    nextRows = [
      {
        connection_group_id: null,
        total_tables: 10,
        failed_count: 2,
        // pg returns jsonb already parsed.
        failed_tables: [
          { table: "a", error: "boom" },
          { table: "b", error: "nope" },
        ],
        profiled_at: new Date("2026-06-16T00:00:00.000Z"),
      },
    ];

    const layers = await listIncompleteProfileLayers("org_1");

    // The read filters on `partial = true` in SQL — the publish-flow contract.
    expect(dbCalls[0].sql).toContain("WHERE org_id = $1 AND partial = true");
    expect(layers).toEqual([
      {
        connectionGroupId: null,
        totalTables: 10,
        failedCount: 2,
        failedTables: [
          { table: "a", error: "boom" },
          { table: "b", error: "nope" },
        ],
        profiledAt: "2026-06-16T00:00:00.000Z",
      },
    ]);
  });

  it("tolerates a malformed failed_tables payload (skips bad entries)", async () => {
    nextRows = [
      {
        connection_group_id: "g",
        total_tables: 3,
        failed_count: 1,
        failed_tables: [{ table: "ok", error: "x" }, { notATable: true }, "junk"],
        profiled_at: "not-a-date",
      },
    ];
    const layers = await listIncompleteProfileLayers("org_1");
    expect(layers[0].failedTables).toEqual([{ table: "ok", error: "x" }]);
    expect(layers[0].profiledAt).toBeNull();
  });

  it("returns [] when no internal DB is configured", async () => {
    mockHasDB = false;
    expect(await listIncompleteProfileLayers("org_1")).toEqual([]);
    expect(dbCalls).toHaveLength(0);
  });
});
