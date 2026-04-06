/**
 * Atlas internal database connection.
 *
 * Read-write Postgres connection for Atlas's own state (auth, audit, settings).
 * Completely separate from the analytics datasource in connection.ts.
 * Configured via DATABASE_URL.
 *
 * Native @effect/sql-pg integration:
 * The pool is created via PgClient.layerFromPool() which wraps a scope-managed
 * pg.Pool with an @effect/sql SqlClient. Pool lifecycle is automatic via Effect
 * scope — connections close when the Layer scope finalizes.
 *
 * The InternalDB service exposes both:
 * - `sql`: @effect/sql SqlClient for tagged template queries (new code)
 * - `query`/`execute`: backward-compat imperative API (existing callers)
 */

import * as crypto from "crypto";
import { Context, Effect, Layer, Schedule, Duration, Fiber } from "effect";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import type { Pool as PgPool } from "pg";
import { createLogger } from "@atlas/api/lib/logger";
import { normalizeError } from "@atlas/api/lib/effect/errors";

const log = createLogger("internal-db");

// ---------------------------------------------------------------------------
// Connection URL encryption (AES-256-GCM)
// ---------------------------------------------------------------------------

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16;

let _cachedKey: { raw: string; key: Buffer } | null = null;

/**
 * Returns the 32-byte encryption key derived via SHA-256 from
 * ATLAS_ENCRYPTION_KEY (takes precedence) or BETTER_AUTH_SECRET.
 * Returns null if neither is set. Result is cached.
 */
export function getEncryptionKey(): Buffer | null {
  const raw = process.env.ATLAS_ENCRYPTION_KEY ?? process.env.BETTER_AUTH_SECRET;
  if (!raw) return null;
  if (_cachedKey && _cachedKey.raw === raw) return _cachedKey.key;
  // Derive a fixed 32-byte key via SHA-256 so any-length secret works
  const key = crypto.createHash("sha256").update(raw).digest();
  _cachedKey = { raw, key };
  return key;
}

/** @internal Reset cached encryption key — for testing only. */
export function _resetEncryptionKeyCache(): void {
  _cachedKey = null;
}

/**
 * Encrypts a connection URL using AES-256-GCM.
 * Returns `iv:authTag:ciphertext` (all base64). Returns the plaintext
 * unchanged if no encryption key is available.
 */
export function encryptUrl(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // `:` is safe as delimiter — base64 alphabet is A-Za-z0-9+/= (no colon)
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypts a connection URL encrypted by `encryptUrl()`.
 * Plaintext detection (two checks):
 *   1. Starts with a URL scheme (`postgresql://`, `mysql://`, etc.) → plaintext
 *   2. Not exactly 3 colon-separated parts (`iv:authTag:ciphertext`) → plaintext
 * Returns plaintext values as-is for backward compatibility with pre-encryption data.
 */
export function decryptUrl(stored: string): string {
  if (isPlaintextUrl(stored)) return stored;

  const key = getEncryptionKey();
  if (!key) {
    log.error("Encrypted connection URL found but no encryption key is available — set ATLAS_ENCRYPTION_KEY or BETTER_AUTH_SECRET");
    throw new Error("Cannot decrypt connection URL: no encryption key available");
  }

  const parts = stored.split(":");
  if (parts.length !== 3) {
    log.error({ partCount: parts.length }, "Stored connection URL is not plaintext and does not match encrypted format (expected 3 colon-separated parts)");
    throw new Error("Failed to decrypt connection URL: unrecognized format");
  }

  try {
    const iv = Buffer.from(parts[0], "base64");
    const authTag = Buffer.from(parts[1], "base64");
    const ciphertext = Buffer.from(parts[2], "base64");

    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to decrypt connection URL — data may be corrupted or key may have changed",
    );
    throw new Error("Failed to decrypt connection URL", { cause: err });
  }
}

/** Returns true if the stored value looks like a plaintext URL (any URI scheme, not just database schemes). */
export function isPlaintextUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

/** Typed interface for the internal pg.Pool — avoids importing pg at module level. */
export interface InternalPoolClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface InternalPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<InternalPoolClient>;
  end(): Promise<void>;
  on(event: "error", listener: (err: Error) => void): void;
}

// ── Effect Service: InternalDB ───────────────────────────────────────

/**
 * InternalDB Effect service — provides access to the internal Postgres pool
 * and a native @effect/sql SqlClient for tagged template queries.
 *
 * Effect-managed lifecycle: pool is created during Layer construction and
 * closed automatically when the Layer scope ends via PgClient.layerFromPool().
 */
export interface InternalDBShape {
  /** @effect/sql client for tagged template queries. Null when DATABASE_URL is not set. */
  readonly sql: SqlClient.SqlClient | null;
  /** Execute a parameterized query returning typed rows. */
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Fire-and-forget write (uses circuit breaker internally).
   * Intentionally void (not Effect/Promise) — called from onFinish callbacks
   * in the agent loop where back-pressure would block stream finalization.
   */
  execute(sql: string, params?: unknown[]): void;
  /** Whether the internal DB is available. */
  readonly available: boolean;
  /** The underlying pg.Pool (for Better Auth, migrations). Null when DATABASE_URL is not set. */
  readonly pool: InternalPool | null;
}

export class InternalDB extends Context.Tag("InternalDB")<
  InternalDB,
  InternalDBShape
>() {}

/**
 * Create the Live Layer for InternalDB.
 *
 * Uses PgClient.layerFromPool() to wrap a scope-managed pg.Pool with a native
 * @effect/sql SqlClient. The pool is created with acquireRelease for automatic
 * cleanup when the Layer scope finalizes — no manual closeInternalDB() needed.
 *
 * The InternalDB service key APIs include:
 * - `sql`: SqlClient for tagged template queries (Effect programs)
 * - `query`/`execute`: imperative wrappers for existing callers
 * - `pool`: raw pg.Pool for Better Auth and migrations
 * - `available`: boolean indicating whether the DB is connected
 */
