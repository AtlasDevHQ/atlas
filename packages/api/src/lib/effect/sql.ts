/**
 * Atlas SQL Client as Effect Service.
 *
 * Provides native @effect/sql integration for analytics connections managed
 * by ConnectionRegistry. PostgreSQL connections get a native SqlClient via
 * PgClient.layerFromPool(); MySQL and plugin connections use an imperative
 * bridge (mysql2 has no layerFromPool equivalent).
 *
 * @example
 * ```ts
 * import { AtlasSqlClient } from "@atlas/api/lib/effect";
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* AtlasSqlClient;
 *   // Native @effect/sql queries (PostgreSQL only):
 *   if (client.sql) {
 *     const rows = yield* client.sql.unsafe("SELECT count(*) FROM users");
 *   }
 *   // Backward-compat query with search_path + timeout enforcement:
 *   const result = yield* client.query("SELECT count(*) FROM users");
 *   return result.rows;
 * });
 * ```
 */

import { Context, Effect, Layer, Scope } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import type { Pool as PgPool } from "pg";
import { ConnectionRegistry } from "./services";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("effect:sql");

// ── Service interface ────────────────────────────────────────────────

/**
 * Atlas SQL client service — provides native @effect/sql access and
 * backward-compatible query execution.
 *
 * - `sql`: Native @effect/sql SqlClient for PostgreSQL connections.
 *   Null for MySQL and plugin connections (no layerFromPool available).
 * - `query()`: Backward-compat method that delegates to DBConnection.query()
 *   with search_path and statement_timeout enforcement.
 */
export interface AtlasSqlClientShape {
  /** Native @effect/sql SqlClient. Available for PostgreSQL; null for MySQL/plugin connections. */
  readonly sql: SqlClient.SqlClient | null;
  /**
   * Execute a SQL query with search_path and timeout enforcement.
   * Returns { columns, rows }. Uses the underlying DBConnection.query()
   * which handles per-connection search_path and per-query statement_timeout.
   */
  query(
    sql: string,
    timeoutMs?: number,
  ): Effect.Effect<
    { columns: string[]; rows: Record<string, unknown>[] },
    Error
  >;
  /** The database type of the current connection. */
  readonly dbType: string;
  /** The connection ID being used. */
  readonly connectionId: string;
}

// ── Context.Tag ──────────────────────────────────────────────────────

export class AtlasSqlClient extends Context.Tag("AtlasSqlClient")<
  AtlasSqlClient,
  AtlasSqlClientShape
>() {}

// ── Native SqlClient from pool ──────────────────────────────────────

/**
 * Build a native @effect/sql SqlClient from a pg.Pool within the current
 * Effect scope. The pool lifecycle is NOT managed here — ConnectionRegistry
 * owns the pool. The acquireRelease release is a no-op.
 *
 * Returns null if the pool is not a pg.Pool (MySQL, plugin connections).
 */
function buildNativePgSqlClient(
  pool: unknown,
): Effect.Effect<SqlClient.SqlClient, Error, Scope.Scope> {
  return Effect.gen(function* () {
    const pgClientLayer = PgClient.layerFromPool({
      acquire: Effect.acquireRelease(
        Effect.succeed(pool as PgPool),
        () => Effect.void, // No-op: pool lifecycle managed by ConnectionRegistry
      ),
      applicationName: "atlas-analytics",
    });

    const ctx = yield* Layer.build(pgClientLayer).pipe(
      Effect.mapError(
        (err) =>
          new Error(
            `Failed to create native SqlClient: ${err instanceof Error ? err.message : String(err)}`,
          ),
      ),
    );

    return Context.get(ctx, SqlClient.SqlClient);
  });
}

// ── Live Layer ───────────────────────────────────────────────────────

/**
 * Create a Live layer for AtlasSqlClient from the ConnectionRegistry.
 *
 * For PostgreSQL connections with a raw pool: creates a native @effect/sql
 * SqlClient via PgClient.layerFromPool(). The SqlClient scope is tied to
 * the AtlasSqlClient Layer scope (cleaned up on Layer teardown).
 *
 * For MySQL and plugin connections: sql is null (no native layerFromPool
 * available for mysql2). The query() method still works via DBConnection.
 *
 * @param connectionId - Connection ID to use. Defaults to "default".
 */
