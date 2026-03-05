/**
 * DuckDB adapter implementing the DBConnection interface.
 *
 * Uses @duckdb/node-api (the "Neo" API) for in-process analytical queries
 * on CSV, Parquet, and persistent DuckDB database files. DuckDB runs fully
 * in-process — no external server required.
 *
 * Connection URL formats:
 *   - `duckdb://path/to/file.duckdb` — persistent database file
 *   - `duckdb://:memory:` — in-memory database
 *   - `duckdb://` — in-memory (shorthand)
 *
 * Read-only enforcement: the database is opened with `access_mode: 'READ_ONLY'`
 * when the file already exists. For newly-created databases (e.g. during CLI
 * ingestion), the caller is responsible for opening in read-write mode first,
 * then re-opening as read-only for runtime use.
 */

import type { DBConnection, QueryResult } from "./connection";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("duckdb");

export interface DuckDBConfig {
  /** Path to the .duckdb file, or ":memory:" for in-memory. */
  path: string;
  /** Open in read-only mode (default: true for runtime). */
  readOnly?: boolean;
}

/**
 * Parse a duckdb:// URL into a DuckDBConfig.
 *
 * - `duckdb://` or `duckdb://:memory:` → in-memory
 * - `duckdb:///absolute/path.duckdb` → absolute path
 * - `duckdb://relative/path.duckdb` → relative path
 */
export function parseDuckDBUrl(url: string): DuckDBConfig {
  if (!url.startsWith("duckdb://")) {
    throw new Error(`Invalid DuckDB URL: expected duckdb:// scheme, got "${url.slice(0, 20)}..."`);
  }

  const rest = url.slice("duckdb://".length);

  if (!rest || rest === ":memory:") {
    return { path: ":memory:" };
  }

  // duckdb:///absolute/path → /absolute/path
  // duckdb://relative/path → relative/path
  return { path: rest };
}

export function createDuckDBConnection(config: DuckDBConfig): DBConnection {
  // Lazy-load to avoid requiring @duckdb/node-api when not needed
  let instancePromise: Promise<{ instance: unknown; connection: unknown }> | null = null;

  async function getConnection() {
    if (!instancePromise) {
      instancePromise = (async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { DuckDBInstance } = require("@duckdb/node-api");

        const options: Record<string, string> = {};
        if (config.readOnly !== false && config.path !== ":memory:") {
          options.access_mode = "READ_ONLY";
        }

        const instance = await DuckDBInstance.create(config.path, options);
        const connection = await instance.connect();
        return { instance, connection };
      })();
      // Allow retry on transient failures — don't cache rejected promises
      instancePromise.catch(() => { instancePromise = null; });
    }
    return instancePromise;
  }

  return {
    async query(sql: string, timeoutMs?: number): Promise<QueryResult> {
      const { connection } = await getConnection();

      const runQuery = async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const reader = await (connection as any).runAndReadAll(sql);
        const columns: string[] = reader.columnNames();
        const rowObjects: Record<string, unknown>[] = reader.getRowObjects();
        return { columns, rows: rowObjects };
      };

      if (timeoutMs && timeoutMs > 0) {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(
            `DuckDB query timed out after ${timeoutMs}ms`
          )), timeoutMs)
        );
        return Promise.race([runQuery(), timeout]);
      }

      return runQuery();
    },

    async close(): Promise<void> {
      if (instancePromise) {
        try {
          const { connection, instance } = await instancePromise;
          // DuckDB Neo API uses synchronous cleanup methods
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (connection as any).disconnectSync();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (instance as any).closeSync();
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "Failed to close DuckDB connection"
          );
        }
        instancePromise = null;
      }
    },
  };
}