export function makeInternalDBLive(): Layer.Layer<InternalDB> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return Layer.succeed(InternalDB, {
      sql: null,
      query: async () => { throw new Error("DATABASE_URL is not set"); },
      execute: () => { log.debug("internalExecute called but DATABASE_URL is not set — no-op"); },
      available: false,
      pool: null,
    } satisfies InternalDBShape);
  }

  // Normalize sslmode: pg v8 treats 'require' as 'verify-full' but warns.
  const connString = databaseUrl.replace(
    /([?&])sslmode=require(?=&|$)/,
    "$1sslmode=verify-full",
  );

  // Scoped pool: acquireRelease creates the pool and registers a finalizer
  // that calls pool.end() when the scope closes. The pool reference is stored
  // in the module-level _pool for backward-compat standalone functions.
  const acquirePool = Effect.acquireRelease(
    Effect.sync(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Pool } = require("pg");
      const pool: PgPool = new Pool({
        connectionString: connString,
        max: 5,
        idleTimeoutMillis: 30000,
      });
      pool.on("error", (err: unknown) => {
        log.error(
          { err: err instanceof Error ? err : new Error(String(err)) },
          "Internal DB pool idle client error",
        );
      });
      // Store in module-level ref for backward-compat functions
      _pool = pool as unknown as InternalPool;
      _poolManagedByEffect = true;
      return pool;
    }),
    (pool) =>
      Effect.tryPromise({
        try: () => pool.end(),
        catch: (err) => (err instanceof Error ? err.message : String(err)),
      }).pipe(
        Effect.tap(() => Effect.sync(() => {
          _pool = null;
          _poolManagedByEffect = false;
          log.info("Internal DB pool closed via Effect scope");
        })),
        Effect.catchAll((errMsg) => {
          _pool = null;
          _poolManagedByEffect = false;
          log.warn({ err: errMsg }, "Error closing internal DB pool via Effect finalizer");
          return Effect.void;
        }),
      ),
  );

  // PgClient.layerFromPool wraps the pool to provide PgClient + SqlClient
  const pgClientLayer = PgClient.layerFromPool({
    acquire: acquirePool,
    applicationName: "atlas-internal",
  });

  // InternalDB service layer: depends on PgClient/SqlClient from pgClientLayer
  const internalDbLayer = Layer.scoped(
    InternalDB,
    Effect.gen(function* () {
      const sqlClient = yield* SqlClient.SqlClient;

      // Capture module-level reference for standalone functions (internalQuery, etc.)
      _sqlClient = sqlClient;
      // _pool was already set by acquirePool when pgClientLayer constructed
      const poolRef = _pool;

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          _sqlClient = null;
        }),
      );

      return {
        sql: sqlClient,
        query: async <T extends Record<string, unknown>>(sqlStr: string, params?: unknown[]): Promise<T[]> => {
          const rows = await Effect.runPromise(
            sqlClient.unsafe<T>(sqlStr, params as ReadonlyArray<unknown>),
          );
          return rows as T[];
        },
        execute: (sqlStr: string, params?: unknown[]) => internalExecute(sqlStr, params),
        available: true,
        pool: poolRef,
      } satisfies InternalDBShape;
    }),
  );

  return internalDbLayer.pipe(
    Layer.provide(pgClientLayer),
    // Catch SqlError from PgClient (e.g., connection failure) and degrade
    // to an unavailable service rather than failing the entire Layer DAG.
    Layer.catchAll((sqlError) => {
      log.error(
        { err: sqlError instanceof Error ? sqlError : new Error(String(sqlError)) },
        "Internal DB Layer failed to initialize — degrading to unavailable. " +
        "Check DATABASE_URL, network connectivity, and Postgres credentials.",
      );
      return Layer.succeed(InternalDB, {
        sql: null,
        query: async () => { throw new Error(`Internal DB unavailable: ${sqlError.message}`); },
        execute: () => { log.warn("internalExecute dropped — internal DB unavailable since startup"); },
        available: false,
        pool: null,
      } satisfies InternalDBShape);
    }),
  );
}

/** Create a test Layer for InternalDB. */
export function createInternalDBTestLayer(
  partial: Partial<InternalDBShape> = {},
): Layer.Layer<InternalDB> {
  const mockPool: InternalPool = {
    query: async () => ({ rows: [] }),
    async connect() {
      return { query: async () => ({ rows: [] }), release() {} };
    },
    end: async () => {},
    on: () => {},
  };
  return Layer.succeed(InternalDB, {
    sql: partial.sql ?? null,
    query: partial.query ?? (async () => []),
    execute: partial.execute ?? (() => {}),
    available: partial.available ?? true,
    pool: partial.pool ?? mockPool,
  });
}

// ── Module-level references (set by Layer, used by standalone functions) ─

let _pool: InternalPool | null = null;
let _sqlClient: SqlClient.SqlClient | null = null;
/** True when the pool was created by the Effect Layer (lifecycle managed by scope). */
let _poolManagedByEffect = false;

/** Returns true if DATABASE_URL is configured. */
export function hasInternalDB(): boolean {
  return !!process.env.DATABASE_URL;
}

/**
 * Returns the internal DB pool.
 *
 * @deprecated Pool lifecycle is managed by InternalDB Effect Layer.
 * Prefer yielding `InternalDB` from Effect context, or use the module-level
 * `internalQuery`/`internalExecute` helpers. This function exists only for
 * backward-compat callers (Better Auth, migrations) that need a raw pg.Pool.
 * Falls back to lazy pool creation if the Layer hasn't booted yet.
 */
export function getInternalDB(): InternalPool {
  if (_pool) return _pool;

  // Fallback: create pool lazily for code that runs before Layer boot
  // (e.g. early migration calls, test setup). Once the Layer boots, it
  // sets _pool and subsequent calls use the Layer-managed pool.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Atlas internal database requires a PostgreSQL connection string."
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require("pg");
  const connString = databaseUrl.replace(
    /([?&])sslmode=require(?=&|$)/,
    "$1sslmode=verify-full",
  );
  _pool = new Pool({
    connectionString: connString,
    max: 5,
    idleTimeoutMillis: 30000,
  }) as InternalPool;
  _pool.on("error", (err: unknown) => {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Internal DB pool idle client error",
    );
  });
  return _pool;
}

