import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";

// Mock @google-cloud/bigquery before any imports that use it
const mockQuery = mock(() =>
  Promise.resolve([
    [{ count: 42 }],
    null,
    { schema: { fields: [{ name: "count", type: "INTEGER" }] } },
  ]),
);
const mockCreateQueryJob = mock(() =>
  Promise.resolve([
    { metadata: { status: { state: "DONE" }, statistics: { totalBytesProcessed: "0" } } },
  ]),
);
const mockBigQuery = mock(() => ({
  query: mockQuery,
  createQueryJob: mockCreateQueryJob,
}));

mock.module("@google-cloud/bigquery", () => ({
  BigQuery: mockBigQuery,
}));

import { definePlugin, isDatasourcePlugin } from "@useatlas/plugin-sdk";
import {
  bigqueryPlugin,
  buildBigQueryPlugin,
  extractProjectId,
  BIGQUERY_FORBIDDEN_PATTERNS,
} from "../src/index";
import { createBigQueryConnection } from "../src/connection";

beforeEach(() => {
  mockQuery.mockClear();
  mockCreateQueryJob.mockClear();
  mockBigQuery.mockClear();

  // Re-stub the default return value after clearing
  mockQuery.mockImplementation(() =>
    Promise.resolve([
      [{ count: 42 }],
      null,
      { schema: { fields: [{ name: "count", type: "INTEGER" }] } },
    ]),
  );
  mockCreateQueryJob.mockImplementation(() =>
    Promise.resolve([
      { metadata: { status: { state: "DONE" }, statistics: { totalBytesProcessed: "0" } } },
    ]),
  );
  mockBigQuery.mockImplementation(() => ({
    query: mockQuery,
    createQueryJob: mockCreateQueryJob,
  }));
});

// ---------------------------------------------------------------------------
// extractProjectId (safe logging — no credentials)
// ---------------------------------------------------------------------------

describe("extractProjectId", () => {
  test("returns projectId when provided", () => {
    expect(extractProjectId({ projectId: "my-project" })).toBe("my-project");
  });

  test("returns (default-project) when projectId is omitted", () => {
    expect(extractProjectId({})).toBe("(default-project)");
  });

  test("returns (default-project) when projectId is undefined", () => {
    expect(extractProjectId({ projectId: undefined })).toBe("(default-project)");
  });
});

// ---------------------------------------------------------------------------
// Config validation (via createPlugin factory)
// ---------------------------------------------------------------------------

describe("config validation", () => {
  test("accepts minimal config (ADC mode)", () => {
    const plugin = bigqueryPlugin({});
    expect(plugin.id).toBe("bigquery-datasource");
    expect(plugin.types).toEqual(["datasource"]);
  });

  test("accepts projectId only", () => {
    const plugin = bigqueryPlugin({ projectId: "my-project" });
    expect(plugin.config?.projectId).toBe("my-project");
  });

  test("accepts full config with keyFilename", () => {
    const plugin = bigqueryPlugin({
      projectId: "my-project",
      dataset: "analytics",
      location: "US",
      keyFilename: "/path/to/key.json",
    });
    expect(plugin.config?.projectId).toBe("my-project");
    expect(plugin.config?.dataset).toBe("analytics");
    expect(plugin.config?.location).toBe("US");
    expect(plugin.config?.keyFilename).toBe("/path/to/key.json");
  });

  test("accepts credentials object", () => {
    const creds = { client_email: "sa@project.iam.gserviceaccount.com", private_key: "..." };
    const plugin = bigqueryPlugin({ credentials: creds });
    expect(plugin.config?.credentials).toEqual(creds);
  });

  test("accepts optional dataset field", () => {
    const plugin = bigqueryPlugin({ dataset: "my_dataset" });
    expect(plugin.config?.dataset).toBe("my_dataset");
  });

  test("accepts optional location field", () => {
    const plugin = bigqueryPlugin({ location: "EU" });
    expect(plugin.config?.location).toBe("EU");
  });
});

