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

import { matchError } from "@useatlas/types";
import { Effect, Schedule, Duration, Fiber } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { _resetWhitelists } from "@atlas/api/lib/semantic";
import type { HealthStatus } from "@atlas/api/lib/connection-types";

export type { HealthStatus } from "@atlas/api/lib/connection-types";

const log = createLogger("db");

// --- Typed error classes for connection lookup/configuration ---

/** Thrown when a connection ID is not found in the registry. */
export class ConnectionNotRegisteredError extends Error {
  constructor(id: string) {
    super(`Connection "${id}" is not registered.`);
    this.name = "ConnectionNotRegisteredError";
  }
}

/** Thrown when creating an org pool would exceed maxTotalConnections. */
export class PoolCapacityExceededError extends Error {
  constructor(
    public readonly currentSlots: number,
    public readonly requestedSlots: number,
    public readonly maxTotalConnections: number,
  ) {
    super(
      `Cannot create org pool: would use ${currentSlots + requestedSlots} connection slots, exceeding maxTotalConnections (${maxTotalConnections}). ` +
      `Reduce pool.perOrg.maxConnections, pool.perOrg.maxOrgs, or increase maxTotalConnections.`
    );
    this.name = "PoolCapacityExceededError";
  }
}

/** Thrown when no analytics datasource URL is configured. */
export class NoDatasourceConfiguredError extends Error {
  constructor() {
    super(
      "No analytics datasource configured. Set ATLAS_DATASOURCE_URL to a PostgreSQL or MySQL connection string, or register a datasource plugin."
    );
    this.name = "NoDatasourceConfiguredError";
  }
}

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

export type { PoolStats, OrgPoolMetrics } from "@useatlas/types";

export interface DBConnection {
  query(sql: string, timeoutMs?: number): Promise<QueryResult>;
  close(): Promise<void>;
  /** Return real-time pool counters, or null if not available. Postgres returns live stats; MySQL and plugin connections return null. */
  getPoolStats?(): import("@useatlas/types").PoolStats | null;
}

export type DBType = "postgres" | "mysql" | (string & {});

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