/**
 * Close the internal DB pool.
 *
 * When the pool was created by the Effect Layer (server runtime), this is a
 * no-op — the scope finalizer handles cleanup. When the pool was created by
 * the lazy fallback in getInternalDB() (CLI commands, tests), this closes
 * the pool to prevent connection leaks and process hangs.
 */
export async function closeInternalDB(): Promise<void> {
  if (!_pool) {
    log.debug("closeInternalDB() called but no pool exists");
    return;
  }
  if (_poolManagedByEffect) {
    // Pool lifecycle is managed by Effect scope finalizer — skip.
    log.debug("closeInternalDB() called — pool managed by Effect scope, skipping");
    return;
  }
  // Fallback pool (created by getInternalDB outside of Effect runtime)
  const pool = _pool;
  _pool = null;
  _sqlClient = null;
  try {
    await pool.end();
    log.info("Internal DB fallback pool closed via closeInternalDB()");
  } catch (err: unknown) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Error closing internal DB pool",
    );
  }
}

/** Reset singleton for testing. Optionally inject a mock pool and/or SqlClient. */
export function _resetPool(mockPool?: InternalPool | null, mockSql?: SqlClient.SqlClient | null): void {
  _pool = mockPool ?? null;
  _sqlClient = mockSql ?? null;
  _poolManagedByEffect = false;
  _consecutiveFailures = 0;
  _circuitOpen = false;
  _droppedCount = 0;
}

/**
 * Parameterized query that returns typed rows.
 * Uses the @effect/sql SqlClient when available (Layer has booted),
 * falls back to raw pg.Pool for pre-Layer callers.
 */
export async function internalQuery<T extends Record<string, unknown>>(
  sqlStr: string,
  params?: unknown[],
): Promise<T[]> {
  if (_sqlClient) {
    const rows = await Effect.runPromise(
      _sqlClient.unsafe<T>(sqlStr, params as ReadonlyArray<unknown>),
    );
    return rows as T[];
  }
  // Fallback: raw pool (pre-Layer boot or tests without SqlClient)
  const pool = getInternalDB();
  const result = await pool.query(sqlStr, params);
  return result.rows as T[];
}

let _consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
let _circuitOpen = false;
let _droppedCount = 0;
/** Recovery fiber — when set, a background fiber is attempting exponential backoff recovery. */
let _recoveryFiber: Fiber.RuntimeFiber<void, never> | null = null;

/**
 * Exponential backoff recovery schedule for the circuit breaker.
 * Starts at 30s, doubles each attempt, caps at 5 minutes.
 * Retries up to 5 times with increasing delays (30s, 60s, 120s, 240s, 300s).
 * If all retries fail, circuit remains open and recovery re-triggers on next write.
 */
const RECOVERY_SCHEDULE = Schedule.exponential(Duration.seconds(30)).pipe(
  Schedule.union(Schedule.spaced(Duration.minutes(5))),
  // Cap at 5 retries (30s → 60s → 120s → 240s → 300s)
  Schedule.intersect(Schedule.recurs(5)),
  Schedule.map(([duration]) => duration),
);

/**
 * Start an exponential-backoff recovery probe. On success, closes the circuit (resumes writes).
 * On exhaustion of retries, the circuit remains open and the recovery fiber clears
 * itself so the next internalExecute call re-triggers recovery.
 *
 * After an initial 30s delay, makes the first probe attempt. On failure, retries
 * up to 5 times with exponential backoff (30s, 60s, 120s, 240s, 300s).
 * Worst-case recovery takes ~13 minutes from circuit trip to retry exhaustion.
 */
function _startRecovery(): void {
  if (_recoveryFiber) return;

  const probe = Effect.gen(function* () {
    const pool = getInternalDB();
    yield* Effect.tryPromise({
      try: () => pool.query("SELECT 1"),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });
  });

  const recovery = Effect.sleep(Duration.seconds(30)).pipe(
    Effect.andThen(
      probe.pipe(Effect.retry(RECOVERY_SCHEDULE)),
    ),
    Effect.andThen(
      Effect.sync(() => {
        const dropped = _droppedCount;
        _circuitOpen = false;
        _consecutiveFailures = 0;
        _droppedCount = 0;
        _recoveryFiber = null;
        log.info({ droppedCount: dropped }, "Internal DB circuit breaker recovered — fire-and-forget writes resumed");
      }),
    ),
    Effect.catchAll((err) => {
      // All retries exhausted — keep circuit open, clear fiber so next write re-triggers recovery
      _recoveryFiber = null;
      log.error(
        { err: err instanceof Error ? err.message : String(err), droppedCount: _droppedCount },
        "Internal DB circuit breaker recovery exhausted — circuit remains open, will re-attempt on next write",
      );
      return Effect.void;
    }),
  );

  _recoveryFiber = Effect.runFork(recovery);
}

/**
 * Fire-and-forget query — async errors are logged, never thrown.
 * After 5 consecutive failures, a circuit breaker trips and drops
 * all calls until recovery succeeds. Recovery uses exponential backoff
 * (30s → 60s → 120s → 240s → 300s) via Effect.retry. Throws
 * synchronously if DATABASE_URL is not set (callers should check
 * hasInternalDB() first).
 *
 * Uses @effect/sql SqlClient when available, falls back to raw pg.Pool.
 */