// ---------------------------------------------------------------------------
// Plugin shape validation (definePlugin + createPlugin)
// ---------------------------------------------------------------------------

describe("plugin shape", () => {
  const validConfig = { projectId: "my-project" };

  test("createPlugin factory returns a valid plugin", () => {
    const plugin = bigqueryPlugin(validConfig);
    expect(plugin.id).toBe("bigquery-datasource");
    expect(plugin.types).toEqual(["datasource"]);
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("BigQuery DataSource");
  });

  test("definePlugin accepts the built plugin", () => {
    const plugin = buildBigQueryPlugin(validConfig);
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isDatasourcePlugin type guard passes", () => {
    const plugin = bigqueryPlugin(validConfig);
    expect(isDatasourcePlugin(plugin)).toBe(true);
  });

  test("connection.dbType is 'bigquery'", () => {
    const plugin = bigqueryPlugin(validConfig);
    expect(plugin.connection.dbType).toBe("bigquery");
  });

  test("connection.parserDialect is 'BigQuery'", () => {
    const plugin = bigqueryPlugin(validConfig);
    expect(plugin.connection.parserDialect).toBe("BigQuery");
  });

  test("connection.forbiddenPatterns is a non-empty RegExp array", () => {
    const plugin = bigqueryPlugin(validConfig);
    const patterns = plugin.connection.forbiddenPatterns as RegExp[];
    expect(Array.isArray(patterns)).toBe(true);
    expect(patterns.length).toBeGreaterThan(0);
    for (const p of patterns) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });

  test("connection.forbiddenPatterns is the BigQuery patterns array", () => {
    const plugin = bigqueryPlugin(validConfig);
    expect(plugin.connection.forbiddenPatterns).toBe(BIGQUERY_FORBIDDEN_PATTERNS);
  });

  test("entities is an empty array", () => {
    const plugin = bigqueryPlugin(validConfig);
    expect(plugin.entities).toEqual([]);
  });

  test("dialect provides BigQuery-specific guidance", () => {
    const plugin = bigqueryPlugin(validConfig);
    expect(plugin.dialect).toContain("BigQuery Standard SQL");
    expect(plugin.dialect).toContain("DATE_TRUNC");
    expect(plugin.dialect).toContain("COUNTIF");
    expect(plugin.dialect).toContain("SAFE_DIVIDE");
    expect(plugin.dialect).toContain("UNNEST");
  });

  test("dialect warns against Legacy SQL", () => {
    const plugin = bigqueryPlugin(validConfig);
    expect(plugin.dialect).toContain("Do not use Legacy SQL");
  });

  test("dialect mentions backtick-quoted identifiers", () => {
    const plugin = bigqueryPlugin(validConfig);
    expect(plugin.dialect).toContain("backtick-quoted");
  });
});

// ---------------------------------------------------------------------------
// Forbidden patterns
// ---------------------------------------------------------------------------