export function makeAtlasSqlClientLive(
  connectionId?: string,
): Layer.Layer<AtlasSqlClient, Error, ConnectionRegistry> {
  return Layer.scoped(
    AtlasSqlClient,
    Effect.gen(function* () {
      const registry = yield* ConnectionRegistry;
      const id = connectionId ?? "default";

      if (!registry.has(id)) {
        return yield* Effect.fail(
          new Error(`Connection "${id}" not found in registry`),
        );
      }

      const conn = registry.get(id);
      const dbType = registry.getDBType(id);

      // Build native SqlClient for PostgreSQL connections
      const nativeSql: SqlClient.SqlClient | null =
        dbType === "postgres" && conn._pool
          ? yield* buildNativePgSqlClient(conn._pool).pipe(
              Effect.catchAll((err) => {
                log.warn(
                  {
                    connectionId: id,
                    err: err instanceof Error ? err.message : String(err),
                  },
                  "Failed to create native SqlClient — falling back to bridge",
                );
                return Effect.succeed(null as SqlClient.SqlClient | null);
              }),
            )
          : null;

      const service: AtlasSqlClientShape = {
        sql: nativeSql,
        query: (sql, timeoutMs) =>
          Effect.tryPromise({
            try: () => conn.query(sql, timeoutMs),
            catch: (err) =>
              new Error(
                `SQL query failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
          }),
        dbType,
        connectionId: id,
      };

      return service;
    }),
  );
}

/**
 * Create a Live layer for AtlasSqlClient for an org-scoped connection.
 *
 * Uses ConnectionRegistry.getForOrg() to get the org-specific pool,
 * then wraps it with a native SqlClient for PostgreSQL connections.
 */
export function makeOrgSqlClientLive(
  orgId: string,
  connectionId?: string,
): Layer.Layer<AtlasSqlClient, Error, ConnectionRegistry> {
  return Layer.scoped(
    AtlasSqlClient,
    Effect.gen(function* () {
      const registry = yield* ConnectionRegistry;
      const id = connectionId ?? "default";
      const conn = registry.getForOrg(orgId, connectionId);
      // Use the base connection ID for dbType lookup — org pools inherit
      // the database type from their parent connection, not from the org ID.
      const dbType = registry.getDBType(id);

      // Build native SqlClient for PostgreSQL connections
      const nativeSql: SqlClient.SqlClient | null =
        dbType === "postgres" && conn._pool
          ? yield* buildNativePgSqlClient(conn._pool).pipe(
              Effect.catchAll((err) => {
                log.warn(
                  {
                    connectionId: id,
                    orgId,
                    err: err instanceof Error ? err.message : String(err),
                  },
                  "Failed to create native SqlClient for org pool — falling back to bridge",
                );
                return Effect.succeed(null as SqlClient.SqlClient | null);
              }),
            )
          : null;

      const service: AtlasSqlClientShape = {
        sql: nativeSql,
        query: (sql, timeoutMs) =>
          Effect.tryPromise({
            try: () => conn.query(sql, timeoutMs),
            catch: (err) =>
              new Error(
                `SQL query failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
          }),
        dbType,
        connectionId: id,
      };

      return service;
    }),
  );
}

// ── Test helper ──────────────────────────────────────────────────────

/**
 * Create a test Layer for AtlasSqlClient.
 *
 * Provides a mock SQL client with configurable query results.
 * Does NOT require ConnectionRegistry — fully self-contained.
 *
 * @example
 * ```ts
 * const TestLayer = createSqlClientTestLayer({
 *   queryResult: { columns: ["count"], rows: [{ count: 42 }] },
 * });
 *
 * const result = await runTest(
 *   Effect.gen(function* () {
 *     const client = yield* AtlasSqlClient;
 *     return yield* client.query("SELECT count(*) FROM users");
 *   }),
 * );
 * ```
 */
export function createSqlClientTestLayer(options?: {
  queryResult?: { columns: string[]; rows: Record<string, unknown>[] };
  queryError?: Error;
  dbType?: string;
  connectionId?: string;
  /** Provide a mock SqlClient for testing native @effect/sql access. Defaults to null. */
  sql?: SqlClient.SqlClient | null;
}): Layer.Layer<AtlasSqlClient> {
  return Layer.succeed(AtlasSqlClient, {
    sql: options?.sql ?? null,
    query: (_sql, _timeoutMs) =>
      options?.queryError
        ? Effect.fail(options.queryError)
        : Effect.succeed(
            options?.queryResult ?? { columns: [], rows: [] },
          ),
    dbType: options?.dbType ?? "postgres",
    connectionId: options?.connectionId ?? "default",
  });
}