export function internalExecute(sqlStr: string, params?: unknown[]): void {
  if (_circuitOpen) {
    _droppedCount++;
    // Re-trigger recovery if previous attempt exhausted retries
    if (!_recoveryFiber) _startRecovery();
    return;
  }

  const onSuccess = () => { _consecutiveFailures = 0; };
  const onError = (err: unknown) => {
    _consecutiveFailures++;
    if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !_circuitOpen) {
      _circuitOpen = true;
      log.error("Internal DB circuit breaker open — fire-and-forget writes disabled until recovery");
      _startRecovery();
    }
    if (!_circuitOpen) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          sql: sqlStr.slice(0, 200),
          paramCount: params?.length ?? 0,
        },
        "Internal DB fire-and-forget write failed — row lost",
      );
    }
  };

  if (_sqlClient) {
    void Effect.runPromise(
      _sqlClient.unsafe(sqlStr, params as ReadonlyArray<unknown>),
    ).then(onSuccess).catch(onError);
  } else {
    // Fallback: raw pool
    const pool = getInternalDB();
    void pool.query(sqlStr, params).then(onSuccess).catch(onError);
  }
}

/** Reset circuit breaker state. For testing only. */
export function _resetCircuitBreaker(): void {
  _consecutiveFailures = 0;
  _circuitOpen = false;
  _droppedCount = 0;
  if (_recoveryFiber) {
    Effect.runFork(Fiber.interrupt(_recoveryFiber));
    _recoveryFiber = null;
  }
}

/**
 * Log a warning when DATABASE_URL and ATLAS_DATASOURCE_URL resolve to the
 * same Postgres database. Internal tables (auth, audit, settings) will
 * share the public schema with analytics data.
 *
 * This is intentional in single-DB deployments (e.g. Railway with one
 * Postgres addon) but can confuse the seed script or the agent — call
 * this once at migration time to surface the situation.
 */
function warnIfSharedDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL;
  const datasourceUrl = process.env.ATLAS_DATASOURCE_URL;
  if (!databaseUrl || !datasourceUrl) return;

  try {
    const internalParsed = new URL(databaseUrl);
    const datasourceParsed = new URL(datasourceUrl);

    // Compare host + port + pathname (database name) to detect shared DB
    const sameHost = internalParsed.hostname === datasourceParsed.hostname;
    const samePort = (internalParsed.port || "5432") === (datasourceParsed.port || "5432");
    const sameDB = internalParsed.pathname === datasourceParsed.pathname;

    if (sameHost && samePort && sameDB) {
      log.warn(
        "DATABASE_URL and ATLAS_DATASOURCE_URL point to the same database — " +
        "Atlas internal tables will share the schema with analytics data. " +
        "Consider using a separate database for ATLAS_DATASOURCE_URL to isolate analytics data.",
      );
    }
  } catch {
    // URL parsing failed — not critical, skip the warning
    log.debug("Could not parse DATABASE_URL or ATLAS_DATASOURCE_URL for shared-DB detection");
  }
}

/**
 * Idempotent migration: runs versioned SQL migrations from `migrations/`
 * directory, then applies data seeds.
 *
 * Replaces the old imperative DDL approach (152 individual pool.query calls)
 * with a file-based migration runner tracked in `__atlas_migrations`. See #978.
 */
export async function migrateInternalDB(): Promise<void> {
  // Warn when DATABASE_URL and ATLAS_DATASOURCE_URL resolve to the same
  // database — internal tables will share the schema with analytics data.
  // This is intentional in single-DB deployments but can surprise operators
  // who expect isolation. (#962)
  warnIfSharedDatabase();

  const pool = getInternalDB();

  const { runMigrations, runSeeds } = await import("@atlas/api/lib/db/migrate");
  await runMigrations(pool);
  await runSeeds(pool);

  log.info("Internal DB migration complete");
}

// Old imperative DDL removed — see migrations/0000_baseline.sql (#978)

// seedPromptLibrary moved to migrate.ts → runSeeds() (#978)

/**
 * Load admin-managed connections from the internal DB and register them
 * in the ConnectionRegistry. Idempotent — safe to call at startup.
 * Silently skips if no internal DB or the connections table doesn't exist yet.
 */
export async function loadSavedConnections(): Promise<number> {
  if (!hasInternalDB()) return 0;

  // Lazy-import to avoid circular dependency at module level
  const { connections } = await import("@atlas/api/lib/db/connection");

  try {
    type ConnRow = { id: string; url: string; type: string; description: string | null; schema_name: string | null };
    const rows = await internalQuery<ConnRow>("SELECT id, url, type, description, schema_name FROM connections");

    let registered = 0;
    for (const row of rows) {
      try {
        const url = decryptUrl(row.url);
        connections.register(row.id, {
          url,
          description: row.description ?? undefined,
          schema: row.schema_name ?? undefined,
        });
        registered++;
      } catch (err) {
        log.warn(
          { connectionId: row.id, err: err instanceof Error ? err.message : String(err) },
          "Failed to register saved connection — skipping",
        );
      }
    }

    if (registered > 0) {
      log.info({ count: registered }, "Loaded saved connections from internal DB");
    }
    return registered;
  } catch (err) {
    // Table may not exist yet (pre-migration) — that's expected on first boot
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Could not load saved connections (table may not exist yet)",
    );
    return 0;
  }
}

// ── Learned pattern helpers ─────────────────────────────────────────

/**
 * Find a learned pattern by exact normalized SQL match for the given org.
 * Returns the pattern's id, confidence, and repetition count, or null if not found.
 */
export async function findPatternBySQL(
  orgId: string | null | undefined,
  patternSql: string,
): Promise<{ id: string; confidence: number; repetitionCount: number } | null> {
  const params: unknown[] = [patternSql];
  let orgClause: string;
  if (orgId) {
    params.push(orgId);
    orgClause = `org_id = $2`;
  } else {
    orgClause = `org_id IS NULL`;
  }

  const rows = await internalQuery<{ id: string; confidence: number; repetition_count: number }>(
    `SELECT id, confidence, repetition_count FROM learned_patterns WHERE pattern_sql = $1 AND ${orgClause} LIMIT 1`,
    params,
  );

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    confidence: row.confidence,
    repetitionCount: row.repetition_count,
  };
}

/**
 * Insert a new learned pattern. Fire-and-forget — errors are logged, never thrown.
 */
