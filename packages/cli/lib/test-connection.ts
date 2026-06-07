/**
 * Shared database connection testing for CLI commands.
 *
 * Consolidates the duplicated connection test blocks from
 * handleDiff and the init handler (profileDatasource).
 *
 * Each DB type:
 * 1. Creates a minimal connection
 * 2. Runs a version query
 * 3. Returns the version string on success
 * 4. Cleans up (pool.end, client.close, etc.)
 * 5. Throws on failure with a helpful error message
 */

import { Pool } from "pg";
import type { DBType } from "@atlas/api/lib/db/connection";

// --- ClickHouse helpers ---

type ClickHouseClient = {
  query: (opts: {
    query: string;
    format: string;
  }) => Promise<{
    json: () => Promise<{ data: Record<string, unknown>[] }>;
  }>;
  close: () => Promise<void>;
};

/** Rewrite clickhouse:// or clickhouses:// URLs to http:// or https:// for the HTTP client. */
export function rewriteClickHouseUrl(url: string): string {
  return url
    .replace(/^clickhouses:\/\//, "https://")
    .replace(/^clickhouse:\/\//, "http://");
}

/** Run a single query against ClickHouse and return rows. */
export async function clickhouseQuery<T = Record<string, unknown>>(
  client: ClickHouseClient,
  sql: string,
): Promise<T[]> {
  const result = await client.query({ query: sql, format: "JSON" });
  const json = await result.json();
  return json.data as T[];
}

// --- Snowflake helpers ---

type SnowflakePool = ReturnType<typeof import("snowflake-sdk").createPool>;

export async function snowflakeQuery(
  pool: SnowflakePool,
  sql: string,
  binds?: (string | number)[],
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  return pool.use(async (conn) => {
    return new Promise<{
      columns: string[];
      rows: Record<string, unknown>[];
    }>((resolve, reject) => {
      conn.execute({
        sqlText: sql,
        binds: binds ?? [],
        complete: (err, stmt, rows) => {
          if (err) return reject(err);
          const columns = (stmt?.getColumns() ?? []).map((c) => c.getName());
          resolve({
            columns,
            rows: (rows ?? []) as Record<string, unknown>[],
          });
        },
      });
    });
  });
}

/** Create a Snowflake connection pool from a URL string. */
export async function createSnowflakePool(
  connectionString: string,
  max = 1,
) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const snowflake = require("snowflake-sdk") as typeof import("snowflake-sdk");
  snowflake.configure({ logLevel: "ERROR" });

  const { parseSnowflakeURL } = await import(
    "../../../plugins/snowflake/src/connection"
  );
  const opts = parseSnowflakeURL(connectionString);

  const pool = snowflake.createPool(
    {
      account: opts.account,
      username: opts.username,
      password: opts.password,
      database: opts.database,
      schema: opts.schema,
      warehouse: opts.warehouse,
      role: opts.role,
      application: "Atlas",
    },
    { max, min: 0 },
  );

  return { pool, opts };
}

// --- DuckDB helpers ---

/** Lazy-loaded to avoid requiring native bindings at type-check time. */
export async function loadDuckDB() {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  return DuckDBInstance;
}

// --- Main connection test function ---

/**
 * Test a database connection and return the version string.
 *
 * @param connStr - Database connection string
 * @param dbType - Detected database type
 * @returns Version string on success (e.g. "PostgreSQL 16.2")
 * @throws Error with a helpful message on failure
 */
export async function testDatabaseConnection(
  connStr: string,
  dbType: DBType,
): Promise<string> {
  switch (dbType) {
    case "mysql": {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mysql = require("mysql2/promise");
      const testPool = mysql.createPool({
        uri: connStr,
        connectionLimit: 1,
        connectTimeout: 5000,
      });
      try {
        const [rows] = await testPool.execute("SELECT VERSION() as v");
        return `MySQL ${(rows as { v: string }[])[0].v}`;
      } catch (err) {
        throw new Error(
          `Cannot connect to MySQL database: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      } finally {
        await testPool.end();
      }
    }

    case "clickhouse": {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createClient } = require("@clickhouse/client");
      const testClient = createClient({
        url: rewriteClickHouseUrl(connStr),
      }) as ClickHouseClient;
      try {
        const rows = await clickhouseQuery<{ v: string }>(
          testClient,
          "SELECT version() as v",
        );
        return `ClickHouse ${rows[0].v}`;
      } catch (err) {
        throw new Error(
          `Cannot connect to ClickHouse database: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      } finally {
        await testClient.close().catch((closeErr: unknown) => {
          console.warn(
            `[atlas] ClickHouse client cleanup warning: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
          );
        });
      }
    }

    case "snowflake": {
      let testPool: SnowflakePool | undefined;
      try {
        const created = await createSnowflakePool(connStr, 1);
        testPool = created.pool;
        const result = await snowflakeQuery(
          testPool,
          "SELECT CURRENT_VERSION() as V",
        );
        return `Snowflake ${result.rows[0]?.V ?? "unknown"}`;
      } catch (err) {
        throw new Error(
          `Cannot connect to Snowflake: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      } finally {
        if (testPool) {
          await testPool.drain().catch((drainErr: unknown) => {
            console.warn(
              `[atlas] Snowflake pool drain warning: ${drainErr instanceof Error ? drainErr.message : String(drainErr)}`,
            );
          });
          try {
            await testPool.clear();
          } catch (clearErr: unknown) {
            console.warn(
              `[atlas] Snowflake pool clear warning: ${clearErr instanceof Error ? clearErr.message : String(clearErr)}`,
            );
          }
        }
      }
    }

    case "duckdb": {
      const { parseDuckDBUrl } = await import(
        "../../../plugins/duckdb/src/connection"
      );
      const duckConfig = parseDuckDBUrl(connStr);
      const DuckDBInstance = await loadDuckDB();
      let testInstance: Awaited<ReturnType<typeof DuckDBInstance.create>> | undefined;
      let testConn: Awaited<ReturnType<Exclude<typeof testInstance, undefined>["connect"]>> | undefined;
      try {
        testInstance = await DuckDBInstance.create(duckConfig.path, {
          access_mode: "READ_ONLY",
        });
        testConn = await testInstance.connect();
        const reader = await testConn.runAndReadAll(
          "SELECT version() as v",
        );
        const version =
          (reader.getRowObjects()[0]?.v as string) ?? "unknown";
        return `DuckDB ${version}`;
      } catch (err) {
        throw new Error(
          `Cannot open DuckDB database: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      } finally {
        if (testConn) testConn.disconnectSync();
        if (testInstance) testInstance.closeSync();
      }
    }

    case "salesforce": {
      const { parseSalesforceURL, createSalesforceConnection } =
        await import("../../../plugins/salesforce/src/connection");
      const config = parseSalesforceURL(connStr);
      const source = createSalesforceConnection(config);
      try {
        const objects = await source.listObjects();
        return `Salesforce (${objects.length} queryable objects)`;
      } catch (err) {
        throw new Error(
          `Cannot connect to Salesforce: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      } finally {
        await source.close().catch((closeErr: unknown) => {
          console.warn(
            `[atlas] Salesforce client cleanup warning: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
          );
        });
      }
    }

    case "elasticsearch": {
      // The API key is NOT in the elasticsearch:// URL (the parser rejects
      // credentials) — it is a separate secret, read from ATLAS_ES_API_KEY.
      const apiKey = process.env.ATLAS_ES_API_KEY;
      if (!apiKey) {
        throw new Error(
          "ATLAS_ES_API_KEY is required for an Elasticsearch datasource. " +
            "Set it to the base64 API key for the cluster.",
        );
      }
      const {
        resolveElasticsearchConfig,
        createElasticsearchClient,
        scrubElasticsearchError,
      } = await import("../../../plugins/elasticsearch/src/connection");
      const client = createElasticsearchClient(
        resolveElasticsearchConfig({ url: connStr, apiKey }),
      );
      try {
        const info = await client.ping(5000);
        const distribution = info.distribution ?? "elasticsearch";
        const version = info.version ? ` ${info.version}` : "";
        const cluster = info.clusterName ? ` (cluster: ${info.clusterName})` : "";
        return `Elasticsearch [${distribution}${version}]${cluster}`;
      } catch (err) {
        // `client.ping` already scrubs its errors and config errors carry no
        // credential, so the caught error is credential-free — preserving the
        // cause chain is safe here.
        throw new Error(
          `Cannot connect to Elasticsearch: ${scrubElasticsearchError(err, apiKey)}`,
          { cause: err },
        );
      } finally {
        client.close();
      }
    }

    case "postgres":
    default: {
      const testPool = new Pool({
        connectionString: connStr,
        max: 1,
        connectionTimeoutMillis: 5000,
      });
      try {
        const client = await testPool.connect();
        const versionResult = await client.query("SELECT version()");
        const version =
          (versionResult.rows[0]?.version as string)?.split(",")[0] ??
          "unknown";
        client.release();
        return version;
      } catch (err) {
        throw new Error(
          `Cannot connect to database: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      } finally {
        await testPool.end();
      }
    }
  }
}
