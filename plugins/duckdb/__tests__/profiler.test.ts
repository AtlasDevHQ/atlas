/**
 * DuckDB introspection (ADR-0017) — `listObjects` / `profile` against a mocked
 * @duckdb/node-api. Asserts external behavior through the contract: the right
 * objects/profiles come back, profiling stays read-only (`access_mode:
 * "READ_ONLY"` on every file-database connection), an empty schema yields no
 * profiles, a per-table failure is recorded (not thrown), and a fatal
 * connection error aborts.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * A canned reader for `runAndReadAll`: `getRowObjects()` returns the rows the
 * profiler reads by property name.
 */
function reader(rows: Record<string, unknown>[]) {
  return Promise.resolve({
    columnNames: () => (rows[0] ? Object.keys(rows[0]) : []),
    getRowObjects: () => rows,
  });
}

// Record every create() option so the read-only posture can be asserted.
const seenCreateOpts: Array<Record<string, string> | undefined> = [];
let fatalNextQuery: string | null = null;

// Route each profiler query to a canned response by matching the SQL text.
function runQuery(sql: string) {
  if (fatalNextQuery && sql.includes(fatalNextQuery)) {
    return Promise.reject(new Error("getaddrinfo ENOTFOUND duck.host"));
  }
  if (sql.includes("information_schema.tables")) {
    return reader([
      { name: "events", type: "table" },
      { name: "daily_report", type: "view" },
    ]);
  }
  if (sql.includes("information_schema.columns")) {
    return reader([
      { column_name: "id", data_type: "BIGINT", is_nullable: "NO" },
      { column_name: "status", data_type: "VARCHAR", is_nullable: "YES" },
    ]);
  }
  // unique/null stats: COUNT(DISTINCT ...) as u, ... as n
  if (sql.includes("COUNT(DISTINCT")) {
    // status: low cardinality → enum-like; id: leave it non-enum by high unique.
    if (sql.includes('"status"')) return reader([{ u: 2, n: 0 }]);
    return reader([{ u: 100, n: 0 }]);
  }
  if (sql.includes("DISTINCT CAST")) {
    if (sql.includes('"status"')) return reader([{ v: "active" }, { v: "churned" }]);
    return reader([{ v: "1" }, { v: "2" }]);
  }
  if (sql.includes("COUNT(*)")) {
    return reader([{ c: 100 }]);
  }
  return reader([]);
}

const mockRunAndReadAll = mock((sql: string) => runQuery(sql));
const mockDisconnectSync = mock(() => {});
const mockCloseSync = mock(() => {});
const mockConnect = mock(() =>
  Promise.resolve({ runAndReadAll: mockRunAndReadAll, disconnectSync: mockDisconnectSync }),
);
const mockCreate = mock((_path: string, opts?: Record<string, string>) => {
  seenCreateOpts.push(opts);
  return Promise.resolve({ connect: mockConnect, closeSync: mockCloseSync });
});

mock.module("@duckdb/node-api", () => ({ DuckDBInstance: { create: mockCreate } }));

import { listDuckDBObjects, profileDuckDB } from "../src/profiler";

const URL = "duckdb:///data/analytics.duckdb";

beforeEach(() => {
  mockRunAndReadAll.mockClear();
  mockDisconnectSync.mockClear();
  mockCloseSync.mockClear();
  mockConnect.mockClear();
  mockCreate.mockClear();
  seenCreateOpts.length = 0;
  fatalNextQuery = null;

  mockRunAndReadAll.mockImplementation((sql: string) => runQuery(sql));
  mockConnect.mockImplementation(() =>
    Promise.resolve({ runAndReadAll: mockRunAndReadAll, disconnectSync: mockDisconnectSync }),
  );
  mockCreate.mockImplementation((_path: string, opts?: Record<string, string>) => {
    seenCreateOpts.push(opts);
    return Promise.resolve({ connect: mockConnect, closeSync: mockCloseSync });
  });
});