describe("BIGQUERY_FORBIDDEN_PATTERNS", () => {
  test("blocks MERGE statements", () => {
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("MERGE INTO target USING source ON ..."))).toBe(true);
  });

  test("blocks EXPORT DATA", () => {
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("EXPORT DATA OPTIONS(uri='gs://bucket/path') AS SELECT *"))).toBe(true);
  });

  test("blocks scripting keywords (DECLARE, SET, BEGIN, ASSERT, RAISE)", () => {
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("DECLARE x INT64"))).toBe(true);
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("SET x = 1"))).toBe(true);
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("BEGIN SELECT 1; END"))).toBe(true);
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("ASSERT (SELECT COUNT(*) FROM t) > 0"))).toBe(true);
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("RAISE USING MESSAGE = 'error'"))).toBe(true);
  });

  test("does not block normal SELECT queries", () => {
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("SELECT count(*) FROM events"))).toBe(false);
  });

  test("does not false-positive on column names containing forbidden substrings", () => {
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("SELECT merge_status FROM pull_requests"))).toBe(false);
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("SELECT export_date FROM reports"))).toBe(false);
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("SELECT declaration_id FROM filings"))).toBe(false);
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("SELECT settings FROM users"))).toBe(false);
  });

  test("does not block BigQuery-idiomatic functions", () => {
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("SELECT DATE_TRUNC(created_at, MONTH) FROM events"))).toBe(false);
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("SELECT COUNTIF(status = 'active') FROM users"))).toBe(false);
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("SELECT SAFE_DIVIDE(revenue, users) FROM metrics"))).toBe(false);
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("SELECT * FROM UNNEST(array_col)"))).toBe(false);
  });

  test("anchored patterns avoid false positives on data values", () => {
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("SELECT * FROM events WHERE action = 'merge'"))).toBe(false);
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("SELECT * FROM logs WHERE type = 'export data'"))).toBe(false);
  });

  test("patterns are case-insensitive", () => {
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("merge INTO target USING source"))).toBe(true);
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("Export Data OPTIONS()"))).toBe(true);
    expect(BIGQUERY_FORBIDDEN_PATTERNS.some((p) => p.test("Declare x INT64"))).toBe(true);
  });

  test("all entries are RegExp instances", () => {
    for (const pattern of BIGQUERY_FORBIDDEN_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
    }
  });
});

// ---------------------------------------------------------------------------
// Connection factory
// ---------------------------------------------------------------------------

