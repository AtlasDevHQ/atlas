/**
 * Atlas SQL Client as Effect Service (P11a).
 *
 * Wraps the existing DBConnection interface from ConnectionRegistry
 * in an Effect Context.Tag so it can be yielded from Effect programs.
 *
 * This is a bridge layer — the actual DB connections are still managed
 * by ConnectionRegistry (raw pg/mysql2 pools). P11b will migrate to
 * native @effect/sql-pg and @effect/sql-mysql2 clients.
 *
 * @example
 * ```ts
 * import { AtlasSqlClient } from "@atlas/api/lib/effect";
 *
 * const program = Effect.gen(function* () {
 *   const sql = yield* AtlasSqlClient;
 *   const result = yield* sql.query("SELECT count(*) FROM users");
 *   return result.rows;
 * });
 * ```
 */

import { Context, Effect, Layer } from "effect";
import { ConnectionRegistry } from "./services";

// ── Service interface ────────────────────────────────────────────────

/**
 * Atlas SQL client service — provides query execution.
 *
 * Bridges the existing DBConnection.query() to Effect Context.
 * The query method returns an Effect that succeeds with { columns, rows }
 * or fails with an Error.
 */
export interface AtlasSqlClientShape {
  /** Execute a SQL query and return { columns, rows }. */
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

// ── Live Layer ───────────────────────────────────────────────────────

/**
 * Create a Live layer for AtlasSqlClient from the ConnectionRegistry.
 *
 * Reads the specified connection (or default) from the registry and
 * wraps its query() method as an Effect.
 *
 * @param connectionId - Connection ID to use. Defaults to "default".
 */
export function makeAtlasSqlClientLive(
  connectionId?: string,
): Layer.Layer<AtlasSqlClient, Error, ConnectionRegistry> {
  return Layer.effect(
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

      const service: AtlasSqlClientShape = {
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
 * Uses ConnectionRegistry.getForOrg() to get the org-specific pool.
 */
export function makeOrgSqlClientLive(
  orgId: string,
  connectionId?: string,
): Layer.Layer<AtlasSqlClient, Error, ConnectionRegistry> {
  return Layer.effect(
    AtlasSqlClient,
    Effect.gen(function* () {
      const registry = yield* ConnectionRegistry;
      const id = connectionId ?? "default";
      const conn = registry.getForOrg(orgId, connectionId);
      const dbType = registry.getDBType(id);

      const service: AtlasSqlClientShape = {
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
 *     const sql = yield* AtlasSqlClient;
 *     return yield* sql.query("SELECT count(*) FROM users");
 *   }),
 * );
 * ```
 */
export function createSqlClientTestLayer(options?: {
  queryResult?: { columns: string[]; rows: Record<string, unknown>[] };
  queryError?: Error;
  dbType?: string;
  connectionId?: string;
}): Layer.Layer<AtlasSqlClient> {
  return Layer.succeed(AtlasSqlClient, {
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