/** Number of warmup probes per connection at startup. Configurable via ATLAS_POOL_WARMUP. */
function getPoolWarmup(): number {
  const raw = parseInt(process.env.ATLAS_POOL_WARMUP ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2;
}

/** Consecutive error threshold before auto-drain. Configurable via ATLAS_POOL_DRAIN_THRESHOLD. */
function getPoolDrainThreshold(): number {
  const raw = parseInt(process.env.ATLAS_POOL_DRAIN_THRESHOLD ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/** Cooldown between drain operations to prevent drain storms. */
const DRAIN_COOLDOWN_MS = 30_000;

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
  } catch (err) {
    log.debug({ err, url: url.slice(0, 50) }, "Failed to extract target host from URL");
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
    `(e.g. @useatlas/${baseScheme}) and add it to the plugins array in atlas.config.ts. ` +
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

  // Normalize sslmode: pg v8 treats 'require' as 'verify-full' but warns about it.
  // Explicitly rewrite to 'verify-full' to suppress the deprecation warning.
  let connString = config.url;
  if (connString) {
    connString = connString.replace(
      /([?&])sslmode=require(?=&|$)/,
      "$1sslmode=verify-full",
    );
  }

  const pool = new Pool({
    connectionString: connString,
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
              let schemaHint = "";
              try {
                const schemasResult = await client.query(
                  "SELECT schema_name FROM information_schema.schemata " +
                  "WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast') " +
                  "AND schema_name NOT LIKE 'pg_temp_%' AND schema_name NOT LIKE 'pg_toast_temp_%' " +
                  "ORDER BY schema_name"
                );
                const schemas = schemasResult.rows.map(
                  (r: { schema_name: string }) => r.schema_name
                );
                if (schemas.length > 0) {
                  schemaHint = ` Available schemas: ${schemas.join(", ")}.`;
                }
              } catch (schemaListErr) {
                // fallback: schema listing may fail due to permissions — generic message is sufficient
                log.warn({ err: schemaListErr instanceof Error ? schemaListErr.message : String(schemaListErr) }, "Schema listing failed during schema validation — falling back to generic error message");
              }
              throw new Error(
                `Schema "${pgSchema}" does not exist in the database.${schemaHint} Check ATLAS_SCHEMA in your .env file.`
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
    getPoolStats(): import("@useatlas/types").PoolStats | null {
      return {
        totalSize: pool.totalCount ?? 0,
        activeCount: (pool.totalCount ?? 0) - (pool.idleCount ?? 0),
        idleCount: pool.idleCount ?? 0,
        waitingCount: pool.waitingCount ?? 0,
      };
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
    getPoolStats(): import("@useatlas/types").PoolStats | null {
      // mysql2 pool internals are not part of the public API — return null
      return null;
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
  /** Custom query validator (mirrors QueryValidationResult from plugin-sdk). May be sync or async. */
  validate?: (query: string) => { valid: boolean; reason?: string } | Promise<{ valid: boolean; reason?: string }>;
  /** Plugin-provided metadata for SQL validation. */
  pluginMeta?: ConnectionPluginMeta;
  /** Total queries executed through this connection (lifetime, survives drain). */
  totalQueries: number;
  /** Total query errors (lifetime, survives drain). */
  totalErrors: number;
  /** Cumulative query wall-clock time in ms (lifetime, survives drain). */
  totalQueryTimeMs: number;
  /** Epoch ms of last drain, or null if never drained. Converted to ISO string in wire format. */
  lastDrainAt: number | null;
  /** Consecutive query failures — separate from consecutiveFailures (which includes health checks). Used for auto-drain threshold. */
  consecutiveQueryFailures: number;
}

/** Configuration for per-org pool isolation. */
export interface OrgPoolSettings {
  /** Whether org-scoped pooling is active. Only true when pool.perOrg is explicitly configured. */
  enabled: boolean;
  maxConnections: number;
  idleTimeoutMs: number;
  maxOrgs: number;
  warmupProbes: number;
  drainThreshold: number;
}

const DEFAULT_ORG_POOL_SETTINGS: OrgPoolSettings = {
  enabled: false,
  maxConnections: 5,
  idleTimeoutMs: 30000,
  maxOrgs: 50,
  warmupProbes: 2,
  drainThreshold: 5,
};

/**
 * Named connection registry with tenant-scoped pool isolation.
 *
 * Base connections are created from a ConnectionConfig (URL + optional schema) via
 * register(), or injected as pre-built DBConnection instances via registerDirect().
 * The "default" connection auto-initializes from ATLAS_DATASOURCE_URL on first access.
 *
 * When an orgId is provided via getForOrg(), the registry creates an isolated pool
 * instance for that org+connection pair, using the same URL/config as the base
 * connection but with org-specific pool limits. This prevents noisy-neighbor issues
 * in SaaS mode. When no orgId is present (self-hosted), the existing single pool
 * is used unchanged.
 */
export class ConnectionRegistry {
  private entries = new Map<string, RegistryEntry>();
  private maxTotalConnections = 100;
  private healthFiber: Fiber.RuntimeFiber<void, never> | null = null;
  /** Connections currently in drain cooldown — managed via Effect.sleep. */
  private drainCooldownSet = new Set<string>();
  /** Tracks cooldown expiry timestamps for remaining-time messages. */
  private drainCooldownExpiry = new Map<string, number>();

  // --- Org-scoped pool isolation ---
  /** Org pool entries keyed by "orgId:connectionId". */
  private orgEntries = new Map<string, RegistryEntry>();
  /** Monotonic access counter per orgId — used for LRU eviction. Monotonic counter
   *  avoids issues with Date.now() returning the same value for synchronous calls. */
  private orgAccessSeq = new Map<string, number>();
  /** Next sequence number for org access ordering. */
  private _orgSeq = 0;
  /** Per-org pool configuration. */
  private orgPoolSettings: OrgPoolSettings = { ...DEFAULT_ORG_POOL_SETTINGS };

  setMaxTotalConnections(n: number): void {
    this.maxTotalConnections = n;
  }

  /** Configure per-org pool settings. Called from applyDatasources when pool.perOrg is set. Marks org pooling as enabled. */
  setOrgPoolConfig(config: Partial<Omit<OrgPoolSettings, "enabled">>): void {
    const merged = { ...this.orgPoolSettings, ...config, enabled: true };
    if (merged.maxConnections < 1 || merged.maxOrgs < 1 || merged.drainThreshold < 1) {
      throw new Error("Invalid org pool config: maxConnections, maxOrgs, and drainThreshold must be >= 1");
    }
    this.orgPoolSettings = merged;

    // Warn at startup if theoretical org pool capacity exceeds maxTotalConnections.
    // datasource count = base entries (or 1 if none registered yet)
    const numDatasources = Math.max(this.entries.size, 1);
    const theoreticalSlots = merged.maxOrgs * merged.maxConnections * numDatasources;
    if (theoreticalSlots > this.maxTotalConnections) {
      const severity = theoreticalSlots > this.maxTotalConnections * 2 ? "error" : "warn";
      const logFn = severity === "error" ? log.error.bind(log) : log.warn.bind(log);
      logFn(
        {
          maxOrgs: merged.maxOrgs,
          maxConnections: merged.maxConnections,
          numDatasources,
          theoreticalSlots,
          maxTotalConnections: this.maxTotalConnections,
        },
        "Org pool capacity (%d orgs × %d conns × %d datasources = %d slots) exceeds maxTotalConnections (%d). " +
        "LRU eviction and capacity checks will prevent exceeding the limit, but consider adjusting pool.perOrg or maxTotalConnections.",
        merged.maxOrgs,
        merged.maxConnections,
        numDatasources,
        theoreticalSlots,
        this.maxTotalConnections,
      );
    }
  }

  /** Whether org-scoped pooling is enabled (pool.perOrg configured). */
  isOrgPoolingEnabled(): boolean {
    return this.orgPoolSettings.enabled;
  }

  /** Return the current org pool settings (for admin API / diagnostics). */
  getOrgPoolConfig(): Readonly<OrgPoolSettings> {
    return this.orgPoolSettings;
  }

  /** Return pool capacity warnings for the admin health check. Empty array when healthy. */
  getPoolWarnings(): string[] {
    const warnings: string[] = [];
    if (!this.orgPoolSettings.enabled) return warnings;

    const numDatasources = Math.max(this.entries.size, 1);
    const theoreticalSlots = this.orgPoolSettings.maxOrgs * this.orgPoolSettings.maxConnections * numDatasources;
    if (theoreticalSlots > this.maxTotalConnections) {
      const ratio = Math.round(theoreticalSlots / this.maxTotalConnections * 10) / 10;
      warnings.push(
        `Org pool capacity (${this.orgPoolSettings.maxOrgs} orgs × ${this.orgPoolSettings.maxConnections} conns × ${numDatasources} datasources = ${theoreticalSlots} slots) ` +
        `exceeds maxTotalConnections (${this.maxTotalConnections}) by ${ratio}×. ` +
        `LRU eviction prevents exceeding the limit, but tenants may hit PoolCapacityExceededError under load.`
      );
    }
    return warnings;
  }

  private _orgKey(orgId: string, connectionId: string): string {
    if (process.env.NODE_ENV !== "production") {
      if (orgId.includes(":") || connectionId.includes(":")) {
        throw new Error(`orgId/connectionId must not contain ':' — got orgId="${orgId}", connectionId="${connectionId}"`);
      }
    }
    return `${orgId}:${connectionId}`;
  }

  private _parseOrgKey(key: string): { orgId: string; connectionId: string } {
    const sepIdx = key.indexOf(":");
    return { orgId: key.slice(0, sepIdx), connectionId: key.slice(sepIdx + 1) };
  }

  /**
   * Get an org-scoped connection pool. Lazy-creates on first access.
   *
   * Each org gets its own pool instance using the same URL/config as the base
   * connection but with org-specific pool limits (maxConnections, idleTimeoutMs).
   * Plugin-managed connections (no config) are returned directly since plugins
   * manage their own pooling.
   *
   * Warmup probes fire asynchronously in the background after pool creation.
   * LRU eviction removes the least recently used org's pools when maxOrgs is exceeded.
   */
  getForOrg(orgId: string, connectionId: string = "default"): DBConnection {
    const key = this._orgKey(orgId, connectionId);
    const existing = this.orgEntries.get(key);
    if (existing) {
      existing.lastQueryAt = Date.now();
      this.orgAccessSeq.set(orgId, ++this._orgSeq);
      return existing.conn;
    }

    // Ensure the base connection exists (trigger lazy init for "default")
    if (connectionId === "default" && !this.entries.has("default")) {
      this.getDefault();
    }

    const baseEntry = this.entries.get(connectionId);
    if (!baseEntry) {
      throw new ConnectionNotRegisteredError(connectionId);
    }

    // Plugin-managed connections don't have config — return base directly
    if (!baseEntry.config) {
      return baseEntry.conn;
    }

    // Evict LRU org if at org-count capacity
    this._evictLRUOrg();

    // Evict LRU orgs if at total connection slot capacity.
    // Mirrors the while-loop in register() for base connections.
    const newSlots = this.orgPoolSettings.maxConnections;
    while (this._totalPoolSlots() + newSlots > this.maxTotalConnections && this.orgAccessSeq.size > 0) {
      const before = this.orgAccessSeq.size;
      this._evictLRUOrgUnconditional();
      if (this.orgAccessSeq.size === before) break; // no more evictable orgs
    }

    // Hard check after all eviction attempts
    const currentSlots = this._totalPoolSlots();
    if (currentSlots + newSlots > this.maxTotalConnections) {
      throw new PoolCapacityExceededError(currentSlots, newSlots, this.maxTotalConnections);
    }

    // Create org-scoped pool with org-specific limits
    const orgConfig: ConnectionConfig = {
      ...baseEntry.config,
      maxConnections: this.orgPoolSettings.maxConnections,
      idleTimeoutMs: this.orgPoolSettings.idleTimeoutMs,
    };

    let newConn: DBConnection;
    try {
      newConn = createConnection(baseEntry.dbType, orgConfig);
    } catch (err) {
      log.error(
        { orgId, connectionId, err: err instanceof Error ? err.message : String(err) },
        "Failed to create org-scoped pool after LRU eviction",
      );
      throw err;
    }
    const entry: RegistryEntry = {
      conn: newConn,
      dbType: baseEntry.dbType,
      description: baseEntry.description,
      lastQueryAt: Date.now(),
      config: orgConfig,
      targetHost: baseEntry.targetHost,
      consecutiveFailures: 0,
      lastHealth: null,
      firstFailureAt: null,
      validate: baseEntry.validate,
      pluginMeta: baseEntry.pluginMeta,
      totalQueries: 0,
      totalErrors: 0,
      totalQueryTimeMs: 0,
      lastDrainAt: null,
      consecutiveQueryFailures: 0,
    };

    this.orgEntries.set(key, entry);
    this.orgAccessSeq.set(orgId, ++this._orgSeq);
    log.info({ orgId, connectionId }, "Created org-scoped connection pool");

    // Fire warmup probes in background (don't block the first request)
    if (this.orgPoolSettings.warmupProbes > 0) {
      this._warmupEntry(entry, this.orgPoolSettings.warmupProbes, { orgId, connectionId });
    }

    return newConn;
  }

  /** Check if an org-scoped pool exists for the given org + connection. */
  hasOrgPool(orgId: string, connectionId: string = "default"): boolean {
    return this.orgEntries.has(this._orgKey(orgId, connectionId));
  }

  /** Return all org IDs that have active pools. */
  listOrgs(): string[] {
    return Array.from(this.orgAccessSeq.keys());
  }

  /** Return connection IDs with active pools for a specific org. */
  listOrgConnections(orgId: string): string[] {
    const prefix = `${orgId}:`;
    const connections: string[] = [];
    for (const key of this.orgEntries.keys()) {
      if (key.startsWith(prefix)) {
        connections.push(key.slice(prefix.length));
      }
    }
    return connections;
  }

  /** Evict the least recently used org's pools when maxOrgs is exceeded. */
  private _evictLRUOrg(): void {
    if (this.orgAccessSeq.size < this.orgPoolSettings.maxOrgs) return;
    this._evictLRUOrgUnconditional();
  }

  /** Unconditionally evict the least recently used org's pools. */
  private _evictLRUOrgUnconditional(): void {
    let lruOrg: string | null = null;
    let lruSeq = Infinity;
    for (const [orgId, seq] of this.orgAccessSeq) {
      if (seq < lruSeq) {
        lruSeq = seq;
        lruOrg = orgId;
      }
    }

    if (lruOrg) {
      log.info({ orgId: lruOrg }, "Evicting LRU org pools to free capacity");
      this._closeOrgPools(lruOrg);
    }
  }

  /** Close all pools for a specific org (used by LRU eviction and drainOrg). */
  private _closeOrgPools(orgId: string): void {
    const prefix = `${orgId}:`;
    const keysToDelete: string[] = [];
    for (const [key, entry] of this.orgEntries) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
        entry.conn.close().catch((err) => {
          log.error({ key, err: err instanceof Error ? err.message : String(err) }, "Failed to close org pool — connections may be leaked");
        });
      }
    }
    for (const key of keysToDelete) {
      this.orgEntries.delete(key);
    }
    this.orgAccessSeq.delete(orgId);
  }

  /** Run warmup probes on a single entry (used for org pool warmup). Never rejects — logs failures. */
  private async _warmupEntry(entry: RegistryEntry, count: number, context?: { orgId?: string; connectionId?: string }): Promise<void> {
    let failures = 0;
    for (let i = 0; i < count; i++) {
      try {
        await entry.conn.query("SELECT 1", 5000);
      } catch (err) {
        failures++;
        log.warn({ probe: i + 1, total: count, err: err instanceof Error ? err.message : String(err), ...context }, "Warmup probe failed");
      }
    }
    if (failures === count && count > 0) {
      log.error({ failures, total: count, ...context }, "All warmup probes failed — pool may be unhealthy");
    }
  }

  private _totalPoolSlots(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      // Direct-registered connections (plugins) don't have config and manage
      // their own pooling — count as 1 slot instead of the default 10.
      total += entry.config?.maxConnections ?? (entry.targetHost === "(direct)" ? 1 : 10);
    }
    // Include org pool slots — each org pool uses its own maxConnections setting
    for (const entry of this.orgEntries.values()) {
      total += entry.config?.maxConnections ?? 1;
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
      const oldestId = oldest.id;
      log.info({ connectionId: oldestId }, "Evicting LRU connection to free pool capacity");
      oldest.entry.conn.close().catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err), connectionId: oldestId }, "Failed to close evicted connection");
      });
      this.entries.delete(oldestId);
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
      totalQueries: 0,
      totalErrors: 0,
      totalQueryTimeMs: 0,
      lastDrainAt: null,
      consecutiveQueryFailures: 0,
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
    validate?: (query: string) => { valid: boolean; reason?: string } | Promise<{ valid: boolean; reason?: string }>,
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
      totalQueries: 0,
      totalErrors: 0,
      totalQueryTimeMs: 0,
      lastDrainAt: null,
      consecutiveQueryFailures: 0,
    });
    if (existing) {
      existing.conn.close().catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err), connectionId: id }, "Failed to close previous connection during re-registration");
      });
    }
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  unregister(id: string): boolean {
    if (id === "default") return false;
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.conn.close().catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), connectionId: id }, "Failed to close connection during unregister");
    });
    this.entries.delete(id);
    _resetWhitelists();
    return true;
  }

  get(id: string): DBConnection {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new ConnectionNotRegisteredError(id);
    }
    entry.lastQueryAt = Date.now();
    return entry.conn;
  }

  /** Record a query execution (success or failure) for metrics tracking. When orgId is provided, records against the org pool entry. */
  recordQuery(id: string, durationMs: number, orgId?: string): void {
    const entry = orgId
      ? this.orgEntries.get(this._orgKey(orgId, id))
      : this.entries.get(id);
    if (!entry) return;
    entry.totalQueries++;
    entry.totalQueryTimeMs += durationMs;
  }

  /** Record a query error for metrics tracking and auto-drain evaluation. When orgId is provided, operates on the org pool entry. */
  recordError(id: string, orgId?: string): void {
    const entry = orgId
      ? this.orgEntries.get(this._orgKey(orgId, id))
      : this.entries.get(id);
    if (!entry) return;
    entry.totalErrors++;
    entry.consecutiveQueryFailures++;

    // Auto-drain when consecutive query failures exceed threshold
    const threshold = orgId ? this.orgPoolSettings.drainThreshold : getPoolDrainThreshold();
    if (entry.consecutiveQueryFailures >= threshold && entry.config) {
      const drainKey = orgId ? this._orgKey(orgId, id) : id;
      if (this.drainCooldownSet.has(drainKey)) {
        log.debug({ connectionId: id, orgId }, "Pool drain skipped — cooldown active");
        return;
      }
      log.warn({ connectionId: id, orgId, consecutiveQueryFailures: entry.consecutiveQueryFailures }, "Pool drain triggered: consecutive error threshold exceeded");
      this._drainAndRecreate(drainKey, entry);
      this._startDrainCooldown(drainKey);
    }
  }

  /** Reset consecutive failure counters (called on successful query). When orgId is provided, operates on the org pool entry. */
  recordSuccess(id: string, orgId?: string): void {
    const entry = orgId
      ? this.orgEntries.get(this._orgKey(orgId, id))
      : this.entries.get(id);
    if (entry) {
      entry.consecutiveFailures = 0;
      entry.consecutiveQueryFailures = 0;
      entry.firstFailureAt = null;
    }
  }

  getDBType(id: string): DBType {
    const entry = this.entries.get(id);
    if (!entry) throw new ConnectionNotRegisteredError(id);
    return entry.dbType;
  }

  /** Return the hostname (without credentials) for a registered connection. Returns "(unknown)" if not registered. */
  getTargetHost(id: string): string {
    const entry = this.entries.get(id);
    if (!entry) return "(unknown)";
    return entry.targetHost;
  }

  /** Return the custom query validator for a connection, if one was registered. Callers must verify connection existence first. */
  getValidator(id: string): ((query: string) => { valid: boolean; reason?: string } | Promise<{ valid: boolean; reason?: string }>) | undefined {
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
        throw new NoDatasourceConfiguredError();
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
      throw new ConnectionNotRegisteredError(id);
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
      const rawMessage = err instanceof Error ? err.message : String(err);
      log.warn({ err: err instanceof Error ? err : new Error(rawMessage), connectionId: id, latencyMs }, "Health check failed");
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

      const matched = matchError(err);
      const result: HealthCheckResult = {
        status,
        latencyMs,
        message: matched?.message ?? rawMessage,
        checkedAt: new Date(),
      };
      entry.lastHealth = result;
      return result;
    }
  }

  /** Start periodic health checks via Effect.repeat + Schedule.spaced. Idempotent. */
  startHealthChecks(intervalMs = 60_000): void {
    if (this.healthFiber) return;

    const listFn = () => this.list();
    const checkFn = (id: string) => this.healthCheck(id);
    const healthCheckAll = Effect.gen(function* () {
      const ids = listFn();
      yield* Effect.forEach(
        ids,
        (id) =>
          Effect.tryPromise({
            try: () => checkFn(id),
            catch: (err) => (err instanceof Error ? err.message : String(err)),
          }).pipe(
            Effect.catchAll((errMsg) => {
              log.warn({ connectionId: id, err: errMsg }, "Periodic health check failed");
              return Effect.void;
            }),
          ),
        { concurrency: "unbounded" },
      );
    });

    this.healthFiber = Effect.runFork(
      healthCheckAll.pipe(
        // Catch expected failures but let defects (programming errors) crash the fiber.
        // The inner forEach already catches individual health check failures, so this
        // outer handler is a safety net for unexpected errors in the cycle itself.
        Effect.catchAllCause((cause) => {
          const msg = cause.toString();
          log.warn({ err: msg }, "Health check cycle failed");
          return Effect.void;
        }),
        Effect.repeat(Schedule.spaced(Duration.millis(intervalMs))),
        Effect.asVoid,
      ),
    );
  }

  /** Stop periodic health checks by interrupting the Effect fiber. */
  stopHealthChecks(): void {
    if (this.healthFiber) {
      Effect.runFork(Fiber.interrupt(this.healthFiber));
      this.healthFiber = null;
    }
  }

  /**
   * Pre-warm connections by running SELECT 1 on each registered pool.
   * Probes across different connections run in parallel.
   * @param count Number of warmup probes per connection (default: ATLAS_POOL_WARMUP env var, or 2 if unset).
   */
  async warmup(count?: number): Promise<void> {
    const n = count ?? getPoolWarmup();
    if (n <= 0) return;
    const ids = this.list();
    if (ids.length === 0) return;

    let total = 0;
    let ready = 0;
    await Promise.all(ids.map(async (id) => {
      const entry = this.entries.get(id);
      if (!entry) return;
      for (let i = 0; i < n; i++) {
        total++;
        try {
          await entry.conn.query("SELECT 1", 5000);
          ready++;
        } catch (err) {
          log.warn({ connectionId: id, probe: i + 1, err: err instanceof Error ? err.message : String(err) }, "Pool warmup probe failed");
        }
      }
    }));
    if (ready === 0 && total > 0) {
      log.error({ ready, total }, "Pool warmup failed: no connections ready");
    } else if (ready < total) {
      log.warn({ ready, total }, "Pool warmup partial: some probes failed");
    } else {
      log.info({ ready, total }, "Pool warmed: all connections ready");
    }
  }

  /**
   * Drain a connection pool and recreate it from stored config.
   * Only works for config-registered connections (not plugin/direct connections).
   * The old pool is closed asynchronously in the background; the returned
   * promise resolves once the new pool is created, not when the old finishes closing.
   *
   * Drain cooldown is managed via Effect.sleep — no Date.now arithmetic.
   */
  async drain(id: string): Promise<{ drained: boolean; message: string }> {
    const entry = this.entries.get(id);
    if (!entry) throw new ConnectionNotRegisteredError(id);

    if (!entry.config) {
      return { drained: false, message: "Cannot drain plugin-managed connection — plugin must re-register it" };
    }

    if (this.drainCooldownSet.has(id)) {
      const expiresAt = this.drainCooldownExpiry.get(id) ?? 0;
      const remainingSec = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
      return { drained: false, message: `Drain cooldown active — wait ${remainingSec}s` };
    }

    this._drainAndRecreate(id, entry);
    this._startDrainCooldown(id);
    return { drained: true, message: "Pool drained and recreated" };
  }

  /** Internal: close and recreate a pool from config. On failure, keeps the existing connection. */
  private _drainAndRecreate(id: string, entry: RegistryEntry): void {
    if (!entry.config) return;

    const config = entry.config;
    const dbType = entry.dbType;
    const oldConn = entry.conn;

    let newConn: DBConnection;
    try {
      newConn = createConnection(dbType, config);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)), connectionId: id },
        "Failed to recreate pool during drain — keeping existing connection",
      );
      return;
    }

    entry.conn = newConn;
    // Don't reset consecutiveFailures — let recordSuccess() do it on actual recovery.
    // This prevents masking ongoing outages in admin metrics.
    entry.consecutiveQueryFailures = 0;
    entry.firstFailureAt = null;
    entry.lastDrainAt = Date.now();

    oldConn.close().catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), connectionId: id }, "Failed to close drained pool");
    });
  }

  /**
   * Manages drain cooldown by forking an Effect.sleep fiber that removes
   * the connection ID from drainCooldownSet after DRAIN_COOLDOWN_MS.
   * The fiber is fire-and-forget — if the process exits before the timer
   * fires, the cooldown is implicitly cleared via shutdown()/reset().
   */
  private _startDrainCooldown(id: string): void {
    this.drainCooldownSet.add(id);
    this.drainCooldownExpiry.set(id, Date.now() + DRAIN_COOLDOWN_MS);
    Effect.runFork(
      Effect.sleep(Duration.millis(DRAIN_COOLDOWN_MS)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            this.drainCooldownSet.delete(id);
            this.drainCooldownExpiry.delete(id);
          }),
        ),
      ),
    );
  }

  /** Return pool metrics for a specific connection. */
  getPoolMetrics(id: string): import("@useatlas/types").PoolMetrics {
    const entry = this.entries.get(id);
    if (!entry) throw new ConnectionNotRegisteredError(id);

    return {
      connectionId: id,
      dbType: entry.dbType,
      pool: entry.conn.getPoolStats?.() ?? null,
      totalQueries: entry.totalQueries,
      totalErrors: entry.totalErrors,
      avgQueryTimeMs: entry.totalQueries > 0 ? Math.round(entry.totalQueryTimeMs / entry.totalQueries) : 0,
      consecutiveFailures: entry.consecutiveQueryFailures,
      lastDrainAt: entry.lastDrainAt ? new Date(entry.lastDrainAt).toISOString() : null,
    };
  }

  /** Return pool metrics for all registered connections. */
  getAllPoolMetrics(): import("@useatlas/types").PoolMetrics[] {
    return Array.from(this.entries.keys()).map((id) => this.getPoolMetrics(id));
  }

  /**
   * Return pool metrics for org-scoped pools.
   * When orgId is provided, returns only that org's pools.
   * When omitted, returns metrics for all org pools.
   */
  getOrgPoolMetrics(orgId?: string): import("@useatlas/types").OrgPoolMetrics[] {
    const results: import("@useatlas/types").OrgPoolMetrics[] = [];
    for (const [key, entry] of this.orgEntries) {
      const { orgId: entryOrgId, connectionId } = this._parseOrgKey(key);
      if (orgId && entryOrgId !== orgId) continue;
      results.push({
        orgId: entryOrgId,
        connectionId,
        dbType: entry.dbType,
        pool: entry.conn.getPoolStats?.() ?? null,
        totalQueries: entry.totalQueries,
        totalErrors: entry.totalErrors,
        avgQueryTimeMs: entry.totalQueries > 0 ? Math.round(entry.totalQueryTimeMs / entry.totalQueries) : 0,
        consecutiveFailures: entry.consecutiveQueryFailures,
        lastDrainAt: entry.lastDrainAt ? new Date(entry.lastDrainAt).toISOString() : null,
      });
    }
    return results;
  }

  /**
   * Gracefully drain all pools for an org. In-flight queries complete on
   * the old pool before it is closed. Used when an org is deactivated or
   * when an admin needs to force-recycle an org's connections.
   */
  async drainOrg(orgId: string): Promise<{ drained: number }> {
    const prefix = `${orgId}:`;
    let drained = 0;
    const closing: Promise<void>[] = [];

    for (const [key, entry] of this.orgEntries) {
      if (key.startsWith(prefix)) {
        closing.push(
          entry.conn.close().catch((err) => {
            log.warn({ key, err: err instanceof Error ? err.message : String(err) }, "Failed to close org pool during drain");
          }),
        );
        this.orgEntries.delete(key);
        drained++;
      }
    }

    this.orgAccessSeq.delete(orgId);
    await Promise.all(closing);
    log.info({ orgId, drained }, "Org pools drained");
    return { drained };
  }

  /**
   * Graceful shutdown: stop health checks, close all connections (awaited), and
   * reset whitelists. When managed by Effect scope, this is called automatically
   * via the scope finalizer — no manual ordering needed.
   */
  async shutdown(): Promise<void> {
    this.stopHealthChecks();
    this.drainCooldownSet.clear();
    this.drainCooldownExpiry.clear();
    const closing: Promise<void>[] = [];
    for (const [id, entry] of this.entries.entries()) {
      closing.push(
        entry.conn.close().catch((err) => {
          log.warn({ err: err instanceof Error ? err.message : String(err), connectionId: id }, "Failed to close connection during shutdown");
        }),
      );
    }
    for (const [key, entry] of this.orgEntries.entries()) {
      closing.push(
        entry.conn.close().catch((err) => {
          log.warn({ err: err instanceof Error ? err.message : String(err), orgPoolKey: key }, "Failed to close org pool during shutdown");
        }),
      );
    }
    await Promise.all(closing);
    this.entries.clear();
    this.orgEntries.clear();
    this.orgAccessSeq.clear();
    _resetWhitelists();
  }

  /** Clears all registered connections (base + org) and resets the table whitelist cache. Used during graceful shutdown, tests, and the benchmark harness. */
  _reset(): void {
    this.stopHealthChecks();
    this.drainCooldownSet.clear();
    this.drainCooldownExpiry.clear();
    for (const [id, entry] of this.entries.entries()) {
      entry.conn.close().catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err), connectionId: id }, "Failed to close connection during registry reset");
      });
    }
    for (const [key, entry] of this.orgEntries.entries()) {
      entry.conn.close().catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err), orgPoolKey: key }, "Failed to close org pool during registry reset");
      });
    }
    this.entries.clear();
    this.orgEntries.clear();
    this.orgAccessSeq.clear();
    _resetWhitelists();
  }
}

