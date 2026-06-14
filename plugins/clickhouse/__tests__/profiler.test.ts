/**
 * ClickHouse introspection (ADR-0017) — `listObjects` / `profile` against a
 * mocked @clickhouse/client. Asserts external behavior through the contract: the
 * right objects/profiles come back, profiling stays read-only (`readonly: 1` on
 * every query), and a per-table failure is recorded (not thrown) while a fatal
 * connection error aborts.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Route each profiler query to a canned response by matching the SQL text. The
// connection layer maps `json.meta` → columns and `json.data` → rows; the
// profiler reads rows by property name, so only `data` keys matter here.
function respond(data: Record<string, unknown>[], meta: { name: string }[] = []) {
  return Promise.resolve({ json: () => Promise.resolve({ meta, data }) });
}

const seenSettings: Array<Record<string, unknown> | undefined> = [];
let fatalNextQuery: string | null = null;

const mockQuery = mock((opts: { query: string; clickhouse_settings?: Record<string, unknown> }) => {
  seenSettings.push(opts.clickhouse_settings);
  const sql = opts.query;
  if (fatalNextQuery && sql.includes(fatalNextQuery)) {
    return Promise.reject(new Error("getaddrinfo ENOTFOUND ch.prod"));
  }
  if (sql.includes("system.tables")) {
    return respond(
      [
        { name: "events", engine: "MergeTree" },
        { name: "daily_report", engine: "View" },
      ],
      [{ name: "name" }, { name: "engine" }],
    );
  }
  if (sql.includes("is_in_primary_key")) {
    return respond([{ name: "id" }], [{ name: "name" }]);
  }
  if (sql.includes("FROM system.columns") && sql.includes("ORDER BY position")) {
    return respond(
      [
        { name: "id", type: "UInt64", comment: "" },
        { name: "status", type: "LowCardinality(String)", comment: "lifecycle" },
      ],
      [{ name: "name" }, { name: "type" }, { name: "comment" }],
    );
  }
  if (sql.includes("uniqExact")) {
    return respond([{ c: 3 }], [{ name: "c" }]);
  }
  if (sql.includes("IS NULL")) {
    return respond([{ c: 0 }], [{ name: "c" }]);
  }
  if (sql.includes("DISTINCT")) {
    return respond([{ v: "active" }, { v: "churned" }], [{ name: "v" }]);
  }
  if (sql.includes("count()")) {
    return respond([{ c: 100 }], [{ name: "c" }]);
  }
  return respond([], []);
});
const mockClose = mock(() => Promise.resolve());
const mockCreateClient = mock(() => ({ query: mockQuery, close: mockClose }));

mock.module("@clickhouse/client", () => ({ createClient: mockCreateClient }));

import { listClickHouseObjects, profileClickHouse } from "../src/profiler";

const URL = "clickhouse://admin:s3cret@ch.prod:8123/analytics";

beforeEach(() => {
  mockQuery.mockClear();
  mockClose.mockClear();
  seenSettings.length = 0;
  fatalNextQuery = null;
});

describe("listClickHouseObjects", () => {
  test("enumerates tables and views, mapping engine → object type", async () => {
    const objects = await listClickHouseObjects({ url: URL });
    expect(objects).toEqual([
      { name: "events", type: "table" },
      { name: "daily_report", type: "view" },
    ]);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});

describe("profileClickHouse", () => {
  test("profiles columns, PKs, and enum-like sample values", async () => {
    const result = await profileClickHouse({ url: URL, selectedTables: ["events"] });
    expect(result.errors).toEqual([]);
    expect(result.profiles).toHaveLength(1);

    const events = result.profiles[0];
    expect(events.table_name).toBe("events");
    expect(events.object_type).toBe("table");
    expect(events.row_count).toBe(100);
    expect(events.primary_key_columns).toEqual(["id"]);

    const idCol = events.columns.find((c) => c.name === "id");
    expect(idCol?.is_primary_key).toBe(true);
    const statusCol = events.columns.find((c) => c.name === "status");
    expect(statusCol?.is_enum_like).toBe(true);
    expect(statusCol?.sample_values).toEqual(["active", "churned"]);
    expect(statusCol?.profiler_notes).toContain("Column comment: lifecycle");
    // ClickHouse has no foreign keys.
    expect(events.columns.every((c) => c.is_foreign_key === false)).toBe(true);
  });

  test("every query runs read-only (readonly: 1)", async () => {
    await profileClickHouse({ url: URL, selectedTables: ["events"] });
    expect(seenSettings.length).toBeGreaterThan(0);
    expect(seenSettings.every((s) => s?.readonly === 1)).toBe(true);
  });

  test("honors prefetchedObjects (no second catalog round-trip)", async () => {
    const result = await profileClickHouse({
      url: URL,
      prefetchedObjects: [{ name: "events", type: "table" }],
    });
    expect(result.profiles).toHaveLength(1);
    expect(mockQuery.mock.calls.some((c) => c[0].query.includes("system.tables"))).toBe(false);
  });

  test("records a per-table error instead of throwing on a non-fatal failure", async () => {
    // A syntax-shaped error on the count query for one table is non-fatal.
    fatalNextQuery = null;
    const failingQuery = mock((opts: { query: string; clickhouse_settings?: Record<string, unknown> }) => {
      if (opts.query.includes("count()")) {
        return Promise.reject(new Error("Unknown table"));
      }
      return mockQuery(opts);
    });
    mockCreateClient.mockImplementationOnce(() => ({ query: failingQuery, close: mockClose }));

    const result = await profileClickHouse({
      url: URL,
      prefetchedObjects: [{ name: "events", type: "table" }],
    });
    expect(result.profiles).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].table).toBe("events");
    expect(result.errors[0].error).toContain("Unknown table");
  });

  test("aborts on a fatal connection error", async () => {
    fatalNextQuery = "count()";
    await expect(
      profileClickHouse({ url: URL, prefetchedObjects: [{ name: "events", type: "table" }] }),
    ).rejects.toThrow(/Fatal database error/);
    // Connection is still closed on the abort path.
    expect(mockClose).toHaveBeenCalled();
  });
});
