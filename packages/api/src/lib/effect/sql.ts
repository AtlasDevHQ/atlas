/**
 * Atlas SQL Client as Effect Service.
 *
 * Provides native @effect/sql integration for analytics connections managed
 * by ConnectionRegistry. PostgreSQL connections get a native SqlClient via
 * PgClient.layerFromPool(); MySQL and plugin connections use an imperative
 * bridge (mysql2 has no layerFromPool equivalent; plugin connections use
 * arbitrary pool implementations with no standard @effect/sql adapter).
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
 *   // Backward-compat query with timeout enforcement:
 *   const result = yield* client.query("SELECT count(*) FROM users");
 *   return result.rows;
 * });
 * ```
 */

import { Context, Effect, Layer, Scope } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import type { Pool as PgPool } from "pg";
import type { DBType, DBConnection } from "@atlas/api/lib/db/connection";
import { ConnectionRegistry } from "./services";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("effect:sql");

// ── Service interface ────────────────────────────────────────────────

/**
 * Atlas SQL client service — provides native @effect/sql access and
 * backward-compatible query execution.
 *
 * - `sql`: Native @effect/sql SqlClient for PostgreSQL connections with an
 *   accessible pool. Null for MySQL connections, plugin connections, or when
 *   native client creation fails (graceful degradation).
 * - `query()`: Backward-compat method that delegates to DBConnection.query()
 *   which handles per-connection search_path (PostgreSQL with ATLAS_SCHEMA)
 *   and per-query statement_timeout / MAX_EXECUTION_TIME.
 */
export interface AtlasSqlClientShape {
  /** Native @effect/sql SqlClient. Available for PostgreSQL; null for MySQL/plugin connections. */
  readonly sql: SqlClient.SqlClient | null;
  /**
   * Execute a SQL query via the underlying DBConnection.query().
   * For PostgreSQL, enforces per-connection search_path (when ATLAS_SCHEMA is set)
   * and per-query statement_timeout. For MySQL, enforces MAX_EXECUTION_TIME.
   * Returns { columns, rows }.
   */
  readonly query: (
    sql: string,
    timeoutMs?: number,
  ) => Effect.Effect<
    { columns: string[]; rows: Record<string, unknown>[] },
    Error
  >;
  /** The database type of the current connection. */
  readonly dbType: DBType;
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
 * Callers are responsible for only passing pg.Pool instances. The pool
 * parameter is typed as `unknown` because DBConnection._pool is untyped.
 */
function buildNativePgSqlClient(
  pool: unknown,
): Effect.Effect<SqlClient.SqlClient, Error, Scope.Scope> {
  return Effect.gen(function* () {
    // Runtime guard: verify this looks like a pg.Pool before casting
    if (
      !pool ||
      typeof pool !== "object" ||
      typeof (pool as Record<string, unknown>).connect !== "function" ||
      typeof (pool as Record<string, unknown>).end !== "function"
    ) {
      return yield* Effect.fail(
        new Error(
          "buildNativePgSqlClient: pool does not implement pg.Pool interface " +
          "(missing connect/end methods). Native SqlClient requires a real pg.Pool.",
        ),
      );
    }

    const pgClientLayer = PgClient.layerFromPool({
      acquire: Effect.acquireRelease(
        Effect.succeed(pool as PgPool),
        // No-op release: pool lifecycle managed by ConnectionRegistry.
        // ConnectionRegistry Layer must outlive AtlasSqlClient Layer so
        // PgClient internal finalizers can still access the pool during
        // AtlasSqlClient scope teardown.
        () => Effect.void,
      ),
      applicationName: "atlas-analytics",
    });

    const ctx = yield* Layer.build(pgClientLayer).pipe(
      Effect.mapError(
        (err) =>
          new Error(
            `Failed to create native SqlClient: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          ),
      ),
    );

    return Context.get(ctx, SqlClient.SqlClient);
  });
}

// ── Shared service builder ──────────────────────────────────────────

/**
 * Build an AtlasSqlClientShape from a DBConnection + metadata.
 * Shared between makeAtlasSqlClientLive and makeOrgSqlClientLive.
 */
function buildSqlClientService(
  conn: DBConnection,
  dbType: DBType,
  id: string,
  logContext?: Record<string, string>,
): Effect.Effect<AtlasSqlClientShape, never, Scope.Scope> {
  return Effect.gen(function* () {
    // Build native SqlClient for PostgreSQL connections with a pool
    const nativeSql: SqlClient.SqlClient | null =
      dbType === "postgres" && conn._pool
        ? yield* buildNativePgSqlClient(conn._pool).pipe(
            Effect.catchAll((err) => {
              log.warn(
                {
                  connectionId: id,
                  ...logContext,
                  err: err instanceof Error ? err.message : String(err),
                },
                "Failed to create native SqlClient — falling back to bridge",
              );
              return Effect.succeed(null as SqlClient.SqlClient | null);
            }),
          )
        : null;

    return {
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
    } satisfies AtlasSqlClientShape;
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
      return yield* buildSqlClientService(conn, dbType, id);
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
      return yield* buildSqlClientService(conn, dbType, id, { orgId });
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
  dbType?: DBType;
  connectionId?: string;
  /** Provide a mock SqlClient for testing native @effect/sql access. Defaults to null. */
  sql?: SqlClient.SqlClient | null;
}): Layer.Layer<AtlasSqlClient> {
  return Layer.succeed(
    AtlasSqlClient,
    {
      sql: options?.sql ?? null,
      query: (_sql, _timeoutMs) =>
        options?.queryError
          ? Effect.fail(options.queryError)
          : Effect.succeed(
              options?.queryResult ?? { columns: [], rows: [] },
            ),
      dbType: options?.dbType ?? "postgres",
      connectionId: options?.connectionId ?? "default",
    } satisfies AtlasSqlClientShape,
  );
}
