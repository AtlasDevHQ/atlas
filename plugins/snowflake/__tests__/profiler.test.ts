/**
 * Snowflake introspection (ADR-0017, #3622) — `listObjects` / `profile` against
 * a mocked snowflake-sdk. Asserts external behavior through the contract: the
 * right objects/profiles come back (column types, sample values, PKs, FKs,
 * enum-like heuristics), an empty schema profiles cleanly, a per-table failure
 * is recorded (not thrown) while a fatal connection error aborts, and the
 * read-only posture holds (every connection runs through the `atlas:readonly`
 * QUERY_TAG + statement-timeout path; only SELECT/INFORMATION_SCHEMA/SHOW
 * statements are issued).
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Route each profiler query (the 3rd execute() of every conn.query — the first
// two are the timeout + QUERY_TAG ALTER SESSION statements) to a canned response
// by matching the SQL text. Returns rows keyed by property name; the connection
// layer maps stmt.getColumns() → columns, which the profiler ignores.
type SfRow = Record<string, unknown>;

// Every executed statement is recorded so tests can assert the read-only posture
// (timeout + QUERY_TAG) and that no mutating statement is ever issued.
const executedSql: string[] = [];

let respondTo: (sql: string) => SfRow[] = () => [];
let failOnSql: { match: string; error: Error } | null = null;

const mockExecute = mock(
  (opts: {
    sqlText: string;
    complete: (err: unknown, stmt?: unknown, rows?: unknown) => void;
  }) => {
    const sql = opts.sqlText;
    executedSql.push(sql);
    if (sql.startsWith("ALTER SESSION")) {
      opts.complete(null, { getColumns: () => [] }, []);
      return;
    }
    if (failOnSql && sql.includes(failOnSql.match)) {
      opts.complete(failOnSql.error);
      return;
    }
    const rows = respondTo(sql);
    opts.complete(null, { getColumns: () => [] }, rows);
  },
);
const mockConn = { execute: mockExecute };
const mockPoolUse = mock(async (fn: (conn: unknown) => unknown) => fn(mockConn));
const mockPoolDrain = mock(() => Promise.resolve());
const mockPoolClear = mock(() => Promise.resolve());
const mockCreatePool = mock(() => ({
  use: mockPoolUse,
  drain: mockPoolDrain,
  clear: mockPoolClear,
}));
const mockConfigure = mock(() => {});

void mock.module("snowflake-sdk", () => ({
  createPool: mockCreatePool,
  configure: mockConfigure,
}));

import { listSnowflakeObjects, profileSnowflake } from "../src/profiler";

const URL = "snowflake://admin:s3cret@xy12345/analytics/public?warehouse=WH";

/**
 * Default catalog for the happy-path table `events`: one PK column, one FK, two
 * columns (a numeric `id` PK and an enum-like text `status`), 100 rows, 3
 * distinct statuses (enum-like: 3 < 20 and 3/100 <= 0.05).
 */
function defaultResponder(sql: string): SfRow[] {
  if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
    return [
      { TABLE_NAME: "events", TABLE_TYPE: "BASE TABLE" },
      { TABLE_NAME: "daily_report", TABLE_TYPE: "VIEW" },
    ];
  }
  if (sql.startsWith("SHOW PRIMARY KEYS")) {
    return [{ column_name: "id" }];
  }
  if (sql.startsWith("SHOW IMPORTED KEYS")) {
    return [
      {
        fk_column_name: "id",
        pk_table_name: "accounts",
        pk_column_name: "account_id",
      },
    ];
  }
  if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
    return [
      { COLUMN_NAME: "id", DATA_TYPE: "NUMBER", IS_NULLABLE: "NO" },
      { COLUMN_NAME: "status", DATA_TYPE: "VARCHAR", IS_NULLABLE: "YES" },
    ];
  }
  // Bulk stats query: COUNT(*) + per-column distinct/null counts.
  if (sql.includes('as "RC"') && sql.includes('as "U0"')) {
    return [{ RC: 100, U0: 100, N0: 0, U1: 3, N1: 2 }];
  }
  // Bare row-count fallback.
  if (sql.includes('as "RC"')) {
    return [{ RC: 100 }];
  }
  // Batched sample values (UNION ALL of per-column DISTINCT).
  if (sql.includes('as "CN"')) {
    return [
      { CN: "status", V: "active" },
      { CN: "status", V: "churned" },
      { CN: "status", V: "trial" },
    ];
  }
  return [];
}

