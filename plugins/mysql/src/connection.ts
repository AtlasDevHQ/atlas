/**
 * MySQL connection factory for the datasource plugin.
 *
 * Extracted from packages/api/src/lib/db/connection.ts — adapts the
 * createMySQLDB() logic using the Plugin SDK's PluginDBConnection interface
 * instead of the internal DBConnection.
 */

import type { PluginDBConnection, PluginQueryResult } from "@useatlas/plugin-sdk";

interface MySQLConnectionConfig {
  url: string;
  poolSize?: number;
  idleTimeoutMs?: number;
  logger?: { warn(msg: string): void };
}

/**
 * Extract hostname from a MySQL URL for safe logging (no credentials).
 * Returns "(unknown)" on parse failure.
 */
export function extractHost(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || "(unknown)";
  } catch {
    return "(unknown)";
  }
}

/**
 * Create a PluginDBConnection backed by mysql2/promise pool.
 * Enforces session-level read-only mode and per-query timeout.
 *
 * @throws {Error} If mysql2 is not installed (optional peer dependency).
 */
export function createMySQLConnection(
  config: MySQLConnectionConfig,
): PluginDBConnection {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mysql: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mysql = require("mysql2/promise");
  } catch (err) {
    const isNotFound =
      err != null &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND";
    if (isNotFound) {
      throw new Error(
        "MySQL support requires the mysql2 package. Install it with: bun add mysql2",
      );
    }
    throw new Error(
      `Failed to load mysql2: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const pool = mysql.createPool({
    uri: config.url,
    connectionLimit: config.poolSize ?? 10,
    idleTimeout: config.idleTimeoutMs ?? 30000,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });

  const warn = (msg: string) => (config.logger ?? console).warn(msg);

  return {
    async query(sql: string, timeoutMs = 30000): Promise<PluginQueryResult> {
      const conn = await pool.getConnection();
      try {
        // Defense-in-depth: read-only session prevents DML even if validation has a bug
        await conn.execute("SET SESSION TRANSACTION READ ONLY");
        // Per-query timeout via session variable (milliseconds)
        const safeTimeout = Number.isFinite(timeoutMs)
          ? Math.max(0, Math.floor(timeoutMs))
          : 30000;
        await conn.execute(
          `SET SESSION MAX_EXECUTION_TIME = ${safeTimeout}`,
        );
        const [rows, fields] = await conn.execute(sql);
        const columns = (fields as { name: string }[]).map((f) => f.name);
        return { columns, rows: rows as Record<string, unknown>[] };
      } catch (err) {
        throw new Error(
          `MySQL query failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      } finally {
        try {
          conn.release();
        } catch (releaseErr) {
          warn(`[mysql-datasource] Failed to release MySQL connection: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`);
        }
      }
    },
    async close(): Promise<void> {
      try {
        await pool.end();
      } catch (err) {
        warn(`[mysql-datasource] Failed to close MySQL pool: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