export function insertLearnedPattern(pattern: {
  orgId: string | null | undefined;
  patternSql: string;
  description: string;
  sourceEntity: string;
  sourceQueries: string[];
  proposedBy: string;
}): void {
  internalExecute(
    `INSERT INTO learned_patterns (org_id, pattern_sql, description, source_entity, source_queries, confidence, repetition_count, status, proposed_by)
     VALUES ($1, $2, $3, $4, $5, 0.1, 1, 'pending', $6)`,
    [
      pattern.orgId ?? null,
      pattern.patternSql,
      pattern.description,
      pattern.sourceEntity,
      JSON.stringify(pattern.sourceQueries),
      pattern.proposedBy,
    ],
  );
}

/**
 * Parse the auto-approve threshold from env. Returns a value > 1 (disabled) if
 * not set or invalid. Single source of truth for the threshold logic.
 */
export function getAutoApproveThreshold(): number {
  const raw = process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD;
  if (!raw) return 2; // Disabled by default
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    log.warn({ raw }, "Invalid ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD — must be 0.0–1.0, defaulting to disabled");
    return 2;
  }
  return parsed;
}

const DEFAULT_AUTO_APPROVE_TYPES = "update_description,add_dimension";

/** Valid amendment type names from @useatlas/types, used for env var validation. */
const VALID_AMENDMENT_TYPES: ReadonlySet<string> = new Set([
  "add_dimension", "add_measure", "add_join", "add_query_pattern",
  "update_description", "update_dimension", "add_glossary_term", "add_virtual_dimension",
]);

/**
 * Parse the comma-separated list of amendment types eligible for auto-approval.
 * Defaults to `update_description,add_dimension` when `ATLAS_EXPERT_AUTO_APPROVE_TYPES` is not set.
 * Unrecognized type names are logged and ignored.
 */
export function getAutoApproveTypes(): Set<string> {
  const raw = process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES ?? DEFAULT_AUTO_APPROVE_TYPES;
  const tokens = raw.split(",").map((t) => t.trim()).filter(Boolean);
  const result = new Set<string>();
  for (const t of tokens) {
    if (VALID_AMENDMENT_TYPES.has(t)) {
      result.add(t);
    } else {
      log.warn({ type: t }, "ATLAS_EXPERT_AUTO_APPROVE_TYPES contains unrecognized type — ignoring");
    }
  }
  return result;
}

/**
 * Insert a semantic amendment proposal. Status is "approved" only when confidence
 * meets the threshold AND the amendment type is in the eligible set; otherwise "pending".
 * Unlike insertLearnedPattern (fire-and-forget), this awaits the result.
 */
export async function insertSemanticAmendment(amendment: {
  orgId: string | null | undefined;
  description: string;
  sourceEntity: string;
  confidence: number;
  amendmentPayload: Record<string, unknown>;
}): Promise<{ id: string; status: "approved" | "pending" }> {
  const threshold = getAutoApproveThreshold();
  const allowedTypes = getAutoApproveTypes();
  const rawType = amendment.amendmentPayload.amendmentType;
  const amendmentType = typeof rawType === "string" ? rawType : undefined;

  if (amendmentType === undefined) {
    log.warn(
      { entity: amendment.sourceEntity, payloadKeys: Object.keys(amendment.amendmentPayload) },
      "amendmentPayload.amendmentType is missing or not a string — amendment will not be eligible for auto-approval",
    );
  }

  const meetsThreshold = amendment.confidence >= threshold;
  const typeEligible = amendmentType !== undefined && allowedTypes.has(amendmentType);
  const status = meetsThreshold && typeEligible ? "approved" : "pending";

  if (meetsThreshold && !typeEligible) {
    log.debug(
      { entity: amendment.sourceEntity, amendmentType, confidence: amendment.confidence },
      "Amendment meets confidence threshold but type is not in auto-approve list — queuing for review",
    );
  }

  const rows = await internalQuery<{ id: string }>(
    `INSERT INTO learned_patterns
       (org_id, pattern_sql, description, source_entity, confidence,
        repetition_count, status, proposed_by, type, amendment_payload)
     VALUES ($1, $2, $3, $4, $5, 1, $6, 'expert-agent', 'semantic_amendment', $7)
     RETURNING id`,
    [
      amendment.orgId ?? null,
      `amendment:${amendment.sourceEntity}:${Date.now()}`,
      amendment.description,
      amendment.sourceEntity,
      amendment.confidence,
      status,
      JSON.stringify(amendment.amendmentPayload),
    ],
  );

  if (rows.length === 0) {
    throw new Error(
      `insertSemanticAmendment: INSERT returned no rows for entity "${amendment.sourceEntity}". The row may not have been created.`,
    );
  }

  return { id: rows[0].id, status };
}

/**
 * Count pending semantic amendment proposals for an org.
 * Returns 0 when no internal DB is available.
 */
export async function getPendingAmendmentCount(orgId: string | null): Promise<number> {
  if (!hasInternalDB()) return 0;

  const rows = await internalQuery<{ count: string }>(
    orgId
      ? `SELECT COUNT(*)::text AS count FROM learned_patterns
         WHERE type = 'semantic_amendment' AND status = 'pending'
         AND (org_id = $1 OR org_id IS NULL)`
      : `SELECT COUNT(*)::text AS count FROM learned_patterns
         WHERE type = 'semantic_amendment' AND status = 'pending'
         AND org_id IS NULL`,
    orgId ? [orgId] : [],
  );

  return parseInt(rows[0]?.count ?? "0", 10);
}

/**
 * Increment repetition_count by 1 and increase confidence by 0.1 (capped at 1.0).
 * When sourceFingerprint is provided, appends it to source_queries (capped at 100 entries).
 * Fire-and-forget — errors are logged, never thrown.
 */
