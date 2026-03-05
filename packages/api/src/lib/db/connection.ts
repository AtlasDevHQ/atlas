/**
 * Database connection factory and registry.
 *
 * Supports PostgreSQL (via `pg` Pool), MySQL (via `mysql2/promise`),
 * ClickHouse (via `@clickhouse/client` HTTP transport),
 * Snowflake (via `snowflake-sdk` pool), DuckDB (via `@duckdb/node-api`
 * in-process engine), and Salesforce (via `jsforce`).
 * Database type is detected from the connection URL format:
 *   - `postgresql://` or `postgres://` → PostgreSQL
 *   - `mysql://` or `mysql2://` → MySQL
 *   - `clickhouse://` or `clickhouses://` → ClickHouse
 *   - `snowflake://` → Snowflake
 *   - `duckdb://` → DuckDB (in-process)
 *   - `salesforce://` → Salesforce (SOQL — uses separate DataSource API)
 *
 * Connections are managed via ConnectionRegistry. The default connection
 * auto-initializes from ATLAS_DATASOURCE_URL on first access.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { _resetWhitelists } from "@atlas/api/lib/semantic";
import { createDuckDBConnection, parseDuckDBUrl } from "./duckdb";

const log = createLogger("db");

/**
 * Resolve the analytics datasource URL from env vars.
 *
 * Priority:
 * 1. ATLAS_DATASOURCE_URL (explicit — always wins)
 * 2. DATABASE_URL_UNPOOLED / DATABASE_URL (when ATLAS_DEMO_DATA=true — share
 *    the Neon-provisioned DB for both internal and analytics)
 *
 * Returns undefined when no datasource is configured.
 */
