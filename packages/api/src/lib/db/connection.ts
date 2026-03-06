/**
 * Database connection factory and registry.
 *
 * Core adapters: PostgreSQL (via `pg` Pool) and MySQL (via `mysql2/promise`).
 * Additional databases (ClickHouse, Snowflake, DuckDB, Salesforce) are
 * supported via datasource plugins — see `plugins/` directory.
 *
 * Database type is detected from the connection URL format:
 *   - `postgresql://` or `postgres://` → PostgreSQL
 *   - `mysql://` or `mysql2://` → MySQL
 *
 * Non-core URL schemes require a registered datasource plugin.
 *
 * Connections are managed via ConnectionRegistry. The default connection
 * auto-initializes from ATLAS_DATASOURCE_URL on first access.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { _resetWhitelists } from "@atlas/api/lib/semantic";

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

export type DBType = "postgres" | "mysql" | (string & {});

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
      .replace(/^(postgresql|postgres|mysql|mysql2):\/\//, "http://")
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "http://");
    const parsed = new URL(normalized);
    return parsed.hostname || "(unknown)";
  } catch {
    return "(unknown)";
  }
}

/**
 * Detect database type from a connection string or ATLAS_DATASOURCE_URL.
 *
 * Core types: `postgresql://` or `postgres://` → "postgres", `mysql://` or
 * `mysql2://` → "mysql". Unknown URL schemes throw with a migration hint
 * suggesting the appropriate datasource plugin.
 */
export function detectDBType(url?: string): DBType {
  const connStr = url ?? resolveDatasourceUrl() ?? "";
  if (!connStr) {
    throw new Error(
      "No database URL provided. Set ATLAS_DATASOURCE_URL to a PostgreSQL (postgresql://...) or MySQL (mysql://...) connection string, or register a datasource plugin for other databases."
    );
  }
  if (connStr.startsWith("postgresql://") || connStr.startsWith("postgres://")) {
    return "postgres";
  }
  if (connStr.startsWith("mysql://") || connStr.startsWith("mysql2://")) {
    return "mysql";
  }
  const rawScheme = connStr.split("://")[0] || "(empty)";
  // Normalize TLS variants (e.g. clickhouses → clickhouse) for the plugin hint
  const baseScheme = rawScheme.replace(/s$/, "");
  throw new Error(
    `Unsupported database URL scheme "${rawScheme}://". ` +
    `This adapter is now a plugin. Install the appropriate datasource plugin ` +
    `(e.g. @atlas/plugin-${baseScheme}) and add it to the plugins array in atlas.config.ts. ` +
    `Ensure the plugin is listed before any datasources that use it. ` +
    `Core adapters support postgresql:// and mysql:// only.`
  );
}

export interface ConnectionConfig {
  /** Database connection string (postgresql:// or mysql:// for core; other schemes via plugins). */
  url: string;
  /** PostgreSQL schema name (sets search_path). Ignored for MySQL and plugin-managed connections. */
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

function createConnection(dbType: DBType, config: ConnectionConfig): DBConnection {
  switch (dbType) {
    case "postgres":
      return createPostgresDB(config);
    case "mysql":
      return createMySQLDB(config);
    default:
      throw new Error(
        `Unsupported database type "${dbType}". ` +
        `This adapter is now a plugin. Install the appropriate datasource plugin ` +
        `and add it to the plugins array in atlas.config.ts.`
      );
  }
}

// --- Connection Registry ---

/** Optional plugin metadata for parser dialect and forbidden patterns. */
export interface ConnectionPluginMeta {
  /** node-sql-parser dialect string (e.g. "PostgresQL", "BigQuery"). */
  parserDialect?: string;
  /** Additional regex patterns to block beyond the base DML/DDL guard. */
  forbiddenPatterns?: RegExp[];
}

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
  /** Plugin-provided metadata for SQL validation. */
  pluginMeta?: ConnectionPluginMeta;
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
      // Direct-registered connections (plugins) don't have config and manage
      // their own pooling — count as 1 slot instead of the default 10.
      total += entry.config?.maxConnections ?? (entry.targetHost === "(direct)" ? 1 : 10);
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
    meta?: ConnectionPluginMeta,
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
      pluginMeta: meta,
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

  /** Return the plugin-provided parser dialect for a connection, if any. */
  getParserDialect(id: string): string | undefined {
    return this.entries.get(id)?.pluginMeta?.parserDialect;
  }

  /** Return plugin-provided forbidden patterns for a connection. Empty array if none. */
  getForbiddenPatterns(id: string): RegExp[] {
    return this.entries.get(id)?.pluginMeta?.forbiddenPatterns ?? [];
  }

  getDefault(): DBConnection {
    if (!this.entries.has("default")) {
      const url = resolveDatasourceUrl();
      if (!url) {
        throw new Error(
          "No analytics datasource configured. Set ATLAS_DATASOURCE_URL to a PostgreSQL or MySQL connection string, or register a datasource plugin."
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