export function incrementPatternCount(id: string, sourceFingerprint?: string): void {
  if (sourceFingerprint) {
    const newEntry = JSON.stringify([sourceFingerprint]);
    internalExecute(
      `UPDATE learned_patterns SET
        repetition_count = repetition_count + 1,
        confidence = LEAST(1.0, confidence + 0.1),
        source_queries = CASE
          WHEN source_queries IS NULL THEN $2::jsonb
          WHEN jsonb_array_length(source_queries) >= 100 THEN source_queries
          ELSE source_queries || $2::jsonb
        END,
        updated_at = now()
      WHERE id = $1`,
      [id, newEntry],
    );
  } else {
    internalExecute(
      `UPDATE learned_patterns SET
        repetition_count = repetition_count + 1,
        confidence = LEAST(1.0, confidence + 0.1),
        updated_at = now()
      WHERE id = $1`,
      [id],
    );
  }
}

/** Row shape returned by getApprovedPatterns. */
export interface ApprovedPatternRow {
  id: string;
  org_id: string | null;
  pattern_sql: string;
  description: string | null;
  source_entity: string | null;
  /** Confidence score between 0.0 and 1.0. */
  confidence: number;
  [key: string]: unknown;
}

/** Row shape for query_suggestions table. */
export interface QuerySuggestionRow {
  id: string;
  org_id: string | null;
  description: string;
  pattern_sql: string;
  normalized_hash: string;
  tables_involved: string; // JSONB string, parse to string[]
  primary_table: string | null;
  frequency: number;
  clicked_count: number;
  score: number;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/**
 * Fetch approved learned patterns, scoped to an org (or global when orgId is null).
 * Ordered by confidence DESC, capped at 100 rows.
 */
export async function getApprovedPatterns(orgId: string | null): Promise<ApprovedPatternRow[]> {
  if (!hasInternalDB()) return [];

  return internalQuery<ApprovedPatternRow>(
    orgId
      ? `SELECT id, org_id, pattern_sql, description, source_entity, confidence
         FROM learned_patterns
         WHERE status = 'approved' AND (org_id = $1 OR org_id IS NULL)
         ORDER BY confidence DESC
         LIMIT 100`
      : `SELECT id, org_id, pattern_sql, description, source_entity, confidence
         FROM learned_patterns
         WHERE status = 'approved' AND org_id IS NULL
         ORDER BY confidence DESC
         LIMIT 100`,
    orgId ? [orgId] : [],
  );
}

export async function upsertSuggestion(suggestion: {
  orgId: string | null;
  description: string;
  patternSql: string;
  normalizedHash: string;
  tablesInvolved: string[];
  primaryTable: string | null;
  frequency: number;
  score: number;
  lastSeenAt: Date;
}): Promise<"created" | "updated" | "skipped"> {
  if (!hasInternalDB()) return "skipped";
  try {
    const rows = await internalQuery<{ id: string; created: boolean }>(
      `INSERT INTO query_suggestions (org_id, description, pattern_sql, normalized_hash, tables_involved, primary_table, frequency, score, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT ON CONSTRAINT uq_query_suggestions_org_hash DO UPDATE SET
         frequency = EXCLUDED.frequency,
         score = EXCLUDED.score,
         last_seen_at = EXCLUDED.last_seen_at,
         updated_at = NOW()
       RETURNING id, (xmax = 0) AS created`,
      [
        suggestion.orgId,
        suggestion.description,
        suggestion.patternSql,
        suggestion.normalizedHash,
        JSON.stringify(suggestion.tablesInvolved),
        suggestion.primaryTable,
        suggestion.frequency,
        suggestion.score,
        suggestion.lastSeenAt.toISOString(),
      ]
    );
    return rows[0]?.created ? "created" : "updated";
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to upsert suggestion");
    return "skipped";
  }
}

export async function getSuggestionsByTables(
  orgId: string | null,
  tables: string[],
  limit: number = 10
): Promise<QuerySuggestionRow[]> {
  if (!hasInternalDB()) return [];
  try {
    const orgClause = orgId != null ? "org_id = $1" : "org_id IS NULL";
    const params: unknown[] = orgId != null ? [orgId] : [];
    const nextIdx = params.length + 1;

    let tableClause: string;
    if (tables.length === 1) {
      tableClause = `primary_table = $${nextIdx}`;
      params.push(tables[0]);
    } else {
      tableClause = `tables_involved ?| $${nextIdx}::text[]`;
      params.push(tables);
    }

    params.push(limit);
    const limitIdx = params.length;

    return await internalQuery<QuerySuggestionRow>(
      `SELECT * FROM query_suggestions WHERE ${orgClause} AND ${tableClause} ORDER BY score DESC LIMIT $${limitIdx}`,
      params
    );
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to get suggestions by tables");
    return [];
  }
}

export async function getPopularSuggestions(
  orgId: string | null,
  limit: number = 10
): Promise<QuerySuggestionRow[]> {
  if (!hasInternalDB()) return [];
  try {
    const orgClause = orgId != null ? "org_id = $1" : "org_id IS NULL";
    const params: unknown[] = orgId != null ? [orgId, limit] : [limit];
    const limitIdx = params.length;

    return await internalQuery<QuerySuggestionRow>(
      `SELECT * FROM query_suggestions WHERE ${orgClause} ORDER BY score DESC LIMIT $${limitIdx}`,
      params
    );
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to get popular suggestions");
    return [];
  }
}

export function incrementSuggestionClick(
  id: string,
  orgId: string | null
): void {
  if (!hasInternalDB()) return;
  const orgClause = orgId != null ? "org_id = $1" : "org_id IS NULL";
  const params: unknown[] = orgId != null ? [orgId, id] : [id];
  const idIdx = params.length;

  internalExecute(
    `UPDATE query_suggestions SET clicked_count = clicked_count + 1 WHERE ${orgClause} AND id = $${idIdx}`,
    params
  );
}

export async function deleteSuggestion(
  id: string,
  orgId: string | null
): Promise<boolean> {
  if (!hasInternalDB()) return false;
  const orgClause = orgId != null ? "org_id = $1" : "org_id IS NULL";
  const params: unknown[] = orgId != null ? [orgId, id] : [id];
  const idIdx = params.length;

  const rows = await internalQuery<{ id: string }>(
    `DELETE FROM query_suggestions WHERE ${orgClause} AND id = $${idIdx} RETURNING id`,
    params
  );
  return rows.length > 0;
}

export async function getAuditLogQueries(
  orgId: string | null,
  limit: number = 5000
): Promise<Array<{ sql: string; tables_accessed: string | null; timestamp: string }>> {
  if (!hasInternalDB()) return [];
  try {
    const orgClause = orgId != null ? "org_id = $1" : "org_id IS NULL";
    const params: unknown[] = orgId != null ? [orgId, limit] : [limit];
    const limitIdx = params.length;

    return await internalQuery<{ sql: string; tables_accessed: string | null; timestamp: string }>(
      `SELECT sql, tables_accessed, timestamp FROM audit_log WHERE ${orgClause} AND success = true AND sql IS NOT NULL ORDER BY timestamp DESC LIMIT $${limitIdx}`,
      params
    );
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to get audit log queries");
    return [];
  }
}

// ── Workspace lifecycle helpers (0.9.0) ─────────────────────────────

export type WorkspaceStatus = "active" | "suspended" | "deleted";
export type PlanTier = "free" | "trial" | "team" | "enterprise";

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  workspace_status: WorkspaceStatus;
  plan_tier: PlanTier;
  byot: boolean;
  stripe_customer_id: string | null;
  trial_ends_at: string | null;
  suspended_at: string | null;
  deleted_at: string | null;
  region: string | null;
  region_assigned_at: string | null;
  createdAt: string;
  [key: string]: unknown;
}

