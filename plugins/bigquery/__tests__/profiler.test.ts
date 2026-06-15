/**
 * BigQuery introspection (ADR-0017) — `listObjects` / `profile` against a
 * mocked @google-cloud/bigquery. Asserts external behavior through the
 * contract: the right objects/profiles come back, structure is read from
 * INFORMATION_SCHEMA metadata, sampling stays LIMIT-bounded (never a full
 * scan), a per-table failure is recorded (not thrown), and a fatal connection
 * error aborts. Mirrors the ClickHouse profiler test.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// The BigQuery client's `query()` returns the tuple [rows, nextQuery, apiResponse].
// Our connection layer reads rows by property name, so only the first element
// (the rows array) and the apiResponse schema (for column names) matter here.
function respond(rows: Record<string, unknown>[], fields: { name: string }[] = []) {
  return Promise.resolve([rows, null, { schema: { fields } }]);
}

/** SQL routed to a canned response by matching its text. */
const seenQueries: string[] = [];
let fatalNextQuery: string | null = null;
let throwOnSample: string | null = null;
let omitTableStorage = false;

const mockQuery = mock((opts: { query: string }) => {
  const sql = opts.query;
  seenQueries.push(sql);
  if (fatalNextQuery && sql.includes(fatalNextQuery)) {
    return Promise.reject(new Error("getaddrinfo ENOTFOUND bigquery.googleapis.com"));
  }
  if (throwOnSample && sql.includes(throwOnSample) && sql.includes("LIMIT 100")) {
    return Promise.reject(new Error("Access Denied: view read failed"));
  }
  if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
    return respond(
      [
        { table_name: "events", table_type: "BASE TABLE" },
        { table_name: "daily_report", table_type: "VIEW" },
      ],
      [{ name: "table_name" }, { name: "table_type" }],
    );
  }
  if (sql.includes("INFORMATION_SCHEMA.TABLE_STORAGE")) {
    if (omitTableStorage) {
      return Promise.reject(new Error("Permission bigquery.tables.get denied"));
    }
    return respond(
      [
        { table_name: "events", total_rows: 1000 },
        { table_name: "daily_report", total_rows: 50 },
      ],
      [{ name: "table_name" }, { name: "total_rows" }],
    );
  }
  if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
    if (sql.includes("daily_report")) {
      return respond(
        [{ column_name: "day", data_type: "DATE", is_nullable: "YES" }],
        [{ name: "column_name" }, { name: "data_type" }, { name: "is_nullable" }],
      );
    }
    return respond(
      [
        { column_name: "id", data_type: "INT64", is_nullable: "NO" },
        { column_name: "status", data_type: "STRING", is_nullable: "YES" },
      ],
      [{ name: "column_name" }, { name: "data_type" }, { name: "is_nullable" }],
    );
  }
  if (sql.includes("LIMIT 100")) {
    // The single bounded sample read shared across all columns.
    if (sql.includes("daily_report")) {
      return respond([{ day: "2026-01-01" }, { day: "2026-01-02" }], [{ name: "day" }]);
    }
    return respond(
      [
        { id: 1, status: "active" },
        { id: 2, status: "churned" },
        { id: 3, status: "active" },
      ],
      [{ name: "id" }, { name: "status" }],
    );
  }
  // SELECT 1 / fallthrough.
  return respond([], []);
});

const mockBigQuery = mock(() => ({ query: mockQuery }));

mock.module("@google-cloud/bigquery", () => ({ BigQuery: mockBigQuery }));

import { listBigQueryObjects, profileBigQuery } from "../src/profiler";

const URL = "bigquery://US@my-project/analytics";

beforeEach(() => {
  mockQuery.mockClear();
  mockBigQuery.mockClear();
  seenQueries.length = 0;
  fatalNextQuery = null;
  throwOnSample = null;
  omitTableStorage = false;
});

describe("listBigQueryObjects", () => {
  test("enumerates tables and views, mapping table_type → object type", async () => {
    const objects = await listBigQueryObjects({ url: URL });
    expect(objects).toEqual([
      { name: "events", type: "table" },
      { name: "daily_report", type: "view" },
    ]);
  });

  test("reads structure from INFORMATION_SCHEMA (no table scan)", async () => {
    await listBigQueryObjects({ url: URL });
    expect(seenQueries.some((q) => q.includes("INFORMATION_SCHEMA.TABLES"))).toBe(true);
    // listObjects must never read table data.
    expect(seenQueries.some((q) => q.includes("LIMIT"))).toBe(false);
  });

  test("requires a dataset (URL or schema option)", async () => {
    await expect(listBigQueryObjects({ url: "bigquery://my-project" })).rejects.toThrow(
      /requires a dataset/,
    );
  });
});

