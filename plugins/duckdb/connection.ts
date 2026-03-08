/**
 * DuckDB connection factory for the datasource plugin.
 *
 * Extracted from packages/api/src/lib/db/duckdb.ts — adapts the
 * createDuckDBConnection() logic using the Plugin SDK's PluginDBConnection
 * interface instead of the internal DBConnection.
 */

import type { PluginDBConnection, PluginQueryResult } from "@useatlas/plugin-sdk";

export interface DuckDBConnectionConfig {
  /** Path to the .duckdb file, or ":memory:" for in-memory. */
  path: string;
  /** Open in read-only mode (default: true for non-memory databases). */
  readOnly?: boolean;
  logger?: { warn(msg: string): void };
}

/**
 * Parse a duckdb:// URL into a DuckDBConnectionConfig.
 *
 * - `duckdb://` or `duckdb://:memory:` → in-memory
 * - `duckdb:///absolute/path.duckdb` → absolute path
 * - `duckdb://relative/path.duckdb` → relative path
 */
export function parseDuckDBUrl(url: string): DuckDBConnectionConfig {
  if (!url.startsWith("duckdb://")) {
    throw new Error(
      `Invalid DuckDB URL: expected duckdb:// scheme, got "${url.slice(0, 20)}..."`,
    );
  }

  const rest = url.slice("duckdb://".length);

  if (!rest || rest === ":memory:") {
    return { path: ":memory:", readOnly: false };
  }

  // duckdb:///absolute/path → /absolute/path
  // duckdb://relative/path → relative/path
  return { path: rest, readOnly: true };
}

/**
 * Create a PluginDBConnection backed by @duckdb/node-api.
 * Uses lazy initialization with cached Promise and retry on failure.
 * Timeout via Promise.race() since DuckDB has no native timeout API.
 *
 * @throws {Error} If @duckdb/node-api is not installed (optional peer dependency).
 */
export function createDuckDBConnection(
  config: DuckDBConnectionConfig,
): PluginDBConnection {
  let instancePromise: Promise<{ instance: unknown; connection: unknown }> | null =
    null;

  async function getConnection() {
    if (!instancePromise) {
      instancePromise = (async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        let DuckDBInstance: unknown;
        try {
          ({ DuckDBInstance } = require("@duckdb/node-api"));
        } catch (err) {
          const isNotFound =
            err instanceof Error &&
            "code" in err &&
            (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND";
          if (isNotFound) {
            throw new Error(
              "DuckDB support requires the @duckdb/node-api package. Install it with: bun add @duckdb/node-api",
            );
          }
          throw new Error(
            `Failed to load @duckdb/node-api: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }

        const options: Record<string, string> = {};
        if (config.readOnly !== false && config.path !== ":memory:") {
          options.access_mode = "READ_ONLY";
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const instance = await (DuckDBInstance as any).create(config.path, options);
        const connection = await instance.connect();
        return { instance, connection };
      })();
      // Allow retry on transient failures — don't cache rejected promises
      instancePromise.catch(() => {
        instancePromise = null;
      });
    }
    return instancePromise;
  }

  return {
    async query(sql: string, timeoutMs?: number): Promise<PluginQueryResult> {
      const { connection } = await getConnection();

      const runQuery = async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const reader = await (connection as any).runAndReadAll(sql);
        const columns: string[] = reader.columnNames();
        const rowObjects: Record<string, unknown>[] = reader.getRowObjects();
        return { columns, rows: rowObjects };
      };

      if (timeoutMs && timeoutMs > 0) {
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`DuckDB query timed out after ${timeoutMs}ms`),
              ),
            timeoutMs,
          );
        });
        return Promise.race([runQuery(), timeout]).finally(() =>
          clearTimeout(timer!),
        );
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
          (config.logger ?? console).warn(`[duckdb-datasource] Failed to close DuckDB connection: ${err instanceof Error ? err.message : String(err)}`);
        }
        instancePromise = null;
      }
    },
  };
}