/**
 * Get the workspace status for an organization.
 * Returns null if the org doesn't exist or internal DB is unavailable.
 * Throws on database errors — callers must handle failures explicitly.
 */
export async function getWorkspaceStatus(orgId: string): Promise<WorkspaceStatus | null> {
  if (!hasInternalDB()) return null;
  const rows = await internalQuery<{ workspace_status: WorkspaceStatus }>(
    `SELECT workspace_status FROM organization WHERE id = $1`,
    [orgId],
  );
  return rows[0]?.workspace_status ?? null;
}

/**
 * Get full workspace details for an organization.
 */
export async function getWorkspaceDetails(orgId: string): Promise<WorkspaceRow | null> {
  if (!hasInternalDB()) return null;
  const rows = await internalQuery<WorkspaceRow>(
    `SELECT id, name, slug, workspace_status, plan_tier, byot, stripe_customer_id, trial_ends_at, suspended_at, deleted_at, region, region_assigned_at, "createdAt"
     FROM organization WHERE id = $1`,
    [orgId],
  );
  return rows[0] ?? null;
}

/**
 * Update workspace status. Returns true if the org was found and updated,
 * false if no row matched the given orgId.
 */
export async function updateWorkspaceStatus(
  orgId: string,
  status: WorkspaceStatus,
): Promise<boolean> {
  const timestampCol = status === "suspended" ? "suspended_at" : status === "deleted" ? "deleted_at" : null;

  let sqlStr: string;
  if (timestampCol) {
    sqlStr = `UPDATE organization SET workspace_status = $1, ${timestampCol} = now() WHERE id = $2 RETURNING id`;
  } else {
    // Activating: clear both timestamps
    sqlStr = `UPDATE organization SET workspace_status = $1, suspended_at = NULL, deleted_at = NULL WHERE id = $2 RETURNING id`;
  }

  const rows = await internalQuery<{ id: string }>(sqlStr, [status, orgId]);
  return rows.length > 0;
}

/**
 * Update workspace plan tier. Returns true if the org was found and updated,
 * false if no row matched the given orgId.
 */
export async function updateWorkspacePlanTier(
  orgId: string,
  planTier: PlanTier,
): Promise<boolean> {
  const rows = await internalQuery<{ id: string }>(
    `UPDATE organization SET plan_tier = $1 WHERE id = $2 RETURNING id`,
    [planTier, orgId],
  );
  return rows.length > 0;
}

/**
 * Get the region assigned to a workspace. Returns null if no region is assigned
 * or the workspace doesn't exist.
 */
export async function getWorkspaceRegion(orgId: string): Promise<string | null> {
  if (!hasInternalDB()) return null;
  const rows = await internalQuery<{ region: string | null }>(
    `SELECT region FROM organization WHERE id = $1`,
    [orgId],
  );
  return rows[0]?.region ?? null;
}

/**
 * Assign a region to a workspace. Region is immutable — once set, returns
 * `{ assigned: false, existing: <current region> }` without updating.
 * On first assignment, returns `{ assigned: true }`. If the workspace
 * does not exist, returns `{ assigned: false }` without an `existing` field.
 */
export async function setWorkspaceRegion(
  orgId: string,
  region: string,
): Promise<{ assigned: boolean; existing?: string }> {
  // Only assign if region is currently NULL (immutable after first assignment)
  const rows = await internalQuery<{ id: string }>(
    `UPDATE organization SET region = $1, region_assigned_at = now()
     WHERE id = $2 AND region IS NULL RETURNING id`,
    [region, orgId],
  );
  if (rows.length > 0) return { assigned: true };
  const existing = await internalQuery<{ region: string | null }>(
    `SELECT region FROM organization WHERE id = $1`,
    [orgId],
  );
  if (existing.length === 0) return { assigned: false };
  return { assigned: false, existing: existing[0].region ?? undefined };
}

/**
 * Cascading soft-delete cleanup for a workspace (transactional):
 * - Soft-deletes conversations (sets deleted_at)
 * - Hard-deletes org-scoped semantic entities, learned patterns, and query suggestions
 * - Hard-deletes org-scoped settings
 * - Disables scheduled tasks
 *
 * All operations run inside a single transaction via SqlClient.withTransaction —
 * either all succeed or none take effect, so retries are always safe.
 */