describe("connection factory", () => {
  test("connection.create() returns a PluginDBConnection", () => {
    const plugin = bigqueryPlugin({ projectId: "my-project" });
    const conn = plugin.connection.create();
    expect(typeof conn.query).toBe("function");
    expect(typeof conn.close).toBe("function");
  });

  test("BigQuery constructor receives projectId", () => {
    createBigQueryConnection({ projectId: "my-project" });
    expect(mockBigQuery).toHaveBeenCalledWith({ projectId: "my-project" });
  });

  test("BigQuery constructor receives keyFilename", () => {
    createBigQueryConnection({
      projectId: "my-project",
      keyFilename: "/path/to/key.json",
    });
    expect(mockBigQuery).toHaveBeenCalledWith({
      projectId: "my-project",
      keyFilename: "/path/to/key.json",
    });
  });

  test("BigQuery constructor receives credentials object", () => {
    const creds = { client_email: "sa@proj.iam.gserviceaccount.com", private_key: "pk" };
    createBigQueryConnection({
      projectId: "my-project",
      credentials: creds,
    });
    expect(mockBigQuery).toHaveBeenCalledWith({
      projectId: "my-project",
      credentials: creds,
    });
  });

  test("BigQuery constructor called with empty opts for ADC mode", () => {
    createBigQueryConnection({});
    expect(mockBigQuery).toHaveBeenCalledWith({});
  });

  test("query returns { columns, rows } from schema", async () => {
    const conn = createBigQueryConnection({ projectId: "my-project" });
    const result = await conn.query("SELECT count(*) AS count FROM dataset.table");
    expect(result.columns).toEqual(["count"]);
    expect(result.rows).toEqual([{ count: 42 }]);
  });

  test("query falls back to row keys when schema unavailable", async () => {
    mockQuery.mockImplementation(() =>
      Promise.resolve([
        [{ name: "Alice", age: 30 }],
        null,
        {},
      ]),
    );
    const conn = createBigQueryConnection({ projectId: "my-project" });
    const result = await conn.query("SELECT name, age FROM users");
    expect(result.columns).toEqual(["name", "age"]);
    expect(result.rows).toEqual([{ name: "Alice", age: 30 }]);
  });

  test("query returns empty columns for empty result with no schema", async () => {
    mockQuery.mockImplementation(() =>
      Promise.resolve([[], null, {}]),
    );
    const conn = createBigQueryConnection({ projectId: "my-project" });
    const result = await conn.query("SELECT * FROM empty_table WHERE 1=0");
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  test("query passes jobTimeoutMs and useLegacySql options", async () => {
    const conn = createBigQueryConnection({ projectId: "my-project" });
    await conn.query("SELECT 1", 15000);
    expect(mockQuery).toHaveBeenCalledWith({
      query: "SELECT 1",
      jobTimeoutMs: 15000,
      useLegacySql: false,
    });
  });

  test("query uses default 30s timeout when none provided", async () => {
    const conn = createBigQueryConnection({ projectId: "my-project" });
    await conn.query("SELECT 1");
    expect(mockQuery).toHaveBeenCalledWith({
      query: "SELECT 1",
      jobTimeoutMs: 30000,
      useLegacySql: false,
    });
  });

  test("query passes location when configured", async () => {
    const conn = createBigQueryConnection({ projectId: "my-project", location: "US" });
    await conn.query("SELECT 1");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({ location: "US" }),
    );
  });

  test("query passes defaultDataset when configured", async () => {
    const conn = createBigQueryConnection({ projectId: "my-project", dataset: "analytics" });
    await conn.query("SELECT 1");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultDataset: { datasetId: "analytics", projectId: "my-project" },
      }),
    );
  });

  test("query wraps BigQuery errors", async () => {
    mockQuery.mockImplementation(() =>
      Promise.reject(new Error("Access Denied")),
    );
    const conn = createBigQueryConnection({ projectId: "my-project" });
    await expect(conn.query("SELECT 1")).rejects.toThrow(
      /BigQuery query failed: Access Denied/,
    );
  });

  test("query wraps non-Error thrown values", async () => {
    mockQuery.mockImplementation(() => Promise.reject("raw string error"));
    const conn = createBigQueryConnection({ projectId: "my-project" });
    await expect(conn.query("SELECT 1")).rejects.toThrow(
      /BigQuery query failed: raw string error/,
    );
  });

  test("close is a no-op (stateless REST)", async () => {
    const conn = createBigQueryConnection({ projectId: "my-project" });
    await conn.close(); // should not throw
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("healthCheck", () => {
  test("returns healthy when query succeeds", async () => {
    const plugin = bigqueryPlugin({ projectId: "my-project" });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
  });

  test("returns unhealthy when query fails", async () => {
    mockQuery.mockImplementation(() =>
      Promise.reject(new Error("Access Denied")),
    );
    const plugin = bigqueryPlugin({ projectId: "my-project" });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("Access Denied");
    expect(typeof result.latencyMs).toBe("number");
  });

  test("returns unhealthy (not throws) when client construction fails", async () => {
    mockBigQuery.mockImplementation(() => {
      throw new Error("invalid credentials");
    });
    const plugin = bigqueryPlugin({ projectId: "my-project" });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("invalid credentials");
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

describe("initialize", () => {
  test("logs projectId only (no credentials)", async () => {
    const plugin = bigqueryPlugin({
      projectId: "my-secret-project",
      keyFilename: "/path/to/secret-key.json",
    });
    const logged: string[] = [];
    const ctx = {
      db: null,
      connections: { get: () => { throw new Error("not implemented"); }, list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (...args: unknown[]) => { logged.push(String(args[0])); },
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    };
    await plugin.initialize!(ctx);
    const msg = logged.find((m) => m.includes("BigQuery datasource plugin initialized"));
    expect(msg).toBeDefined();
    expect(msg).toContain("my-secret-project");
    expect(msg).not.toContain("secret-key");
    expect(msg).not.toContain("/path/to");
  });

  test("logs (default-project) when projectId is omitted", async () => {
    const plugin = bigqueryPlugin({});
    const logged: string[] = [];
    const ctx = {
      db: null,
      connections: { get: () => { throw new Error("not implemented"); }, list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (...args: unknown[]) => { logged.push(String(args[0])); },
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    };
    await plugin.initialize!(ctx);
    const msg = logged.find((m) => m.includes("BigQuery datasource plugin initialized"));
    expect(msg).toBeDefined();
    expect(msg).toContain("(default-project)");
  });
});