describe("listDuckDBObjects", () => {
  test("enumerates tables and views, mapping table_type → object type", async () => {
    const objects = await listDuckDBObjects({ url: URL });
    expect(objects).toEqual([
      { name: "events", type: "table" },
      { name: "daily_report", type: "view" },
    ]);
    expect(mockDisconnectSync).toHaveBeenCalledTimes(1);
    expect(mockCloseSync).toHaveBeenCalledTimes(1);
  });

  test("opens a file database read-only", async () => {
    await listDuckDBObjects({ url: URL });
    expect(seenCreateOpts.length).toBeGreaterThan(0);
    expect(seenCreateOpts.every((o) => o?.access_mode === "READ_ONLY")).toBe(true);
  });
});

describe("profileDuckDB", () => {
  test("profiles columns, types, enum-like sample values; no PK/FK", async () => {
    const result = await profileDuckDB({ url: URL, selectedTables: ["events"] });
    expect(result.errors).toEqual([]);
    expect(result.profiles).toHaveLength(1);

    const events = result.profiles[0];
    expect(events.table_name).toBe("events");
    expect(events.object_type).toBe("table");
    expect(events.row_count).toBe(100);
    // DuckDB enforces neither PKs nor FKs on loaded data.
    expect(events.primary_key_columns).toEqual([]);
    expect(events.foreign_keys).toEqual([]);

    const idCol = events.columns.find((c) => c.name === "id");
    expect(idCol?.type).toBe("BIGINT");
    expect(idCol?.nullable).toBe(false);
    expect(idCol?.is_primary_key).toBe(false);
    expect(idCol?.is_enum_like).toBe(false);

    const statusCol = events.columns.find((c) => c.name === "status");
    expect(statusCol?.nullable).toBe(true);
    expect(statusCol?.is_enum_like).toBe(true);
    expect(statusCol?.sample_values).toEqual(["active", "churned"]);
    expect(events.columns.every((c) => c.is_foreign_key === false)).toBe(true);
  });

  test("every connection is opened read-only (access_mode: READ_ONLY)", async () => {
    await profileDuckDB({ url: URL, selectedTables: ["events"] });
    expect(seenCreateOpts.length).toBeGreaterThan(0);
    expect(seenCreateOpts.every((o) => o?.access_mode === "READ_ONLY")).toBe(true);
  });

  test("honors prefetchedObjects (no second catalog round-trip)", async () => {
    const result = await profileDuckDB({
      url: URL,
      prefetchedObjects: [{ name: "events", type: "table" }],
    });
    expect(result.profiles).toHaveLength(1);
    expect(
      mockRunAndReadAll.mock.calls.some((c) => c[0].includes("information_schema.tables")),
    ).toBe(false);
  });

  test("empty schema yields no profiles and no errors", async () => {
    mockRunAndReadAll.mockImplementation((sql: string) => {
      if (sql.includes("information_schema.tables")) return reader([]);
      return runQuery(sql);
    });
    const result = await profileDuckDB({ url: URL });
    expect(result.profiles).toEqual([]);
    expect(result.errors).toEqual([]);
    // Connection still closed on the empty path.
    expect(mockDisconnectSync).toHaveBeenCalled();
    expect(mockCloseSync).toHaveBeenCalled();
  });

  test("records a per-table error instead of throwing on a non-fatal failure", async () => {
    mockRunAndReadAll.mockImplementation((sql: string) => {
      if (sql.includes("COUNT(*)")) {
        return Promise.reject(new Error("Catalog Error: Table does not exist"));
      }
      return runQuery(sql);
    });
    const result = await profileDuckDB({
      url: URL,
      prefetchedObjects: [{ name: "events", type: "table" }],
    });
    expect(result.profiles).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].table).toBe("events");
    expect(result.errors[0].error).toContain("Table does not exist");
  });

  test("aborts on a fatal connection error", async () => {
    fatalNextQuery = "COUNT(*)";
    await expect(
      profileDuckDB({ url: URL, prefetchedObjects: [{ name: "events", type: "table" }] }),
    ).rejects.toThrow(/Fatal database error/);
    // Connection is still closed on the abort path.
    expect(mockDisconnectSync).toHaveBeenCalled();
    expect(mockCloseSync).toHaveBeenCalled();
  });
});