describe("profileBigQuery", () => {
  test("profiles a dataset with both a table and a view", async () => {
    const result = await profileBigQuery({ url: URL });
    expect(result.errors).toEqual([]);
    expect(result.profiles).toHaveLength(2);

    const events = result.profiles.find((p) => p.table_name === "events");
    expect(events?.object_type).toBe("table");
    expect(events?.row_count).toBe(1000);

    const view = result.profiles.find((p) => p.table_name === "daily_report");
    expect(view?.object_type).toBe("view");
    expect(view?.row_count).toBe(50);
  });

  test("captures column types, sample values, and enum-like heuristics", async () => {
    const result = await profileBigQuery({ url: URL, selectedTables: ["events"] });
    expect(result.profiles).toHaveLength(1);
    const events = result.profiles[0];

    const idCol = events.columns.find((c) => c.name === "id");
    expect(idCol?.type).toBe("INT64");
    expect(idCol?.nullable).toBe(false);
    expect(idCol?.is_enum_like).toBe(false);

    const statusCol = events.columns.find((c) => c.name === "status");
    expect(statusCol?.type).toBe("STRING");
    expect(statusCol?.nullable).toBe(true);
    expect(statusCol?.is_enum_like).toBe(true);
    expect(statusCol?.sample_values).toEqual(["active", "churned"]);
    // BigQuery has no enforced PK/FK.
    expect(events.columns.every((c) => c.is_foreign_key === false)).toBe(true);
    expect(events.primary_key_columns).toEqual([]);
  });

  test("samples a base table with TABLESAMPLE — bytes-bounded, no full scan, no COUNT/DISTINCT", async () => {
    await profileBigQuery({ url: URL, selectedTables: ["events"] });
    // Every data-read of the table is bounded.
    const dataReads = seenQueries.filter(
      (q) => q.includes("`events`") && !q.includes("INFORMATION_SCHEMA"),
    );
    expect(dataReads.length).toBeGreaterThan(0);
    expect(dataReads.every((q) => q.includes("LIMIT"))).toBe(true);
    // A bare `LIMIT` does NOT bound BigQuery bytes billed — base-table sampling
    // MUST use TABLESAMPLE so only sampled storage blocks are scanned/billed.
    expect(dataReads.every((q) => /TABLESAMPLE\s+SYSTEM/i.test(q))).toBe(true);
    // No scanning aggregates anywhere.
    expect(seenQueries.some((q) => /COUNT\s*\(/i.test(q))).toBe(false);
    expect(seenQueries.some((q) => /DISTINCT/i.test(q))).toBe(false);
    // Row counts come from metadata, not a scan.
    expect(seenQueries.some((q) => q.includes("INFORMATION_SCHEMA.TABLE_STORAGE"))).toBe(true);
  });

  test("samples a view with a plain LIMIT — TABLESAMPLE is invalid on views", async () => {
    await profileBigQuery({ url: URL, selectedTables: ["daily_report"] });
    const dataReads = seenQueries.filter(
      (q) => q.includes("`daily_report`") && !q.includes("INFORMATION_SCHEMA"),
    );
    expect(dataReads.length).toBeGreaterThan(0);
    expect(dataReads.every((q) => q.includes("LIMIT"))).toBe(true);
    // BigQuery rejects TABLESAMPLE on a view, so the view sample must not use it.
    expect(dataReads.some((q) => /TABLESAMPLE/i.test(q))).toBe(false);
  });

  test("handles an empty dataset (no objects)", async () => {
    const result = await profileBigQuery({
      url: URL,
      prefetchedObjects: [],
    });
    expect(result.profiles).toEqual([]);
    expect(result.errors).toEqual([]);
    // No table-storage / sample reads when there is nothing to profile.
    expect(seenQueries.some((q) => q.includes("INFORMATION_SCHEMA.TABLE_STORAGE"))).toBe(false);
  });

  test("honors prefetchedObjects (no second catalog round-trip)", async () => {
    const result = await profileBigQuery({
      url: URL,
      prefetchedObjects: [{ name: "events", type: "table" }],
    });
    expect(result.profiles).toHaveLength(1);
    expect(seenQueries.some((q) => q.includes("INFORMATION_SCHEMA.TABLES"))).toBe(false);
  });

  test("degrades gracefully when TABLE_STORAGE metadata is unavailable", async () => {
    omitTableStorage = true;
    const result = await profileBigQuery({
      url: URL,
      prefetchedObjects: [{ name: "events", type: "table" }],
    });
    // Still profiles — row count falls back to 0 rather than failing the table.
    expect(result.errors).toEqual([]);
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].row_count).toBe(0);
  });

  test("records a per-table error instead of throwing on a non-fatal failure", async () => {
    throwOnSample = "`events`";
    const result = await profileBigQuery({
      url: URL,
      prefetchedObjects: [{ name: "events", type: "table" }],
    });
    // The sample read fails non-fatally — columns still emit (metadata only),
    // so the table is profiled with no sample values rather than erroring.
    expect(result.errors).toEqual([]);
    expect(result.profiles).toHaveLength(1);
    const statusCol = result.profiles[0].columns.find((c) => c.name === "status");
    expect(statusCol?.sample_values).toEqual([]);
  });

  test("records a per-table error when column metadata fails non-fatally", async () => {
    const failing = mock((opts: { query: string }) => {
      if (opts.query.includes("INFORMATION_SCHEMA.COLUMNS")) {
        return Promise.reject(new Error("Not found: Table events"));
      }
      return mockQuery(opts);
    });
    mockBigQuery.mockImplementationOnce(() => ({ query: failing }));

    const result = await profileBigQuery({
      url: URL,
      prefetchedObjects: [{ name: "events", type: "table" }],
    });
    expect(result.profiles).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].table).toBe("events");
    expect(result.errors[0].error).toContain("Not found");
  });

  test("aborts on a fatal connection error", async () => {
    fatalNextQuery = "INFORMATION_SCHEMA.COLUMNS";
    await expect(
      profileBigQuery({ url: URL, prefetchedObjects: [{ name: "events", type: "table" }] }),
    ).rejects.toThrow(/Fatal database error/);
  });

  test("never surfaces credentials in errors", async () => {
    // The bigquery:// URL carries no credentials, and the wrapped error message
    // contains only the BigQuery client's own message — assert it stays clean.
    fatalNextQuery = "INFORMATION_SCHEMA.COLUMNS";
    let thrown: unknown;
    try {
      await profileBigQuery({
        url: "bigquery://my-project/analytics?keyFilename=/secrets/key.json",
        prefetchedObjects: [{ name: "events", type: "table" }],
      });
    } catch (err) {
      thrown = err;
    }
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    expect(msg).not.toContain("/secrets/key.json");
  });
});

