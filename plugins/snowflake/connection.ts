/**
 * Snowflake connection factory for the datasource plugin.
 *
 * Extracted from packages/api/src/lib/db/connection.ts — adapts the
 * createSnowflakeDB() logic using the Plugin SDK's PluginDBConnection
 * interface instead of the internal DBConnection.
 *
 * Key differences from other adapters:
 * - Callback-based API (snowflake-sdk uses execute({ complete }) callbacks)
 * - Pool via generic-pool (snowflake.createPool() + pool.use())
 * - No session-level read-only mode (relies on SQL validation + role-based access)
 * - Session configuration via ALTER SESSION before each query
 */

import type { PluginDBConnection, PluginQueryResult } from "@useatlas/plugin-sdk";

/**
 * Parse a Snowflake connection URL into SDK ConnectionOptions.
 * Format: snowflake://user:pass@account/database/schema?warehouse=WH&role=ROLE
 *
 * - `account` can be a plain account identifier (e.g. `xy12345`) or a
 *   fully-qualified account locator (e.g. `xy12345.us-east-1`).
 * - `/database` and `/database/schema` path segments are optional.
 * - Query parameters: `warehouse`, `role` (case-insensitive).
 */
export function parseSnowflakeURL(url: string): {
  account: string;
  username: string;
  password: string;
  database?: string;
  schema?: string;
  warehouse?: string;
  role?: string;
} {
  const parsed = new URL(url);
  if (parsed.protocol !== "snowflake:") {
    throw new Error(`Invalid Snowflake URL: expected snowflake:// scheme, got "${parsed.protocol}"`);
  }

  const account = parsed.hostname;
  if (!account) {
    throw new Error("Invalid Snowflake URL: missing account identifier in hostname.");
  }

  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (!username) {
    throw new Error("Invalid Snowflake URL: missing username.");
  }

  // Path segments: /database or /database/schema
  const pathSegments = parsed.pathname.split("/").filter(Boolean);
  const database = pathSegments[0] || undefined;
  const schema = pathSegments[1] || undefined;

  const warehouse = parsed.searchParams.get("warehouse") ?? undefined;
  const role = parsed.searchParams.get("role") ?? undefined;

  return { account, username, password, database, schema, warehouse, role };
}

/**
 * Extract account identifier from a Snowflake URL for safe logging (no credentials).
 * Returns "(unknown)" on parse failure.
 */
export function extractAccount(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || "(unknown)";
  } catch {
    return "(unknown)";
  }
}

export interface SnowflakeConnectionConfig {
  url: string;
  maxConnections?: number;
  logger?: { warn(msg: string): void };
}

/**
 * Create a PluginDBConnection backed by snowflake-sdk pool.
 * Enforces statement timeout and query tagging per query.
 *
 * @throws {Error} If snowflake-sdk is not installed (optional peer dependency).
 */
export function createSnowflakeConnection(
  config: SnowflakeConnectionConfig,
): PluginDBConnection {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let snowflake: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    snowflake = require("snowflake-sdk");
  } catch (err) {
    const isNotFound =
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND";
    if (isNotFound) {
      throw new Error(
        "Snowflake support requires the snowflake-sdk package. Install it with: bun add snowflake-sdk",
      );
    }
    throw new Error(
      `Failed to load snowflake-sdk: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // Suppress noisy SDK logging
  snowflake.configure({ logLevel: "ERROR" });

  const opts = parseSnowflakeURL(config.url);

  const warn = (msg: string) => (config.logger ?? console).warn(msg);

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
    { max: config.maxConnections ?? 10, min: 0 },
  );

  return {
    async query(sql: string, timeoutMs = 30000): Promise<PluginQueryResult> {
      const timeoutSec = Math.max(1, Math.floor(timeoutMs / 1000));
      if (!Number.isFinite(timeoutSec)) {
        throw new Error(`Invalid timeout: ${timeoutMs}ms`);
      }
      // Note: Snowflake has no session-level read-only mode (unlike ClickHouse's readonly=1).
      // Read-only enforcement relies on Atlas SQL validation (regex + AST) and
      // the Snowflake role having only SELECT privileges. See initialize() warning.
      return pool.use(async (conn: SnowflakeConnection) => {
        // Set session-level statement timeout (seconds)
        await new Promise<void>((resolve, reject) => {
          conn.execute({
            sqlText: `ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = ${timeoutSec}`,
            complete: (err: Error | null | undefined) => {
              if (err) {
                reject(
                  new Error(
                    `Failed to set Snowflake statement timeout (${timeoutSec}s) — ensure the connection role has ALTER SESSION privileges: ${err.message}`,
                    { cause: err },
                  ),
                );
              } else {
                resolve();
              }
            },
          });
        });

        // Tag all Atlas queries for audit trail in QUERY_HISTORY (best-effort —
        // insufficient privileges or transient errors should not block the query)
        try {
          await new Promise<void>((resolve, reject) => {
            conn.execute({
              sqlText: `ALTER SESSION SET QUERY_TAG = 'atlas:readonly'`,
              complete: (err: Error | null | undefined) => (err ? reject(err) : resolve()),
            });
          });
        } catch (tagErr) {
          warn(`[snowflake-datasource] Failed to set QUERY_TAG — query will proceed without audit tag: ${tagErr instanceof Error ? tagErr.message : String(tagErr)}`);
        }

        // Execute the actual query
        return new Promise<PluginQueryResult>((resolve, reject) => {
          conn.execute({
            sqlText: sql,
            complete: (err: Error | null | undefined, stmt: SnowflakeStatement | undefined, rows: Record<string, unknown>[] | undefined) => {
              if (err) {
                return reject(
                  new Error(
                    `Snowflake query failed: ${err.message}`,
                    { cause: err },
                  ),
                );
              }
              try {
                const columns = (stmt?.getColumns() ?? []).map((c: SnowflakeColumn) => c.getName());
                const resultRows = (rows ?? []) as Record<string, unknown>[];
                resolve({ columns, rows: resultRows });
              } catch (mapErr) {
                reject(
                  new Error(
                    `Snowflake query succeeded but result mapping failed: ${mapErr instanceof Error ? mapErr.message : String(mapErr)}`,
                    { cause: mapErr },
                  ),
                );
              }
            },
          });
        });
      });
    },
    async close(): Promise<void> {
      try {
        await pool.drain();
      } catch (err) {
        warn(`[snowflake-datasource] Failed to drain Snowflake connection pool: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await pool.clear();
      } catch (err) {
        warn(`[snowflake-datasource] Failed to clear Snowflake connection pool: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

// Minimal type stubs for snowflake-sdk callback API (avoids importing the full SDK types)
interface SnowflakeColumn {
  getName(): string;
}
interface SnowflakeStatement {
  getColumns(): SnowflakeColumn[];
}
interface SnowflakeConnection {
  execute(opts: {
    sqlText: string;
    complete: (err: Error | null | undefined, stmt?: SnowflakeStatement, rows?: Record<string, unknown>[]) => void;
  }): void;
}