export async function cascadeWorkspaceDelete(orgId: string): Promise<{
  conversations: number;
  semanticEntities: number;
  learnedPatterns: number;
  suggestions: number;
  scheduledTasks: number;
  settings: number;
}> {
  if (_sqlClient) {
    // Capture in local const before async boundary to avoid race with scope finalizer
    const sql = _sqlClient;
    return Effect.runPromise(
      sql.withTransaction(
        Effect.gen(function* () {
          // Sequential execution inside transaction — pg connections process one query at a time
          const [convRows, seRows, lpRows, qsRows, stRows, settingsRows] = yield* Effect.all([
            sql<{ id: string }>`UPDATE conversations SET deleted_at = now(), updated_at = now() WHERE org_id = ${orgId} AND deleted_at IS NULL RETURNING id`,
            sql<{ id: string }>`DELETE FROM semantic_entities WHERE org_id = ${orgId} RETURNING id`,
            sql<{ id: string }>`DELETE FROM learned_patterns WHERE org_id = ${orgId} RETURNING id`,
            sql<{ id: string }>`DELETE FROM query_suggestions WHERE org_id = ${orgId} RETURNING id`,
            sql<{ id: string }>`UPDATE scheduled_tasks SET enabled = false, updated_at = now() WHERE org_id = ${orgId} RETURNING id`,
            sql<{ key: string }>`DELETE FROM settings WHERE org_id = ${orgId} RETURNING key`,
          ]);

          return {
            conversations: convRows.length,
            semanticEntities: seRows.length,
            learnedPatterns: lpRows.length,
            suggestions: qsRows.length,
            scheduledTasks: stRows.length,
            settings: settingsRows.length,
          };
        }),
      ),
    );
  }

  // Fallback: raw pool with manual transaction
  const pool = getInternalDB();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const [convResult, seResult, lpResult, qsResult, stResult, settingsResult] = await Promise.all([
      client.query(`UPDATE conversations SET deleted_at = now(), updated_at = now() WHERE org_id = $1 AND deleted_at IS NULL RETURNING id`, [orgId]),
      client.query(`DELETE FROM semantic_entities WHERE org_id = $1 RETURNING id`, [orgId]),
      client.query(`DELETE FROM learned_patterns WHERE org_id = $1 RETURNING id`, [orgId]),
      client.query(`DELETE FROM query_suggestions WHERE org_id = $1 RETURNING id`, [orgId]),
      client.query(`UPDATE scheduled_tasks SET enabled = false, updated_at = now() WHERE org_id = $1 RETURNING id`, [orgId]),
      client.query(`DELETE FROM settings WHERE org_id = $1 RETURNING key`, [orgId]),
    ]);
    await client.query("COMMIT");
    return {
      conversations: convResult.rows.length,
      semanticEntities: seResult.rows.length,
      learnedPatterns: lpResult.rows.length,
      suggestions: qsResult.rows.length,
      scheduledTasks: stResult.rows.length,
      settings: settingsResult.rows.length,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // intentionally ignored: ROLLBACK failure after a failed transaction is non-actionable
    });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get a workspace health summary: member count, conversation count,
 * query count (last 24h), connection count, and scheduled task count.
 */
export async function getWorkspaceHealthSummary(orgId: string): Promise<{
  workspace: WorkspaceRow;
  members: number;
  conversations: number;
  queriesLast24h: number;
  connections: number;
  scheduledTasks: number;
} | null> {
  if (!hasInternalDB()) return null;

  const workspace = await getWorkspaceDetails(orgId);
  if (!workspace) return null;

  const countQuery = (sql: string, params: unknown[]) =>
    Effect.tryPromise({ try: () => internalQuery<{ count: number }>(sql, params), catch: normalizeError });

  const [memberRows, convRows, queryRows, connRows, taskRows] = await Effect.runPromise(
    Effect.all([
      countQuery(`SELECT COUNT(*)::int as count FROM member WHERE "organizationId" = $1`, [orgId]),
      countQuery(`SELECT COUNT(*)::int as count FROM conversations WHERE org_id = $1`, [orgId]),
      countQuery(`SELECT COUNT(*)::int as count FROM audit_log WHERE org_id = $1 AND timestamp > now() - interval '24 hours'`, [orgId]),
      countQuery(`SELECT COUNT(*)::int as count FROM connections WHERE org_id = $1`, [orgId]),
      countQuery(`SELECT COUNT(*)::int as count FROM scheduled_tasks WHERE org_id = $1 AND enabled = true`, [orgId]),
    ], { concurrency: "unbounded" }).pipe(
      Effect.timeoutFail({
        duration: Duration.seconds(30),
        onTimeout: () => new Error(`Workspace health summary queries for org ${orgId} timed out after 30s`),
      }),
    ),
  );

  return {
    workspace,
    members: memberRows[0]?.count ?? 0,
    conversations: convRows[0]?.count ?? 0,
    queriesLast24h: queryRows[0]?.count ?? 0,
    connections: connRows[0]?.count ?? 0,
    scheduledTasks: taskRows[0]?.count ?? 0,
  };
}

// ── Billing helpers (0.9.0 — Stripe billing) ────────────────────────

/**
 * Update the BYOT (Bring Your Own Token) flag for a workspace.
 * Returns true if the org was found and updated.
 */
export async function updateWorkspaceByot(
  orgId: string,
  byot: boolean,
): Promise<boolean> {
  const rows = await internalQuery<{ id: string }>(
    `UPDATE organization SET byot = $1 WHERE id = $2 RETURNING id`,
    [byot, orgId],
  );
  return rows.length > 0;
}

/**
 * Set the Stripe customer ID for a workspace.
 */
export async function setWorkspaceStripeCustomerId(
  orgId: string,
  stripeCustomerId: string,
): Promise<boolean> {
  const rows = await internalQuery<{ id: string }>(
    `UPDATE organization SET stripe_customer_id = $1 WHERE id = $2 RETURNING id`,
    [stripeCustomerId, orgId],
  );
  return rows.length > 0;
}

/**
 * Set the trial end date for a workspace.
 */
export async function setWorkspaceTrialEndsAt(
  orgId: string,
  trialEndsAt: Date,
): Promise<boolean> {
  const rows = await internalQuery<{ id: string }>(
    `UPDATE organization SET trial_ends_at = $1 WHERE id = $2 RETURNING id`,
    [trialEndsAt.toISOString(), orgId],
  );
  return rows.length > 0;
}