export const connections = new ConnectionRegistry();

/** Backward-compatible singleton — delegates to the connection registry. */
export function getDB(): DBConnection {
  return connections.getDefault();
}

/**
 * Resolve a region-aware connection for a workspace.
 *
 * If the workspace has a region assigned and residency is configured,
 * registers (or reuses) a region-specific analytics datasource and returns
 * the org-scoped pool for that region. Falls back to the default connection
 * if the ee module is unavailable, residency is not configured, or the
 * workspace has no region.
 *
 * Note: this routes the analytics datasource only. Internal database routing
 * (conversations, audit logs) is not yet implemented.
 */
export async function getRegionAwareConnection(
  orgId: string,
  connectionId: string = "default",
): Promise<DBConnection> {
  let resolveRegionDatabaseUrl: Awaited<typeof import("@atlas/ee/platform/residency")>["resolveRegionDatabaseUrl"];
  try {
    ({ resolveRegionDatabaseUrl } = await import("@atlas/ee/platform/residency"));
  } catch (err) {
    // ee module not installed — non-enterprise deployment, use default
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") {
      return connections.getForOrg(orgId, connectionId);
    }
    log.warn({ err: err instanceof Error ? err.message : String(err), orgId }, "Failed to load residency module");
    return connections.getForOrg(orgId, connectionId);
  }

  const regionInfo = await resolveRegionDatabaseUrl(orgId);
  if (regionInfo?.datasourceUrl) {
    const regionConnId = `region:${regionInfo.region}`;
    if (!connections.has(regionConnId)) {
      connections.register(regionConnId, {
        url: regionInfo.datasourceUrl,
        description: `Region ${regionInfo.region} datasource`,
      });
      log.info({ connectionId: regionConnId, region: regionInfo.region }, "Registered region datasource");
    }
    return connections.getForOrg(orgId, regionConnId);
  }

  return connections.getForOrg(orgId, connectionId);
}