beforeEach(() => {
  mockExecute.mockClear();
  mockPoolUse.mockClear();
  mockPoolDrain.mockClear();
  mockPoolClear.mockClear();
  mockCreatePool.mockClear();
  executedSql.length = 0;
  respondTo = defaultResponder;
  failOnSql = null;
});

describe("listSnowflakeObjects", () => {
  test("enumerates tables and views, mapping TABLE_TYPE → object type", async () => {
    const objects = await listSnowflakeObjects({ url: URL });
    expect(objects).toEqual([
      { name: "events", type: "table" },
      { name: "daily_report", type: "view" },
    ]);
    // Pool drained + cleared on close.
    expect(mockPoolDrain).toHaveBeenCalledTimes(1);
    expect(mockPoolClear).toHaveBeenCalledTimes(1);
  });

  test("queries INFORMATION_SCHEMA.TABLES (read-only catalog)", async () => {
    await listSnowflakeObjects({ url: URL });
    expect(
      executedSql.some((s) => s.includes("INFORMATION_SCHEMA.TABLES")),
    ).toBe(true);
  });
});

describe("profileSnowflake", () => {
  test("profiles columns, PKs, FKs, and enum-like sample values", async () => {
    const result = await profileSnowflake({ url: URL, selectedTables: ["events"] });
    expect(result.errors).toEqual([]);
    expect(result.profiles).toHaveLength(1);

    const events = result.profiles[0];
    expect(events.table_name).toBe("events");
    expect(events.object_type).toBe("table");
    expect(events.row_count).toBe(100);
    expect(events.primary_key_columns).toEqual(["id"]);
    expect(events.foreign_keys).toEqual([
      {
        from_column: "id",
        to_table: "accounts",
        to_column: "account_id",
        source: "constraint",
      },
    ]);

    const idCol = events.columns.find((c) => c.name === "id");
    expect(idCol?.type).toBe("NUMBER");
    expect(idCol?.is_primary_key).toBe(true);
    expect(idCol?.is_foreign_key).toBe(true);
    expect(idCol?.fk_target_table).toBe("accounts");
    expect(idCol?.fk_target_column).toBe("account_id");
    expect(idCol?.nullable).toBe(false);
    expect(idCol?.unique_count).toBe(100);
    expect(idCol?.null_count).toBe(0);

    const statusCol = events.columns.find((c) => c.name === "status");
    expect(statusCol?.type).toBe("VARCHAR");
    expect(statusCol?.nullable).toBe(true);
    expect(statusCol?.is_enum_like).toBe(true);
    expect(statusCol?.unique_count).toBe(3);
    expect(statusCol?.null_count).toBe(2);
    expect(statusCol?.sample_values).toEqual(["active", "churned", "trial"]);
    expect(statusCol?.is_primary_key).toBe(false);
    expect(statusCol?.is_foreign_key).toBe(false);
  });

  test("every query runs read-only — sets the atlas:readonly QUERY_TAG and a statement timeout", async () => {
    await profileSnowflake({ url: URL, selectedTables: ["events"] });
    expect(
      executedSql.some((s) =>
        s.includes("QUERY_TAG = 'atlas:readonly'"),
      ),
    ).toBe(true);
    expect(
      executedSql.some((s) => s.includes("STATEMENT_TIMEOUT_IN_SECONDS")),
    ).toBe(true);
    // No mutating statement is ever issued — only SELECT / INFORMATION_SCHEMA /
    // SHOW (plus the two read-only-posture ALTER SESSION settings).
    const mutating =
      /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|MERGE|CREATE|GRANT)\b/i;
    const nonAlter = executedSql.filter((s) => !s.startsWith("ALTER SESSION"));
    expect(nonAlter.every((s) => !mutating.test(s))).toBe(true);
  });

  test("honors prefetchedObjects (no second catalog round-trip)", async () => {
    const result = await profileSnowflake({
      url: URL,
      prefetchedObjects: [{ name: "events", type: "table" }],
    });
    expect(result.profiles).toHaveLength(1);
    expect(
      executedSql.some((s) => s.includes("INFORMATION_SCHEMA.TABLES")),
    ).toBe(false);
  });

  test("skips PK/FK introspection for views", async () => {
    respondTo = (sql) => {
      if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
        return [{ COLUMN_NAME: "day", DATA_TYPE: "DATE", IS_NULLABLE: "YES" }];
      }
      if (sql.includes('as "RC"')) return [{ RC: 0, U0: 0, N0: 0 }];
      return [];
    };
    const result = await profileSnowflake({
      url: URL,
      prefetchedObjects: [{ name: "daily_report", type: "view" }],
    });
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].object_type).toBe("view");
    expect(result.profiles[0].primary_key_columns).toEqual([]);
    expect(result.profiles[0].foreign_keys).toEqual([]);
    // No SHOW PRIMARY KEYS / SHOW IMPORTED KEYS for a view.
    expect(executedSql.some((s) => s.startsWith("SHOW PRIMARY KEYS"))).toBe(false);
    expect(executedSql.some((s) => s.startsWith("SHOW IMPORTED KEYS"))).toBe(false);
  });

  test("empty schema profiles cleanly (no objects, no errors)", async () => {
    respondTo = (sql) => {
      if (sql.includes("INFORMATION_SCHEMA.TABLES")) return [];
      return [];
    };
    const result = await profileSnowflake({ url: URL });
    expect(result.profiles).toEqual([]);
    expect(result.errors).toEqual([]);
    // Connection still closed.
    expect(mockPoolDrain).toHaveBeenCalled();
  });

  test("a table with zero columns profiles via the bare row-count fallback", async () => {
    respondTo = (sql) => {
      if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) return [];
      if (sql.includes('as "RC"')) return [{ RC: 0 }];
      if (sql.startsWith("SHOW")) return [];
      return [];
    };
    const result = await profileSnowflake({
      url: URL,
      prefetchedObjects: [{ name: "empty_tbl", type: "table" }],
    });
    expect(result.errors).toEqual([]);
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].columns).toEqual([]);
    expect(result.profiles[0].row_count).toBe(0);
  });

  test("records a per-table error instead of throwing on a non-fatal failure", async () => {
    failOnSql = {
      match: "INFORMATION_SCHEMA.COLUMNS",
      error: new Error("Object does not exist or not authorized"),
    };
    const result = await profileSnowflake({
      url: URL,
      prefetchedObjects: [{ name: "events", type: "table" }],
    });
    expect(result.profiles).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].table).toBe("events");
    expect(result.errors[0].error).toContain("Object does not exist");
  });

  test("non-fatal PK read failure does not fail the table", async () => {
    failOnSql = {
      match: "SHOW PRIMARY KEYS",
      error: new Error("insufficient privileges"),
    };
    const result = await profileSnowflake({
      url: URL,
      prefetchedObjects: [{ name: "events", type: "table" }],
    });
    expect(result.errors).toEqual([]);
    expect(result.profiles).toHaveLength(1);
    // PK hints absent, but the table still profiled.
    expect(result.profiles[0].primary_key_columns).toEqual([]);
  });

  test("aborts on a fatal connection error (network)", async () => {
    failOnSql = {
      match: "INFORMATION_SCHEMA.COLUMNS",
      error: new Error("getaddrinfo ENOTFOUND xy12345"),
    };
    await expect(
      profileSnowflake({
        url: URL,
        prefetchedObjects: [{ name: "events", type: "table" }],
      }),
    ).rejects.toThrow(/Fatal database error/);
    // Connection still closed on the abort path.
    expect(mockPoolDrain).toHaveBeenCalled();
  });

  test("aborts on a fatal Snowflake auth-token error code", async () => {
    failOnSql = {
      match: "INFORMATION_SCHEMA.COLUMNS",
      error: new Error("390114: Authentication token has expired"),
    };
    await expect(
      profileSnowflake({
        url: URL,
        prefetchedObjects: [{ name: "events", type: "table" }],
      }),
    ).rejects.toThrow(/Fatal database error/);
  });

  test("error messages never leak the connection URL or credentials", async () => {
    failOnSql = {
      match: "INFORMATION_SCHEMA.COLUMNS",
      error: new Error("SQL compilation error near token"),
    };
    const result = await profileSnowflake({
      url: URL,
      prefetchedObjects: [{ name: "events", type: "table" }],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).not.toContain("s3cret");
    expect(result.errors[0].error).not.toContain("admin");
    expect(result.errors[0].error).not.toContain("xy12345");
  });
});