// The registry/MCP seam (#3664): BigQuery is non-url-shaped, so the host carries
// the datasource's DECRYPTED config (service_account_json + project_id + the
// generic `schema` routing hint) and the profiler authenticates from it — the
// tenant's own service-account creds, never operator env (the per-tenant-creds
// rule), mirroring the Elasticsearch amendment. The url is a synthetic
// identifier only; credentials NEVER ride on it.
describe("config-based credential resolution (#3664)", () => {
  const SERVICE_ACCOUNT = JSON.stringify({
    type: "service_account",
    project_id: "my-project",
    private_key: "-----BEGIN PRIVATE KEY-----\\nXXX\\n-----END PRIVATE KEY-----\\n",
    client_email: "sa@my-project.iam.gserviceaccount.com",
  });

  test("builds the BigQuery client from options.config (parsed service account creds + project)", async () => {
    const result = await profileBigQuery({
      url: "bigquery://my-project", // synthetic identifier — carries no creds
      config: {
        service_account_json: SERVICE_ACCOUNT,
        project_id: "my-project",
        schema: "analytics",
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.profiles).toHaveLength(2);

    // The client was constructed with the tenant's parsed service-account
    // credentials and project — not from the url.
    const clientOpts = (mockBigQuery.mock.calls.at(-1) as unknown[] | undefined)?.[0] as {
      projectId?: string;
      credentials?: Record<string, unknown>;
    };
    expect(clientOpts.projectId).toBe("my-project");
    expect(clientOpts.credentials).toMatchObject({
      type: "service_account",
      client_email: "sa@my-project.iam.gserviceaccount.com",
    });
  });

  test("resolves the dataset from the config `schema` routing hint when no schema option is passed", async () => {
    await profileBigQuery({
      url: "bigquery://my-project",
      config: { service_account_json: SERVICE_ACCOUNT, project_id: "my-project", schema: "analytics" },
    });
    // INFORMATION_SCHEMA queries are scoped to the `analytics` dataset.
    expect(seenQueries.some((q) => q.includes("analytics") && q.includes("INFORMATION_SCHEMA"))).toBe(
      true,
    );
  });

  test("the schema OPTION still wins over the config dataset", async () => {
    await profileBigQuery({
      url: "bigquery://my-project",
      schema: "override_ds",
      config: { service_account_json: SERVICE_ACCOUNT, project_id: "my-project", schema: "analytics" },
    });
    expect(seenQueries.some((q) => q.includes("override_ds") && q.includes("INFORMATION_SCHEMA"))).toBe(
      true,
    );
  });

  test("throws an actionable error when service_account_json is not valid JSON", async () => {
    await expect(
      profileBigQuery({
        url: "bigquery://my-project",
        config: { service_account_json: "{not json", project_id: "my-project", schema: "analytics" },
      }),
    ).rejects.toThrow(/service_account_json is not valid JSON/);
  });

  test("listBigQueryObjects also authenticates from options.config", async () => {
    const objects = await listBigQueryObjects({
      url: "bigquery://my-project",
      config: { service_account_json: SERVICE_ACCOUNT, project_id: "my-project", schema: "analytics" },
    });
    expect(objects.map((o) => o.name)).toEqual(["events", "daily_report"]);
    const clientOpts = (mockBigQuery.mock.calls.at(-1) as unknown[] | undefined)?.[0] as {
      credentials?: unknown;
    };
    expect(clientOpts.credentials).toBeDefined();
  });
});