export function resolveDatasourceUrl(): string | undefined {
  if (process.env.ATLAS_DATASOURCE_URL) return process.env.ATLAS_DATASOURCE_URL;
  if (process.env.ATLAS_DEMO_DATA === "true") {
    return process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  }
  return undefined;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface DBConnection {
  query(sql: string, timeoutMs?: number): Promise<QueryResult>;
  close(): Promise<void>;
}

export type DBType = "postgres" | "mysql" | "clickhouse" | "snowflake" | "duckdb" | "salesforce";

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheckResult {
  status: HealthStatus;
  latencyMs: number;
  message?: string;
  checkedAt: Date;
}

/** Public metadata about a registered connection (no operational handles). */
export interface ConnectionMetadata {
  id: string;
  dbType: DBType;
  description?: string;
  health?: HealthCheckResult;
}

/** Minimum elapsed time from first failure to current failure before marking unhealthy (5 minutes). */
const UNHEALTHY_WINDOW_MS = 5 * 60 * 1000;
/** Number of consecutive failures before marking unhealthy (must also span UNHEALTHY_WINDOW_MS). */
const UNHEALTHY_THRESHOLD = 3;

/**
 * Extract the hostname from a database URL for audit purposes.
 * Never exposes credentials. Returns "(unknown)" on parse failure.
 */
export function extractTargetHost(url: string): string {
  try {
    // Normalize known schemes to http:// so URL parser can handle them
    const normalized = url
      .replace(/^(postgresql|postgres|mysql|mysql2|clickhouse|clickhouses|snowflake|duckdb|salesforce):\/\//, "http://");
    const parsed = new URL(normalized);
    return parsed.hostname || "(unknown)";
  } catch {
    return "(unknown)";
  }
}

/**
 * Rewrite a `clickhouse://` or `clickhouses://` URL to `http://` or `https://`
 * for the @clickhouse/client HTTP transport.
 *
 * - `clickhouses://` → `https://` (TLS)
 * - `clickhouse://`  → `http://`  (plain)
 *
 * Warns if port 8443 (the conventional ClickHouse TLS port) is used with
 * the plain `clickhouse://` scheme, since TLS is likely intended.
 */
export function rewriteClickHouseUrl(url: string): string {
  if (url.startsWith("clickhouses://")) {
    return url.replace(/^clickhouses:\/\//, "https://");
  }
  // Warn on probable TLS-port + plain-scheme mismatch
  try {
    const parsed = new URL(url.replace(/^clickhouse:\/\//, "http://"));
    if (parsed.port === "8443") {
      log.warn(
        "clickhouse:// with port 8443 detected — did you mean clickhouses:// (TLS)? " +
        "Port 8443 is the conventional ClickHouse TLS port."
      );
    }
  } catch {
    // URL parsing failure is handled downstream; skip warning
  }
  return url.replace(/^clickhouse:\/\//, "http://");
}

/**
 * Detect database type from a connection string or ATLAS_DATASOURCE_URL.
 * PostgreSQL URLs start with `postgresql://` or `postgres://`.
 * MySQL URLs start with `mysql://` or `mysql2://`.
 * ClickHouse URLs start with `clickhouse://` or `clickhouses://`.
 * Snowflake URLs start with `snowflake://`.
 * DuckDB URLs start with `duckdb://`.
 * Salesforce URLs start with `salesforce://`.
 * Throws if the URL does not match a supported database type.
 */
export function detectDBType(url?: string): DBType {
  const connStr = url ?? resolveDatasourceUrl() ?? "";
  if (!connStr) {
    throw new Error(
      "No database URL provided. Set ATLAS_DATASOURCE_URL to a PostgreSQL (postgresql://...), MySQL (mysql://...), ClickHouse (clickhouse://... or clickhouses://...), Snowflake (snowflake://...), DuckDB (duckdb://...), or Salesforce (salesforce://...) connection string."
    );
  }
  if (connStr.startsWith("postgresql://") || connStr.startsWith("postgres://")) {
    return "postgres";
  }
  if (connStr.startsWith("mysql://") || connStr.startsWith("mysql2://")) {
    return "mysql";
  }
  if (connStr.startsWith("clickhouse://") || connStr.startsWith("clickhouses://")) {
    return "clickhouse";
  }
  if (connStr.startsWith("snowflake://")) {
    return "snowflake";
  }
  if (connStr.startsWith("duckdb://")) {
    return "duckdb";
  }
  if (connStr.startsWith("salesforce://")) {
    return "salesforce";
  }
  const scheme = connStr.split("://")[0] || "(empty)";
  throw new Error(
    `Unsupported database URL scheme "${scheme}://". ` +
    "ATLAS_DATASOURCE_URL must start with postgresql://, postgres://, mysql://, mysql2://, clickhouse://, clickhouses://, snowflake://, duckdb://, or salesforce://."
  );
}

export interface ConnectionConfig {
  /** Database connection string (postgresql://, mysql://, clickhouse://, snowflake://, duckdb://, or salesforce://). */
  url: string;
  /** PostgreSQL schema name (sets search_path). Ignored for MySQL, ClickHouse, Snowflake, and DuckDB. */
  schema?: string;
  /** Human-readable description shown in the agent system prompt. */
  description?: string;
  /** Max connections in the pool for this datasource. Default 10. */
  maxConnections?: number;
  /** Idle timeout in milliseconds before a connection is closed. Default 30000. Only applies to PostgreSQL pools. */
  idleTimeoutMs?: number;
}

/** Regex for valid SQL identifiers (used for schema name validation). */
const VALID_SQL_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function createPostgresDB(config: ConnectionConfig): DBConnection {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require("pg");

  const pgSchema = config.schema;

  // Validate schema at initialization time to prevent SQL injection
  if (pgSchema && !VALID_SQL_IDENTIFIER.test(pgSchema)) {
    throw new Error(
      `Invalid schema "${pgSchema}". Must be a valid SQL identifier (letters, digits, underscores).`
    );
  }

  const pool = new Pool({
    connectionString: config.url,
    max: config.maxConnections ?? 10,
    idleTimeoutMillis: config.idleTimeoutMs ?? 30000,
  });

  const needsSchema = !!(pgSchema && pgSchema !== "public");

  // Track which physical connections have had search_path set (once per connection,
  // not per query). WeakSet lets GC reclaim entries when pg-pool drops a connection.
  const initializedClients = needsSchema ? new WeakSet<object>() : null;

  // One-time schema existence check, guarded by a shared Promise so concurrent
  // first queries don't all hit pg_namespace redundantly.
  let schemaCheckPromise: Promise<void> | null = null;

  return {
    async query(sql: string, timeoutMs = 30000) {
      const client = await pool.connect();
      try {
        // Verify the schema exists (once, shared across concurrent callers).
        // Must run BEFORE setting search_path so no query executes against a
        // non-existent schema.
        if (needsSchema && !schemaCheckPromise) {
          schemaCheckPromise = (async () => {
            const check = await client.query(
              "SELECT 1 FROM pg_namespace WHERE nspname = $1",
              [pgSchema]
            );
            if (check.rows.length === 0) {
              schemaCheckPromise = null; // allow retry after error
              throw new Error(
                `Schema "${pgSchema}" does not exist in the database. Check ATLAS_SCHEMA in your .env file.`
              );
            }
          })();
        }
        if (schemaCheckPromise) await schemaCheckPromise;

        // Set search_path once per physical connection (not per query)
        if (needsSchema && initializedClients && !initializedClients.has(client)) {
          await client.query(`SET search_path TO "${pgSchema}", public`);
          initializedClients.add(client);
        }

        await client.query(`SET statement_timeout = ${timeoutMs}`);
        const result = await client.query(sql);
        const columns = result.fields.map(
          (f: { name: string }) => f.name
        );
        return { columns, rows: result.rows };
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

function createMySQLDB(config: ConnectionConfig): DBConnection {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mysql = require("mysql2/promise");
  const pool = mysql.createPool({
    uri: config.url,
    connectionLimit: config.maxConnections ?? 10,
    idleTimeout: config.idleTimeoutMs ?? 30000,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });

  return {
    async query(sql: string, timeoutMs = 30000) {
      const conn = await pool.getConnection();
      try {
        // Defense-in-depth: read-only session prevents DML even if validation has a bug
        await conn.execute('SET SESSION TRANSACTION READ ONLY');
        // Per-query timeout via session variable (works for all query shapes including CTEs)
        const safeTimeout = Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs)) : 30000;
        await conn.execute(`SET SESSION MAX_EXECUTION_TIME = ${safeTimeout}`);
        const [rows, fields] = await conn.execute(sql);
        const columns = (fields as { name: string }[]).map((f) => f.name);
        return { columns, rows: rows as Record<string, unknown>[] };
      } finally {
        conn.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

function createClickHouseDB(config: ConnectionConfig): DBConnection {
  let createClient: (opts: Record<string, unknown>) => unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ createClient } = require("@clickhouse/client"));
  } catch {
    throw new Error(
      "ClickHouse support requires the @clickhouse/client package. Install it with: bun add @clickhouse/client"
    );
  }

  const httpUrl = rewriteClickHouseUrl(config.url);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = (createClient as any)({ url: httpUrl });

  return {
    async query(sql: string, timeoutMs = 30000) {
      let result;
      try {
        result = await client.query({
          query: sql,
          format: "JSON",
          clickhouse_settings: {
            max_execution_time: Math.ceil(timeoutMs / 1000),
            readonly: 1,
          },
        });
      } catch (err) {
        throw new Error(`ClickHouse query failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      const json = await result.json();
      if (!json.meta || !Array.isArray(json.meta)) {
        throw new Error(
          "ClickHouse query returned an unexpected response: missing or invalid 'meta' field. " +
          "Ensure the query uses JSON format and returns a valid result set."
        );
      }
      const columns = (json.meta as { name: string }[]).map((m: { name: string }) => m.name);
      return { columns, rows: json.data as Record<string, unknown>[] };
    },
    async close() {
      try {
        await client.close();
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "Failed to close ClickHouse client"
        );
      }
    },
  };
}

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

function createSnowflakeDB(config: ConnectionConfig): DBConnection {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const snowflake = require("snowflake-sdk") as typeof import("snowflake-sdk");

  // Suppress noisy SDK logging
  snowflake.configure({ logLevel: "ERROR" });

  const opts = parseSnowflakeURL(config.url);

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

  log.warn(
    "Snowflake has no session-level read-only mode — Atlas enforces SELECT-only " +
    "via SQL validation (regex + AST). For defense-in-depth, configure the " +
    "Snowflake connection with a role granted SELECT privileges only " +
    "(e.g. GRANT SELECT ON ALL TABLES IN SCHEMA <schema> TO ROLE atlas_readonly).",
  );

  return {
    async query(sql: string, timeoutMs = 30000) {
      const timeoutSec = Math.max(1, Math.floor(timeoutMs / 1000));
      return pool.use(async (conn) => {
        // Set session-level statement timeout (seconds)
        await new Promise<void>((resolve, reject) => {
          conn.execute({
            sqlText: `ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = ${timeoutSec}`,
            complete: (err) => (err ? reject(err) : resolve()),
          });
        });

        // Tag all Atlas queries for audit trail in QUERY_HISTORY (best-effort —
        // insufficient privileges or transient errors should not block the query)
        try {
          await new Promise<void>((resolve, reject) => {
            conn.execute({
              sqlText: `ALTER SESSION SET QUERY_TAG = 'atlas:readonly'`,
              complete: (err) => (err ? reject(err) : resolve()),
            });
          });
        } catch (tagErr) {
          log.warn(`Failed to set QUERY_TAG on Snowflake session — query will proceed without audit tag: ${tagErr instanceof Error ? tagErr.message : String(tagErr)}`);
        }

        // Execute the actual query
        return new Promise<QueryResult>((resolve, reject) => {
          conn.execute({
            sqlText: sql,
            complete: (err, stmt, rows) => {
              if (err) return reject(err);
              const columns = (stmt?.getColumns() ?? []).map((c) => c.getName());
              const resultRows = (rows ?? []) as Record<string, unknown>[];
              resolve({ columns, rows: resultRows });
            },
          });
        });
      });
    },
    async close() {
      await pool.drain();
      await pool.clear();
    },
  };
}

function createConnection(dbType: DBType, config: ConnectionConfig): DBConnection {
  switch (dbType) {
    case "postgres":
      return createPostgresDB(config);
    case "mysql":
      return createMySQLDB(config);
    case "clickhouse":
      return createClickHouseDB(config);
    case "snowflake":
      return createSnowflakeDB(config);
    case "duckdb":
      return createDuckDBConnection(parseDuckDBUrl(config.url));
    case "salesforce":
      throw new Error(
        "Salesforce uses SOQL, not SQL. Use the Salesforce DataSource API instead. " +
        "See packages/api/src/lib/db/salesforce.ts for the Salesforce adapter."
      );
    default: {
      const _exhaustive: never = dbType;
      throw new Error(`Unknown database type: ${_exhaustive}`);
    }
  }
}

// --- Connection Registry ---

interface RegistryEntry {
  conn: DBConnection;
  dbType: DBType;
  description?: string;
  lastQueryAt: number;
  config?: ConnectionConfig;
  targetHost: string;
  consecutiveFailures: number;
  lastHealth: HealthCheckResult | null;
  firstFailureAt: number | null;
  /** Custom query validator (mirrors QueryValidationResult from plugin-sdk). */
  validate?: (query: string) => { valid: boolean; reason?: string };
}

/**
 * Named connection registry. Connections can be created from a ConnectionConfig
 * (URL + optional schema) via register(), or injected as pre-built DBConnection
 * instances via registerDirect(). The "default" connection auto-initializes from
 * ATLAS_DATASOURCE_URL on first access via getDefault().
 */
export class ConnectionRegistry {
  private entries = new Map<string, RegistryEntry>();
  private maxTotalConnections = 100;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  setMaxTotalConnections(n: number): void {
    this.maxTotalConnections = n;
  }

  private _totalPoolSlots(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      // ClickHouse uses a stateless HTTP client and DuckDB is in-process —
      // neither maintains a connection pool, so count them as 1 slot each.
      if (entry.dbType === "clickhouse" || entry.dbType === "duckdb") {
        total += 1;
      } else {
        total += entry.config?.maxConnections ?? 10;
      }
    }
    return total;
  }

  private _evictLRU(): void {
    let oldest: { id: string; entry: RegistryEntry } | null = null;
    for (const [id, entry] of this.entries) {
      if (id === "default") continue;
      if (!oldest || entry.lastQueryAt < oldest.entry.lastQueryAt) {
        oldest = { id, entry };
      }
    }
    if (oldest) {
      log.info({ connectionId: oldest.id }, "Evicting LRU connection to free pool capacity");
      oldest.entry.conn.close().catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err), connectionId: oldest!.id }, "Failed to close evicted connection");
      });
      this.entries.delete(oldest.id);
    }
  }

  register(id: string, config: ConnectionConfig): void {
    const dbType = detectDBType(config.url);
    const newConn = createConnection(dbType, config);
    const existing = this.entries.get(id);
    const targetHost = extractTargetHost(config.url);

    // Check LRU cap — only for new entries (re-registrations replace in-place)
    if (!existing) {
      const newSlots = config.maxConnections ?? 10;
      while (this._totalPoolSlots() + newSlots > this.maxTotalConnections && this.entries.size > 0) {
        this._evictLRU();
      }
    }

    this.entries.set(id, {
      conn: newConn,
      dbType,
      description: config.description,
      lastQueryAt: Date.now(),
      config,
      targetHost,
      consecutiveFailures: 0,
      lastHealth: null,
      firstFailureAt: null,
    });

    if (existing) {
      existing.conn.close().catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err), connectionId: id }, "Failed to close previous connection during re-registration");
      });
    }
  }

  /** Register a pre-built connection (e.g. for benchmark harness or datasource plugin). */
  registerDirect(
    id: string,
    conn: DBConnection,
    dbType: DBType,
    description?: string,
    validate?: (query: string) => { valid: boolean; reason?: string },
  ): void {
    const existing = this.entries.get(id);
    this.entries.set(id, {
      conn,
      dbType,
      description,
      lastQueryAt: Date.now(),
      targetHost: "(direct)",
      consecutiveFailures: 0,
      lastHealth: null,
      firstFailureAt: null,
      validate,
    });
    if (existing) {
      existing.conn.close().catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err), connectionId: id }, "Failed to close previous connection during re-registration");
      });
    }
  }

  get(id: string): DBConnection {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`Connection "${id}" is not registered.`);
    }
    entry.lastQueryAt = Date.now();
    return entry.conn;
  }

  getDBType(id: string): DBType {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Connection "${id}" is not registered.`);
    return entry.dbType;
  }

  /** Return the hostname (without credentials) for a registered connection. Returns "(unknown)" if not registered. */
  getTargetHost(id: string): string {
    const entry = this.entries.get(id);
    if (!entry) return "(unknown)";
    return entry.targetHost;
  }

  /** Return the custom query validator for a connection, if one was registered. Callers must verify connection existence first. */
  getValidator(id: string): ((query: string) => { valid: boolean; reason?: string }) | undefined {
    return this.entries.get(id)?.validate;
  }

  getDefault(): DBConnection {
    if (!this.entries.has("default")) {
      const url = resolveDatasourceUrl();
      if (!url) {
        throw new Error(
          "No analytics datasource configured. Set ATLAS_DATASOURCE_URL to a PostgreSQL, MySQL, ClickHouse, Snowflake, DuckDB, or Salesforce connection string."
        );
      }
      this.register("default", {
        url,
        schema: process.env.ATLAS_SCHEMA,
      });
    }
    const entry = this.entries.get("default")!;
    entry.lastQueryAt = Date.now();
    return entry.conn;
  }

  list(): string[] {
    return Array.from(this.entries.keys());
  }

  /** Metadata for all registered connections. Used by the agent system prompt. */
  describe(): ConnectionMetadata[] {
    return Array.from(this.entries.entries()).map(([id, entry]) => ({
      id,
      dbType: entry.dbType,
      description: entry.description,
      ...(entry.lastHealth ? { health: entry.lastHealth } : {}),
    }));
  }

  /** Run a health check for a specific connection. */
  async healthCheck(id: string): Promise<HealthCheckResult> {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`Connection "${id}" is not registered.`);
    }

    const start = performance.now();
    try {
      await entry.conn.query("SELECT 1", 5000);
      const latencyMs = Math.round(performance.now() - start);
      entry.consecutiveFailures = 0;
      entry.firstFailureAt = null;
      const result: HealthCheckResult = {
        status: "healthy",
        latencyMs,
        checkedAt: new Date(),
      };
      entry.lastHealth = result;
      return result;
    } catch (err) {
      const latencyMs = Math.round(performance.now() - start);
      entry.consecutiveFailures++;
      if (entry.firstFailureAt === null) {
        entry.firstFailureAt = Date.now();
      }

      const failureSpan = Date.now() - entry.firstFailureAt;
      let status: HealthStatus;
      if (entry.consecutiveFailures >= UNHEALTHY_THRESHOLD && failureSpan >= UNHEALTHY_WINDOW_MS) {
        status = "unhealthy";
      } else {
        status = "degraded";
      }

      const result: HealthCheckResult = {
        status,
        latencyMs,
        message: err instanceof Error ? err.message : String(err),
        checkedAt: new Date(),
      };
      entry.lastHealth = result;
      return result;
    }
  }

  /** Start periodic health checks for all connections. Idempotent. */
  startHealthChecks(intervalMs = 60_000): void {
    if (this.healthCheckInterval) return;
    this.healthCheckInterval = setInterval(() => {
      for (const id of this.entries.keys()) {
        this.healthCheck(id).catch((err) => {
          log.warn({ err: err instanceof Error ? err.message : String(err), connectionId: id }, "Periodic health check failed");
        });
      }
    }, intervalMs);
    this.healthCheckInterval.unref();
  }

  /** Stop periodic health checks. */
  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Graceful shutdown: stop health checks, close all connections (awaited), and
   * reset whitelists. Use this in production shutdown paths instead of _reset().
   */
  async shutdown(): Promise<void> {
    this.stopHealthChecks();
    const closing: Promise<void>[] = [];
    for (const [id, entry] of this.entries.entries()) {
      closing.push(
        entry.conn.close().catch((err) => {
          log.warn({ err: err instanceof Error ? err.message : String(err), connectionId: id }, "Failed to close connection during shutdown");
        }),
      );
    }
    await Promise.all(closing);
    this.entries.clear();
    _resetWhitelists();
  }

  /** Clears all registered connections and resets the table whitelist cache. Used during graceful shutdown, tests, and the benchmark harness. */
  _reset(): void {
    this.stopHealthChecks();
    for (const [id, entry] of this.entries.entries()) {
      entry.conn.close().catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err), connectionId: id }, "Failed to close connection during registry reset");
      });
    }
    this.entries.clear();
    _resetWhitelists();
  }
}

export const connections = new ConnectionRegistry();

/** Backward-compatible singleton — delegates to the connection registry. */
export function getDB(): DBConnection {
  return connections.getDefault();
}
