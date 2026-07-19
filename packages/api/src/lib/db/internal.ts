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
import { resolveStatusClause } from "@atlas/api/lib/content-mode/port";
import { getEncryptionKeyset } from "@atlas/api/lib/db/encryption-keys";
import { getConnectTimeoutMs } from "@atlas/api/lib/db/pool-config";
import { foldRollingMean } from "@atlas/api/lib/learn/rolling-mean";
import { REPEATED_PATTERN_MIN_REPETITIONS } from "@atlas/api/lib/learn/pattern-tiers";
import {
  ELIGIBLE_SET_ORDER_BY_SQL,
  ELIGIBLE_SET_SAFETY_CAP,
} from "@atlas/api/lib/learn/eligible-set";
import {
  amendmentIdentityFromRow,
  amendmentIdentityKey,
  type AmendmentIdentityRow,
} from "@atlas/api/lib/semantic/amendment-identity";

const log = createLogger("internal-db");

// Re-exports: downstream callers import encryption helpers from
// `@atlas/api/lib/db/internal` for historical reasons. Keep the surface
// stable even though the resolver itself now lives in
// `encryption-keys.ts`.
export {
  getEncryptionKey,
  getEncryptionKeyset,
  _resetEncryptionKeyCache,
} from "@atlas/api/lib/db/encryption-keys";
export type {
  EncryptionKeyset,
  VersionedKey,
} from "@atlas/api/lib/db/encryption-keys";

// ---------------------------------------------------------------------------
// Connection URL encryption (AES-256-GCM)
// ---------------------------------------------------------------------------

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16;

/**
 * Versioned ciphertext prefix. Post-F-47 all new writes carry
 * `enc:v<N>:iv:authTag:ciphertext`; pre-F-47 URLs encrypted by this
 * module use the bare `iv:authTag:ciphertext` 3-part format and are
 * decrypted via the unversioned fallback below.
 */
const VERSIONED_PREFIX_RE = /^enc:v(\d+):(.+)$/s;

/** Parse `enc:v<N>:body`. Returns null if the input lacks the prefix. */
function parseVersionedCiphertext(stored: string): { version: number; body: string } | null {
  const match = stored.match(VERSIONED_PREFIX_RE);
  if (!match) return null;
  const version = Number.parseInt(match[1], 10);
  if (!Number.isFinite(version) || version < 1) return null;
  return { version, body: match[2] };
}

/** AES-GCM decrypt of a 3-part `iv:authTag:ciphertext` body under a specific key. */
function decryptBody(body: string, key: Buffer): string {
  const parts = body.split(":");
  if (parts.length !== 3) {
    throw new Error("Failed to decrypt stored secret: unrecognized format");
  }
  const iv = Buffer.from(parts[0], "base64");
  const authTag = Buffer.from(parts[1], "base64");
  const ciphertext = Buffer.from(parts[2], "base64");
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Branded result type of this module's `encryptSecret`. Structural
 * (zero-runtime) brand that separates URL-aware ciphertext from the
 * `enc:v<N>:`-only ciphertext produced by `db/secret-encryption.ts`'s
 * `OpaqueSecret`. The two helpers share the AES-256-GCM ciphertext
 * format on the wire — the brand exists purely to prevent an
 * IDE-driven auto-import from binding a URL column to the
 * opaque-secret helper (or vice versa), since the read paths differ:
 * this module's `decryptSecret` short-circuits on `isPlaintextUrl(...)`
 * and tolerates the legacy 3-part unversioned format, while the
 * opaque helper only short-circuits on absence of the `enc:v<N>:`
 * prefix. See the issue trail in #2370 / #2285.
 *
 * What the brand fences: "this string flowed through this module's
 * `encryptSecret`." It does **not** guarantee the string is
 * ciphertext — the keyless-dev passthrough at the top of
 * `encryptSecret` returns plaintext stamped as `URLSecret`. The
 * brand's job is routing between the two helpers, not asserting an
 * encryption property of the value.
 *
 * Pair this with `RawSecret` on `decryptSecret` to keep plain pg row
 * strings flowing through without manual casts while still rejecting
 * the sibling brand at the type level.
 */
export type URLSecret = string & { readonly __brand: "URLSecret" };

/**
 * "Unbranded" pg row string — used in `decryptSecret`'s parameter so
 * raw column reads don't need a manual cast, while still rejecting
 * a value tagged with the sibling brand (`OpaqueSecret`). Mechanics:
 * `__brand?: never` is satisfied by absence of the property (plain
 * `string` has none) but **not** by a value whose `__brand` carries a
 * literal string (URLSecret/OpaqueSecret both fail the `never` check).
 *
 * Enforcement is purely static: an `as string` widen, an `unknown`
 * boundary, a `JSON.parse` result, or a template literal `${branded}`
 * all erase the brand back to plain `string`, which then satisfies
 * `RawSecret` and routes through either decryptor. The brand catches
 * the direct typed-call-site misroute (the dominant IDE-auto-import
 * bug class). It is **not** a runtime guarantee about provenance.
 */
export type RawSecret = string & { readonly __brand?: never };

/**
 * Encrypts an arbitrary string secret (connection URL, API key, JSON
 * cred bundle) using AES-256-GCM under the active keyset entry. New
 * writes carry the `enc:v<N>:` prefix so the rotation script can
 * identify rows below the active version. Returns the plaintext
 * unchanged if no encryption key is available (dev / self-hosted
 * passthrough).
 *
 * Companion: `db/secret-encryption.ts` also exports `encryptSecret` —
 * that helper is for new integration-credential columns where the
 * URL-shape passthrough in `decryptSecret` (below) would misclassify
 * inputs like Telegram tokens or JSON blobs. See its module header
 * for the picking guide. The brand types (`URLSecret` here vs
 * `OpaqueSecret` there) make a misrouted call a compile error.
 *
 * Post-1.5.3 closeout (#2755) this helper is reserved for the two
 * surviving legacy columns (`workspace_model_config.api_key_encrypted`,
 * `sso_providers.config.clientSecret`). All other call sites use
 * `db/secret-encryption.ts`. The deprecated `encryptUrl` / `decryptUrl`
 * aliases were removed per the original #2285 schedule.
 */
export function encryptSecret(plaintext: string): URLSecret {
  const keyset = getEncryptionKeyset();
  if (!keyset) return plaintext as URLSecret;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, keyset.active.key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // `:` is safe as delimiter — base64 alphabet is A-Za-z0-9+/= (no colon)
  return `enc:v${keyset.active.version}:${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}` as URLSecret;
}

/**
 * Decrypts a string secret encrypted by `encryptSecret()`.
 * Read order (each case short-circuits):
 *   1. Looks like a plaintext URL (`scheme://…`) → return as-is.
 *   2. Carries `enc:v<N>:` prefix → look up key by version; fail loudly
 *      if the version isn't in the active keyset (operator misconfig).
 *   3. Three colon-separated base64 parts → pre-F-47 unversioned
 *      format; decrypt with the active key (same as pre-F-47 behavior).
 *   4. Anything else → unrecognized format, throw.
 *
 * Accepts `URLSecret | RawSecret` so raw DB row values (`string` from
 * pg) keep round-tripping without a manual cast. `RawSecret` is plain
 * string with `__brand?: never`, which a property-less string trivially
 * satisfies but the sibling brand (`OpaqueSecret`) does not — so a
 * statically-typed `OpaqueSecret` value can never be fed here. The
 * brand catches the dominant cross-helper write/read divergence (a
 * URL written via the opaque helper would round-trip as plaintext on
 * the URL-helper read path). Enforcement is static-only: a value
 * widened back to `string` (e.g. via `JSON.parse`, an `unknown`
 * boundary, or an explicit `as string`) loses the brand and routes
 * through `RawSecret`. See `RawSecret`'s JSDoc for the trade-off.
 */
export function decryptSecret(stored: URLSecret | RawSecret): string {
  if (isPlaintextUrl(stored)) return stored;

  const keyset = getEncryptionKeyset();
  if (!keyset) {
    log.error("Encrypted secret found but no encryption key is available — set ATLAS_ENCRYPTION_KEY or BETTER_AUTH_SECRET");
    throw new Error("Cannot decrypt stored secret: no encryption key available");
  }

  const versioned = parseVersionedCiphertext(stored);
  if (versioned) {
    const key = keyset.byVersion.get(versioned.version);
    if (!key) {
      log.error(
        { version: versioned.version, active: keyset.active.version },
        "Encrypted secret references an unknown key version — ATLAS_ENCRYPTION_KEYS missing this version",
      );
      throw new Error(
        `Cannot decrypt stored secret: key version v${versioned.version} not present in ATLAS_ENCRYPTION_KEYS`,
      );
    }
    try {
      return decryptBody(versioned.body, key);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), version: versioned.version },
        "Failed to decrypt versioned secret — data may be corrupted",
      );
      throw new Error("Failed to decrypt stored secret", { cause: err });
    }
  }

  // Pre-F-47 legacy unversioned format: iv:authTag:ciphertext. Try v1
  // first (pre-F-47 deployments had a single key, and the F-47 keyset
  // adopts it as v1). If v1 isn't in the keyset — a fresh deployment
  // that landed post-F-47 with only `ATLAS_ENCRYPTION_KEYS=v2:…` —
  // fall back to the active key as a last resort. A failed decrypt
  // under the chosen key surfaces as a 500; recovery requires adding
  // the original raw key material back to the keyset (under any
  // version label — legacy ciphertext carries no version, so any entry
  // that successfully decrypts is the right one).
  const parts = stored.split(":");
  if (parts.length !== 3) {
    log.error({ partCount: parts.length }, "Stored secret is not plaintext and does not match encrypted format (expected 3 colon-separated parts)");
    throw new Error("Failed to decrypt stored secret: unrecognized format");
  }
  const legacyKey = keyset.byVersion.get(1);
  const usingActiveFallback = legacyKey === undefined;
  if (usingActiveFallback) {
    // Visible breadcrumb — this path almost certainly fails (the active
    // key was never used to encrypt un-versioned data unless the deploy
    // started with it) and the operator needs the hint that adding the
    // original key back under `v1:…` is the fix, not a ciphertext audit.
    log.warn(
      { active: keyset.active.version },
      "F-47 legacy-unversioned secret encountered with no v1 key in ATLAS_ENCRYPTION_KEYS — " +
      "falling back to the active key. If this row was written pre-F-47 under a different raw value, " +
      "decryption will fail; add the original key back as v1:<raw> in ATLAS_ENCRYPTION_KEYS.",
    );
  }
  const keyToUse = legacyKey ?? keyset.active.key;
  try {
    return decryptBody(stored, keyToUse);
  } catch (err) {
    log.error(
      {
        err: err instanceof Error ? err.message : String(err),
        usingActiveFallback,
      },
      "Failed to decrypt stored secret — data may be corrupted or key may have changed",
    );
    throw new Error("Failed to decrypt stored secret", { cause: err });
  }
}

/**
 * Returns true when the value looks like a plaintext URL. Rejects
 * versioned ciphertext like `enc:v1:…` (regex requires `://` after the
 * scheme) so the F-47 prefix is never mistaken for a scheme.
 */
export function isPlaintextUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

// Secret encryption for integration credentials lives in a sibling
// module — see `secret-encryption.ts`. Keeping those exports out of
// `internal.ts` avoids forcing every test that partially mocks
// `db/internal` to declare three extra no-op exports.

/**
 * Typed interface for the internal pg.Pool — avoids importing pg at
 * module level. Passing a truthy `err` to `release` tells node-postgres
 * to destroy the socket instead of returning it to the pool.
 */
export interface InternalPoolClient {
  // `rowCount` is optional so lightweight mocks can keep returning `{ rows }`;
  // the real pg client always populates it (residency cleanup reads it for
  // its per-table deletion audit — see lib/residency/cleanup.ts).
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  release(err?: Error): void;
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
      // oxlint-disable-next-line @typescript-eslint/no-require-imports
      const { Pool } = require("pg");
      const pool: PgPool = new Pool({
        connectionString: connString,
        max: 5,
        idleTimeoutMillis: 30000,
        // Fail fast when the internal DB is unreachable-but-routable instead of
        // stalling every login for the OS TCP keepalive window (#4463).
        connectionTimeoutMillis: getConnectTimeoutMs(),
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
        try: async () => {
          // The Stripe lock pool rides the same lifecycle (it is never
          // Effect-managed itself); endStripeLockPool never throws.
          await endStripeLockPool();
          return pool.end();
        },
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

/**
 * Build an `InternalDB` Layer backed by the module-level `internalQuery` /
 * `internalExecute` helpers rather than by its own pg.Pool.
 *
 * The production `makeInternalDBLive()` creates a pool inside an Effect
 * Scope. Route handlers today don't have access to the AppLayer's
 * `ManagedRuntime`, so they can't yield Effect services that require
 * `InternalDB` (e.g. `ContentModeRegistry.countAllDrafts`). This shim
 * lets a route provide `InternalDB` to its own Effect program via
 * `Layer.provide` without opening a second pool — the module-level
 * `_pool` is shared with the AppLayer's live InternalDB (set during
 * `makeInternalDBLive` construction).
 *
 * Use only from route handlers that need to `.pipe(Effect.provide(...))`
 * a content-mode or similar service inline. Do not use in AppLayer
 * composition — `makeInternalDBLive` is the source of truth there.
 */
export function makeInternalDBShimLayer(): Layer.Layer<InternalDB> {
  return Layer.succeed(InternalDB, {
    // `sql` is null in the shim — tagged-template SqlClient callers must
    // use the real AppLayer InternalDB (via ManagedRuntime). Routes that
    // need SqlClient access shouldn't be using this shim.
    sql: null,
    query: internalQuery,
    execute: internalExecute,
    get available() {
      return hasInternalDB();
    },
    get pool() {
      return _pool;
    },
  } satisfies InternalDBShape);
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
/** Dedicated pool for the Stripe advisory lock — see {@link getStripeLockPool}. */
let _lockPool: InternalPool | null = null;

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
  // oxlint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require("pg");
  const connString = databaseUrl.replace(
    /([?&])sslmode=require(?=&|$)/,
    "$1sslmode=verify-full",
  );
  _pool = new Pool({
    connectionString: connString,
    max: 5,
    idleTimeoutMillis: 30000,
    // Fail fast when the internal DB is unreachable-but-routable (#4463).
    connectionTimeoutMillis: getConnectTimeoutMs(),
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
 * Dedicated pool for `withStripeSubscriptionLock` (#3445). A lock holder
 * keeps its client checked out (idle in transaction) for the whole locked
 * section, while the section's own queries go through the pooled
 * `internalQuery` — if both drew from the SAME bounded pool, a burst of
 * concurrent webhook deliveries could pin every client in lock
 * transactions and leave none for the inner queries the holders need to
 * make progress: a circular wait with no timeout that hangs every
 * internal-DB user (#3465 review). Lock traffic gets its own pool so a
 * holder's progress depends only on the main pool, which no lock
 * participant ever occupies; this pool's size merely bounds how many
 * locked sections run at once.
 *
 * Never Effect-managed: created lazily on first use, closed by
 * `closeInternalDB`, the InternalDB Layer finalizer, and `_resetPool`.
 */
function getStripeLockPool(): InternalPool {
  if (_lockPool) return _lockPool;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Atlas internal database requires a PostgreSQL connection string."
    );
  }
  // oxlint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require("pg");
  const connString = databaseUrl.replace(
    /([?&])sslmode=require(?=&|$)/,
    "$1sslmode=verify-full",
  );
  _lockPool = new Pool({
    connectionString: connString,
    max: 5,
    idleTimeoutMillis: 30000,
    // Fail fast when the internal DB is unreachable-but-routable (#4463).
    connectionTimeoutMillis: getConnectTimeoutMs(),
  }) as InternalPool;
  _lockPool.on("error", (err: unknown) => {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Stripe lock pool idle client error",
    );
  });
  return _lockPool;
}

/** Close the Stripe lock pool if one was created. Never throws. */
async function endStripeLockPool(): Promise<void> {
  const lockPool = _lockPool;
  _lockPool = null;
  if (!lockPool) return;
  try {
    await lockPool.end();
    log.info("Stripe lock pool closed");
  } catch (err: unknown) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Error closing Stripe lock pool",
    );
  }
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
  // The Stripe lock pool is never Effect-managed — close it whenever the
  // internal DB shuts down, whichever lifecycle owns the main pool.
  await endStripeLockPool();
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

/**
 * Reset singleton for testing. Optionally inject a mock pool and/or SqlClient.
 *
 * Also tears down any in-flight circuit-breaker recovery fiber. A recovery
 * fiber sleeps 30s of wall-clock and then probes `getInternalDB().query("SELECT 1")`
 * against whatever pool is currently installed. If we swap `_pool` here but
 * leave the fiber running, ~30s later it fires a spurious `SELECT 1` into the
 * *next* test's mock pool — a cross-test timing flake that only surfaces when
 * the suite runs slowly enough (e.g. under the isolated runner's 32-way
 * concurrency) for the file to still be executing 30s after the circuit
 * tripped. Resetting the pool must reset the full circuit state, fiber
 * included (#3083).
 */
export function _resetPool(
  mockPool?: InternalPool | null,
  mockSql?: SqlClient.SqlClient | null,
  mockLockPool?: InternalPool | null,
): void {
  _pool = mockPool ?? null;
  _sqlClient = mockSql ?? null;
  // The Stripe lock pool is deliberately NOT defaulted to `mockPool` —
  // lock traffic never shares the main pool in production (#3465), and a
  // shared mock would double-close in closeInternalDB(). Tests that
  // exercise the lock path inject it explicitly.
  _lockPool = mockLockPool ?? null;
  _poolManagedByEffect = false;
  _consecutiveFailures = 0;
  _circuitOpen = false;
  _droppedCount = 0;
  _interruptRecoveryFiber();
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

/**
 * `Effect.promise(() => internalQuery(...))` hides DB rejections in the defect
 * channel; route handlers should use `queryEffect` so failures land in the
 * typed `E: Error` channel and can be caught or mapped downstream.
 */
export function queryEffect<T extends Record<string, unknown>>(
  sqlStr: string,
  params?: unknown[],
): Effect.Effect<T[], Error> {
  return Effect.tryPromise({
    try: () => internalQuery<T>(sqlStr, params),
    catch: normalizeError,
  });
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

/**
 * Interrupt the in-flight recovery fiber (if any) and clear the reference.
 *
 * Shared by `_resetCircuitBreaker` and `_resetPool` so neither can leave a
 * fiber alive to probe a swapped-out pool 30s later (#3083). The fiber is
 * sleeping in `Effect.sleep(30s)` at this point, so interruption is prompt —
 * the probe never runs. We null the reference synchronously; the forked
 * interrupt completes in the background.
 */
function _interruptRecoveryFiber(): void {
  if (_recoveryFiber) {
    Effect.runFork(Fiber.interrupt(_recoveryFiber));
    _recoveryFiber = null;
  }
}

/** Reset circuit breaker state. For testing only. */
export function _resetCircuitBreaker(): void {
  _consecutiveFailures = 0;
  _circuitOpen = false;
  _droppedCount = 0;
  _interruptRecoveryFiber();
}

/** @internal — test seam. True when a background recovery fiber is in flight.
 *  Lets the #3083 regression test assert that a pool/circuit reset tears the
 *  fiber down, without waiting out the 30s recovery sleep. */
export function _hasRecoveryFiber(): boolean {
  return _recoveryFiber !== null;
}

/**
 * True when fire-and-forget writes are being dropped by the circuit
 * breaker. Read this *before* enqueueing a security-control audit row
 * (e.g. a rate-limit denial) so the call site can light up a
 * differentiated metric + `log.error` on drop. The fire-and-forget
 * `internalExecute` only logs an aggregate "Internal DB circuit breaker
 * open" once on open and a per-write debug line; without an exposed
 * predicate, security-control callers can't tell their row was dropped
 * (#2183 item 3).
 */
export function isInternalCircuitOpen(): boolean {
  return _circuitOpen;
}

/** @internal — test seam. Force the circuit-breaker state for fault-injection
 *  tests that exercise the security-control drop telemetry path. */
export function _setInternalCircuitOpenForTests(open: boolean): void {
  _circuitOpen = open;
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
 * Migrations that depend on Better Auth tables (`organization`, `user`,
 * `session`, etc.). Better Auth creates these tables only when managed
 * auth is enabled — in any other mode Better Auth's `runMigrations` is
 * never called, so applying these files would fail with `relation
 * "..." does not exist`. The runner skips them in non-managed mode.
 *
 * Original list scoped to the `organization` table only (#1472); now
 * covers any Better Auth–dependent table including `user` / `session`
 * (#2117). Renaming follow-up to make the intent explicit.
 */
export const MANAGED_AUTH_MIGRATIONS = [
  "0027_organization_saas_columns.sql",
  "0042_audit_retention_default.sql",
  // Foreign key to Better Auth's "user" table.
  "0048_trusted_device.sql",
  // Backfill against Better Auth's "user" + "session" tables.
  "0050_backfill_email_verified_grandfathered.sql",
  // Adds default_landing column to Better Auth's "user" table (#2022).
  "0061_user_default_landing.sql",
  // Adds is_operator_workspace column to Better Auth's "organization"
  // table (#2702).
  "0090_organization_is_operator_workspace.sql",
  // Adds last_active_at column to Better Auth's "organization" table for
  // BYOT-catalog dormancy gating (#2377).
  "0115_org_last_active_at.sql",
  // Backfills "member" + clears Better Auth's "user".role = 'admin' (#2890).
  "0118_drop_user_admin_role.sql",
  // Adds the @better-auth/stripe plugin's "stripeCustomerId" column to
  // Better Auth's "organization" table (#3417).
  "0126_org_stripe_customer_id_plugin_column.sql",
  // Widens organization.chk_plan_tier with the 'locked' churn tier (#3421).
  "0127_plan_tier_locked.sql",
  // FK to Better Auth's "user" + backfill against "member"/"organization"
  // (#3469/#3470 one-trial-per-user durable marker).
  "0130_user_trial_grants.sql",
  // Adds suspension_source to Better Auth's "organization" table so billing
  // recovery only unsuspends billing-induced suspensions, never operator
  // ones (#3424).
  "0131_org_suspension_source.sql",
  // Adds plan_override_until to Better Auth's "organization" table so the
  // Stripe webhook tier sync respects an active platform-admin plan grant
  // instead of clobbering it (#3427).
  "0132_org_plan_override.sql",
  // Adds normalizedEmail (+ unique index) to Better Auth's "user" table for
  // business-email-only signup / one-trial-per-user teeth (#3650).
  "0142_user_normalized_email.sql",
  // Adds the pgcrypto functional index on sha256(lower(email)) over Better
  // Auth's "user" table that backs the returning-user login front-door's
  // hashed-email existence probe (ADR-0024 §3, #3973).
  "0151_user_email_hash_index.sql",
  // Adds the `origin` marker column to Better Auth's "session" table so the
  // atlas-login device flow can stamp `origin='cli'` for key-scoping
  // (ADR-0026 / #4043).
  "0158_session_origin_column.sql",
  // Drops the @better-auth/stripe plugin's user-level "stripeCustomerId" column
  // from Better Auth's "user" table — phase 2 of the two-phase drop (#4013).
  // MANAGED_AUTH because it ALTERs Better Auth's "user" table, which only
  // exists in managed mode. Paired with a buildPlugins() schema strip so Better
  // Auth's auto-migrate never re-adds the column (see server.ts / the migration
  // header).
  "0159_drop_user_stripe_customer_id.sql",
];

/**
 * Idempotent migration: runs versioned SQL migrations from `migrations/`
 * directory, then applies data seeds.
 *
 * Replaces the old imperative DDL approach (152 individual pool.query calls)
 * with a file-based migration runner tracked in `__atlas_migrations`. See #978.
 *
 * Retries up to 5 times with exponential backoff (1s, 2s, 4s, 8s, 16s) to
 * handle serverless Postgres cold starts on Railway where the DB may take
 * several seconds to wake up.
 *
 * In non-managed auth modes, migrations that depend on any Better Auth
 * table (`organization`, `user`, `session`, …) are skipped — Better
 * Auth never creates them, so applying them would fail. They get picked
 * up automatically if the deployment later switches to managed auth.
 * See `MANAGED_AUTH_MIGRATIONS` and #1472 / #2117.
 */
export async function migrateInternalDB(): Promise<void> {
  // Warn when DATABASE_URL and ATLAS_DATASOURCE_URL resolve to the same
  // database — internal tables will share the schema with analytics data.
  // This is intentional in single-DB deployments but can surprise operators
  // who expect isolation. (#962)
  warnIfSharedDatabase();

  const pool = getInternalDB();

  const { runMigrations, runSeeds } = await import("@atlas/api/lib/db/migrate");
  // Dynamic import — db/internal is imported by lower-level modules in the
  // dependency graph (e.g. logger sinks, effect services), so a static import
  // of auth/detect → config triggers a circular evaluation order that breaks
  // module-link in some test runners (mcp test suite). See #1487.
  const { detectAuthMode } = await import("@atlas/api/lib/auth/detect");
  const skip = detectAuthMode() === "managed" ? [] : MANAGED_AUTH_MIGRATIONS;

  // Retry with backoff for serverless Postgres cold starts (Railway).
  // Set ATLAS_MIGRATION_RETRIES=0 to disable retries (e.g. in tests).
  const maxRetries = parseInt(process.env.ATLAS_MIGRATION_RETRIES ?? "5", 10);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await runMigrations(pool, { skip });
      break;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delayMs = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s, 8s, 16s
      log.warn(
        { attempt, maxRetries, delayMs, err: err instanceof Error ? err.message : String(err) },
        "Migration failed — retrying (serverless DB may be cold-starting)",
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  await runSeeds(pool);

  log.info("Internal DB migration complete");
}

// Old imperative DDL removed — see migrations/0000_baseline.sql (#978)

// seedPromptLibrary moved to migrate.ts → runSeeds() (#978)

/**
 * Load admin-managed datasource installs from `workspace_plugins` and
 * register them in the ConnectionRegistry. Idempotent — safe to call at
 * startup. Silently skips if no internal DB or `workspace_plugins`
 * doesn't exist yet.
 *
 * 0094 / #2744 — post-cutover this reads from
 * `workspace_plugins WHERE pillar = 'datasource'` instead of the dropped
 * `connections` table. Per ADR-0007 the URL lives inside `config` JSONB
 * with selective-field encryption; `decryptSecretFields` (keyed off the
 * catalog row's `config_schema`) unwraps it. `DatasourcePoolResolver`
 * translates the resulting (row, decrypted config) pair into the typed
 * `DatasourcePoolConfig` we hand to `ConnectionRegistry.register`.
 *
 * Multi-tenant (#2783): loads EVERY non-archived datasource install — one
 * row per (workspace_id, install_id) — and registers each via the bridge,
 * which keys the routing config by (workspace_id, install_id). Two workspaces
 * sharing an `install_id` (e.g. both naming their warehouse `warehouse`, or
 * both auto-owning the demo at `install_id='__demo__'`) therefore get
 * independent base configs instead of collapsing onto a single base URL — the
 * old `DISTINCT ON (install_id)` hack that silently routed one workspace's
 * queries to the other's DB is gone. The `default` connection (auto-initialised
 * from `ATLAS_DATASOURCE_URL`) continues to be runtime-only and is NOT touched
 * here.
 */
export async function loadSavedConnections(): Promise<number> {
  if (!hasInternalDB()) return 0;

  // Lazy-imports to avoid circular dependency at module level + keep
  // the static graph here narrow (admin-route tests partial-mock this
  // module heavily and would otherwise need to declare extra no-op
  // exports).
  const { BUILTIN_DATASOURCE_CATALOG_SLUGS } = await import(
    "@atlas/api/lib/db/datasource-pool-resolver"
  );
  const { registerDatasourceInstall } = await import(
    "@atlas/api/lib/db/datasource-registry-bridge"
  );
  const { decryptSecretFields, parseConfigSchema } =
    await import("@atlas/api/lib/plugins/secrets");

  try {
    type WpRow = {
      workspace_id: string;
      install_id: string;
      catalog_slug: string;
      config: Record<string, unknown> | null;
      config_schema: unknown;
    };
    // Exclude `status = 'archived'` so per-workspace demo-hide rows never
    // feed their decrypted URL to the registry. One row per (workspace_id,
    // install_id) — the bridge keys routing config by that composite, so two
    // workspaces sharing an install_id no longer collapse (#2783, retires the
    // old `DISTINCT ON (install_id)` hack). Deterministic order so the bare
    // install-id metadata row (first-write-wins, see the bridge) is stable.
    const rows = await internalQuery<WpRow>(
      `SELECT wp.workspace_id,
              wp.install_id,
              pc.slug AS catalog_slug,
              wp.config,
              pc.config_schema
         FROM workspace_plugins wp
         JOIN plugin_catalog pc ON pc.id = wp.catalog_id
        WHERE wp.pillar = 'datasource'
          AND wp.status != 'archived'
          AND pc.slug = ANY($1::text[])
        ORDER BY wp.install_id, wp.workspace_id ASC, wp.installed_at DESC`,
      [BUILTIN_DATASOURCE_CATALOG_SLUGS as readonly string[]],
    );

    let registered = 0;
    for (const row of rows) {
      // `stage` lets log alerting differentiate between schema-parse,
      // decrypt, and bridge failures without parsing the error message.
      // `bridge` is coarse-grained on purpose: it covers both resolver
      // violations (missing required field, invalid schema identifier)
      // and registry-side failures (`connections.register` rejecting a
      // URL scheme). They share a stage because the bridge fuses them
      // into one call. Run the migration sanity-check script
      // (`db/migrations/scripts/0094_*`) to disambiguate.
      let stage: "parse" | "decrypt" | "bridge" = "parse";
      try {
        const schema = parseConfigSchema(row.config_schema);
        stage = "decrypt";
        const decryptedConfig = decryptSecretFields(row.config ?? {}, schema);
        stage = "bridge";
        const didRegister = await registerDatasourceInstall(
          {
            workspaceId: row.workspace_id,
            catalogId: "",
            installId: row.install_id,
            pillar: "datasource",
            catalogSlug: row.catalog_slug,
          },
          decryptedConfig,
        );
        if (didRegister) registered++;
      } catch (err) {
        log.warn(
          {
            stage,
            workspaceId: row.workspace_id,
            installId: row.install_id,
            catalogSlug: row.catalog_slug,
            err: err instanceof Error ? err.message : String(err),
          },
          "Failed to register saved datasource install — skipping",
        );
      }
    }

    if (registered > 0) {
      log.info({ count: registered }, "Loaded datasource installs from workspace_plugins");
    }
    return registered;
  } catch (err) {
    // Distinguish "table missing" (Postgres SQLSTATE 42P01 —
    // `undefined_table`, expected on pre-migration first boot) from
    // every other failure (connectivity loss, permissions change,
    // dynamic-import failure, syntactic regression). The pre-cutover
    // code swallowed everything as "first boot"; post-cutover that's
    // misleading — `workspace_plugins` always exists in any working
    // deploy, so a thrown error is real signal.
    const sqlstate = isPgError(err) ? err.code : undefined;
    if (sqlstate === "42P01") {
      log.warn(
        { sqlstate, err: err instanceof Error ? err.message : String(err) },
        "workspace_plugins / plugin_catalog not present — skipping datasource load (expected on first boot)",
      );
      return 0;
    }
    log.error(
      { sqlstate, err: err instanceof Error ? err.message : String(err) },
      "Failed to load datasource installs from workspace_plugins — registry will be empty until next boot",
    );
    return 0;
  }
}

/**
 * Counts of the fresh registry mutations a {@link reconcileWorkspaceDatasources}
 * pass performed — best-effort observability, not an accounting guarantee
 * (per-row failures are logged + skipped, so this may undercount the rows seen).
 */
export interface ReconcileResult {
  readonly registered: number;
  readonly deregistered: number;
}

/**
 * Reconcile the live `ConnectionRegistry` against the CURRENTLY-PERSISTED
 * datasource installs for a single workspace/org — the hot path that retires
 * the "publish, then restart the API" dance (#3856).
 *
 * Boot-time `loadSavedConnections` registers every non-archived install once,
 * process-wide. But the atomic publish endpoint (`admin-publish.ts`) only flips
 * `workspace_plugins.status` in SQL — it never touches the in-memory registry.
 * So a datasource that an admin newly published (draft → published) is live in
 * the registry ONLY because its install-time registration happened to survive;
 * and a datasource the publish flow ARCHIVED keeps serving from a stale pool
 * until the next boot. This function closes both ends: after a publish commits,
 * the caller reconciles this org's installs so newly-published datasources go
 * queryable immediately and archived ones stop serving — with no API restart
 * and no manual `group_id` SQL.
 *
 * Symmetric and idempotent:
 *   - every non-archived install → `registerDatasourceInstall` (idempotent —
 *     the bridge's `has()` guards make a re-register a no-op; a plugin pool is
 *     rebuilt in place);
 *   - every archived install → `unregisterDatasourceInstall` (returns `false`
 *     when nothing was registered — a no-op for a row that never went live).
 *
 * Per-row failures are caught + logged (never abort the loop) so one
 * misconfigured install can't strand the rest — exactly the boot-loader
 * posture. Best-effort by contract: the publish has already COMMITTED before
 * this runs, so a transient registry failure must not fail the publish (the
 * next boot's `loadSavedConnections` still reconciles).
 *
 * @param orgId - Workspace/org whose datasource installs to reconcile.
 * @returns Counts of fresh registrations + deregistrations performed.
 */
export async function reconcileWorkspaceDatasources(
  orgId: string,
): Promise<ReconcileResult> {
  if (!hasInternalDB()) return { registered: 0, deregistered: 0 };

  const { BUILTIN_DATASOURCE_CATALOG_SLUGS } = await import(
    "@atlas/api/lib/db/datasource-pool-resolver"
  );
  const { registerDatasourceInstall, unregisterDatasourceInstall } = await import(
    "@atlas/api/lib/db/datasource-registry-bridge"
  );
  const { decryptSecretFields, parseConfigSchema } =
    await import("@atlas/api/lib/plugins/secrets");

  try {
    type WpRow = {
      workspace_id: string;
      install_id: string;
      catalog_slug: string;
      config: Record<string, unknown> | null;
      config_schema: unknown;
      // The content-mode column (enum + CHECK per migration). Only `archived`
      // is semantically load-bearing here (drives the deregister branch); any
      // non-archived value (`draft`/`published`) is treated as "should be live".
      // The union annotation documents the closed domain and guards the
      // `=== "archived"` literal at compile time — the `internalQuery<T>` cast
      // is unchecked, so an out-of-domain value falls into the (idempotent)
      // re-register branch, which fails safe.
      status: "draft" | "published" | "archived";
    };
    // Unlike `loadSavedConnections`, this scopes to ONE workspace and reads
    // ALL statuses (incl. `archived`) so the archived rows drive the
    // deregister branch — the reconcile must be able to evict a pool the
    // publish just archived, not merely skip it.
    const rows = await internalQuery<WpRow>(
      `SELECT wp.workspace_id,
              wp.install_id,
              pc.slug AS catalog_slug,
              wp.config,
              pc.config_schema,
              wp.status
         FROM workspace_plugins wp
         JOIN plugin_catalog pc ON pc.id = wp.catalog_id
        WHERE wp.workspace_id = $1
          AND wp.pillar = 'datasource'
          AND pc.slug = ANY($2::text[])
        ORDER BY wp.install_id ASC`,
      [orgId, BUILTIN_DATASOURCE_CATALOG_SLUGS as readonly string[]],
    );

    let registered = 0;
    let deregistered = 0;
    for (const row of rows) {
      let stage: "parse" | "decrypt" | "bridge" = "parse";
      try {
        if (row.status === "archived") {
          stage = "bridge";
          // Deregister is config-free — evict the live pool for this
          // (workspace, install_id) so an archived datasource fails closed
          // on the next query instead of at boot/TTL.
          if (unregisterDatasourceInstall(row.workspace_id, row.install_id)) {
            deregistered++;
          }
          continue;
        }
        const schema = parseConfigSchema(row.config_schema);
        stage = "decrypt";
        const decryptedConfig = decryptSecretFields(row.config ?? {}, schema);
        stage = "bridge";
        const didRegister = await registerDatasourceInstall(
          {
            workspaceId: row.workspace_id,
            catalogId: "",
            installId: row.install_id,
            pillar: "datasource",
            catalogSlug: row.catalog_slug,
          },
          decryptedConfig,
        );
        if (didRegister) registered++;
      } catch (err) {
        log.warn(
          {
            stage,
            orgId,
            workspaceId: row.workspace_id,
            installId: row.install_id,
            catalogSlug: row.catalog_slug,
            status: row.status,
            err: err instanceof Error ? err.message : String(err),
          },
          "Failed to reconcile datasource install after publish — skipping (next boot will retry)",
        );
      }
    }

    if (registered > 0 || deregistered > 0) {
      log.info(
        { orgId, registered, deregistered },
        "Reconciled workspace datasources into the live ConnectionRegistry after publish",
      );
    }
    return { registered, deregistered };
  } catch (err) {
    const sqlstate = isPgError(err) ? err.code : undefined;
    if (sqlstate === "42P01") {
      log.warn(
        { orgId, sqlstate, err: err instanceof Error ? err.message : String(err) },
        "workspace_plugins / plugin_catalog not present — skipping post-publish datasource reconcile",
      );
      return { registered: 0, deregistered: 0 };
    }
    log.error(
      { orgId, sqlstate, err: err instanceof Error ? err.message : String(err) },
      "Failed to reconcile workspace datasources after publish — registry unchanged until next boot",
    );
    return { registered: 0, deregistered: 0 };
  }
}

/** Postgres SQLSTATE error shape. `pg` driver attaches `.code` to thrown errors. */
function isPgError(err: unknown): err is Error & { code: string } {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  );
}

// ── Learned pattern helpers ─────────────────────────────────────────

/**
 * Find a learned pattern by exact normalized SQL match, scoped to the given
 * org AND connection group.
 *
 * The dedup key is `(org_id, connection_group_id, normalised_sql)` (#3611) —
 * enforced application-side here (read-then-insert in `_analyzeAndPropose`),
 * NOT by a DB unique constraint. The SAME normalised SQL learned against a
 * different connection group (e.g. `us-prod` vs `eu-prod`) is a DISTINCT pattern
 * — different schema, different tables, potentially different dialect — so it
 * must not collide. A NULL group (the default flat `entities/` scope) is matched
 * with `IS NULL`, not `=`.
 *
 * Returns the pattern's id, confidence, repetition count, and status, or null
 * if not found. `status` lets the caller honour a prior admin reject: a rejected
 * row is matched (so dedup still suppresses a duplicate insert) but the proposer
 * must NOT bump it, otherwise repeat traffic silently erodes the reject (#3636).
 */
export async function findPatternBySQL(
  orgId: string | null | undefined,
  connectionGroupId: string | null | undefined,
  patternSql: string,
): Promise<{ id: string; confidence: number; repetitionCount: number; status: string } | null> {
  const params: unknown[] = [patternSql];
  let orgClause: string;
  if (orgId) {
    params.push(orgId);
    orgClause = `org_id = $${params.length}`;
  } else {
    orgClause = `org_id IS NULL`;
  }

  let groupClause: string;
  if (connectionGroupId) {
    params.push(connectionGroupId);
    groupClause = `connection_group_id = $${params.length}`;
  } else {
    groupClause = `connection_group_id IS NULL`;
  }

  const rows = await internalQuery<{ id: string; confidence: number; repetition_count: number; status: string }>(
    `SELECT id, confidence, repetition_count, status FROM learned_patterns WHERE pattern_sql = $1 AND ${orgClause} AND ${groupClause} LIMIT 1`,
    params,
  );

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    confidence: row.confidence,
    repetitionCount: row.repetition_count,
    status: row.status,
  };
}

/**
 * Insert a novel learned pattern, upserting on the DB-enforced identity.
 *
 * Fire-and-forget — errors are logged, never thrown. The proposer calls this
 * only on the novel path (findPatternBySQL missed), but two concurrent
 * proposers can both miss the read and both reach here. The partial unique
 * index `uq_learned_patterns_identity` (org_id, connection_group_id,
 * md5(pattern_sql)) WHERE type = 'query_pattern', NULLS NOT DISTINCT (migration
 * 0172, #4572) makes that race safe: exactly one INSERT wins and the loser's
 * `ON CONFLICT DO UPDATE` folds into the same increment `incrementPatternCount`
 * would have applied — so a concurrent duplicate becomes the repetition it
 * should have been, never a second row. The application read-then-insert dedup
 * is now a fast path; this ON CONFLICT is the guarantee.
 */
export function insertLearnedPattern(pattern: {
  orgId: string | null | undefined;
  /**
   * Connection group the pattern was learned against (#3611). NULL/omitted =
   * the default (flat `entities/`) scope. Stored on every row so retrieval
   * (`getApprovedPatterns`) and dedup (`findPatternBySQL`) can keep one group's
   * patterns from leaking into another group's agent context.
   */
  connectionGroupId?: string | null | undefined;
  patternSql: string;
  description: string;
  sourceEntity: string;
  sourceQueries: string[];
  proposedBy: string;
  /**
   * Wall-clock execution time (ms) of the first observed query for this pattern
   * (#3635, PRD #3617 B-1). Seeds `avg_duration_ms` and `last_seen_at`. Omitted
   * /`undefined`/`null` leaves both NULL — the "not yet observed" state — so a
   * caller without a measurement doesn't fabricate a zero latency.
   */
  durationMs?: number | null | undefined;
}): void {
  // Validate the first observation: only a finite, non-negative measurement
  // counts; absent/invalid leaves the latency columns NULL ("not yet observed")
  // rather than fabricating a zero.
  const seedDuration =
    typeof pattern.durationMs === "number" && Number.isFinite(pattern.durationMs) && pattern.durationMs >= 0
      ? pattern.durationMs
      : null;
  // Seed `avg_duration_ms` from the single rolling-mean definition (#3723): a
  // first observation is `foldRollingMean(null, 0, sample)`, which is the sample
  // itself (or null when unmeasured). Keeping the seed here means the INSERT and
  // the UPDATE fold can never derive the average from divergent formulas.
  const avgDuration = foldRollingMean(null, 0, seedDuration);
  // `avgDuration` is null iff `seedDuration` is null, so the `$8 IS NULL` guard
  // below still stamps `last_seen_at` exactly when there is a real measurement.
  // On a lost insert race, DO UPDATE must produce the SAME row mutation
  // `incrementPatternCount` applies on the fast path: +1 repetition, +0.1
  // confidence (capped), the rolling-mean latency fold, source-fingerprint
  // append (capped at 100), and `updated_at`. `EXCLUDED.avg_duration_ms` is the
  // would-be-inserted seed = `foldRollingMean(null, 0, sample)` = the raw sample
  // (or NULL), so it feeds the fold as the observation exactly as the UPDATE
  // path's `$LAT` does — keep this CASE in lockstep with `incrementPatternCount`
  // and `foldRollingMean` (#3723); `db/__tests__/rolling-mean-twin-pg.test.ts`
  // (#4576) pins this ON CONFLICT fold EQUAL to `foldRollingMean` so a divergent
  // edit fails CI. The `WHERE ... status <> 'rejected'` mirrors
  // the fast path's reject guard (#3636): a race against an admin-rejected row
  // leaves it frozen (conflict handled, zero rows updated) rather than
  // resurrecting it.
  internalExecute(
    `INSERT INTO learned_patterns (org_id, pattern_sql, description, source_entity, source_queries, confidence, repetition_count, status, proposed_by, connection_group_id, avg_duration_ms, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, 0.1, 1, 'pending', $6, $7, $8, CASE WHEN $8::double precision IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (org_id, connection_group_id, md5(pattern_sql)) WHERE type = 'query_pattern'
     DO UPDATE SET
       repetition_count = learned_patterns.repetition_count + 1,
       confidence = LEAST(1.0, learned_patterns.confidence + 0.1),
       avg_duration_ms = CASE
         WHEN EXCLUDED.avg_duration_ms IS NULL THEN learned_patterns.avg_duration_ms
         WHEN learned_patterns.avg_duration_ms IS NULL THEN EXCLUDED.avg_duration_ms
         ELSE (learned_patterns.avg_duration_ms * learned_patterns.repetition_count + EXCLUDED.avg_duration_ms) / (learned_patterns.repetition_count + 1)
       END,
       last_seen_at = CASE WHEN EXCLUDED.avg_duration_ms IS NULL THEN learned_patterns.last_seen_at ELSE now() END,
       source_queries = CASE
         WHEN learned_patterns.source_queries IS NULL THEN EXCLUDED.source_queries
         WHEN jsonb_array_length(learned_patterns.source_queries) >= 100 THEN learned_patterns.source_queries
         ELSE learned_patterns.source_queries || EXCLUDED.source_queries
       END,
       updated_at = now()
     WHERE learned_patterns.status <> 'rejected'`,
    [
      pattern.orgId ?? null,
      pattern.patternSql,
      pattern.description,
      pattern.sourceEntity,
      JSON.stringify(pattern.sourceQueries),
      pattern.proposedBy,
      pattern.connectionGroupId ?? null,
      avgDuration,
    ],
  );
}

/**
 * Lazily resolve `getSetting` from the settings module.
 *
 * settings.ts statically imports db/internal.ts (hasInternalDB /
 * internalQuery), so a static import here would create a module cycle —
 * same lazy-require pattern settings.ts itself uses for config/logger.
 */
function requireGetSetting(): (key: string, orgId?: string) => string | undefined {
  // oxlint-disable-next-line @typescript-eslint/no-require-imports -- lazy import avoids circular dependency (settings.ts imports db/internal.ts)
  const { getSetting } = require("@atlas/api/lib/settings") as {
    getSetting: (key: string, orgId?: string) => string | undefined;
  };
  return getSetting;
}

/**
 * Lazily resolve `isSaasModeForGuard` from the settings module — same
 * circular-import avoidance as `requireGetSetting` (settings.ts statically
 * imports db/internal.ts).
 *
 * `isSaasModeForGuard()` is the guard-oriented, fail-CLOSED SaaS probe:
 * `saas` → true, `errored` → true (assume SaaS), `self-hosted`/`unloaded`
 * → false. The amendment read/review functions below (#4487) use it to
 * drop the `OR org_id IS NULL` arm on SaaS so a NULL-org ("global scope")
 * row can never surface in — or be reviewed by — any tenant workspace.
 * Fail-closed is the secure direction here: if config resolution is
 * uncertain, we withhold the global rows rather than leak them.
 */
function requireIsSaasModeForGuard(): () => boolean {
  // oxlint-disable-next-line @typescript-eslint/no-require-imports -- lazy import avoids circular dependency (settings.ts imports db/internal.ts)
  const { isSaasModeForGuard } = require("@atlas/api/lib/settings") as {
    isSaasModeForGuard: () => boolean;
  };
  return isSaasModeForGuard;
}

/**
 * Parse the auto-approve threshold. Returns a value > 1 (disabled) if not
 * set or invalid. Single source of truth for the threshold logic.
 *
 * Workspace-scoped (#3392): resolved via getSetting(key, orgId) so a
 * per-workspace DB override written from the admin settings page wins
 * over the platform override / env var / default.
 */
export function getAutoApproveThreshold(orgId?: string): number {
  const getSetting = requireGetSetting();
  const raw = getSetting("ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD", orgId);
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
  "update_description", "update_dimension", "add_glossary_term", "update_glossary_term",
  "add_virtual_dimension",
]);

/**
 * Parse the comma-separated list of amendment types eligible for auto-approval.
 * Defaults to `update_description,add_dimension` when `ATLAS_EXPERT_AUTO_APPROVE_TYPES` is not set.
 * Unrecognized type names are logged and ignored.
 *
 * Workspace-scoped (#3392): resolved via getSetting(key, orgId) — see
 * getAutoApproveThreshold.
 */
export function getAutoApproveTypes(orgId?: string): Set<string> {
  const getSetting = requireGetSetting();
  const raw = getSetting("ATLAS_EXPERT_AUTO_APPROVE_TYPES", orgId) ?? DEFAULT_AUTO_APPROVE_TYPES;
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
 * Outcome of an amendment insert (#4507). A discriminated union so callers
 * handle all three terminal states explicitly:
 *   - `inserted`       — a new row was queued `pending`. `autoApprove` reports
 *                        auto-approve ELIGIBILITY (#4506): the decide seam
 *                        (`lib/semantic/expert/decide.ts`) is the ONLY writer
 *                        of `approved`, so the caller routes eligible rows
 *                        through `decideAmendment` instead of trusting an
 *                        insert-time stamp.
 *   - `already_pending`— an identical change is already pending review; the
 *                        insert converged on that row instead of duplicating.
 *   - `rejected`       — the identity was previously rejected by an admin;
 *                        rejection memory is permanent, so the insert is
 *                        refused. `id` is the existing rejected row.
 */
export type InsertSemanticAmendmentResult =
  | { outcome: "inserted"; id: string; autoApprove: boolean }
  | { outcome: "already_pending"; id: string }
  | { outcome: "rejected"; id: string };

/**
 * Find an existing rejected-or-pending amendment sharing `identityKey` within
 * the same org (#4507). Rejected wins over pending: a rejected identity must
 * never be re-queued even if a stale pending duplicate also exists. Scoped to
 * the amendment's own org (`IS NOT DISTINCT FROM` matches the NULL/self-hosted
 * scope), so one workspace's review decision never governs another's. Matching
 * is by reconstructed identity (`amendmentIdentityFromRow`), not by
 * `pattern_sql` equality, so rows written before the identity storage key
 * (older `amendment:<entity>:<ts>` keys) are still caught.
 */
async function findConflictingAmendment(
  orgId: string | null,
  sourceEntity: string,
  identityKey: string,
): Promise<{ outcome: "rejected" | "already_pending"; id: string } | null> {
  const rows = await internalQuery<{
    id: string;
    status: string;
    connection_group_id: string | null;
    amendment_payload: string | Record<string, unknown> | null;
  }>(
    `SELECT id, status, connection_group_id, amendment_payload
       FROM learned_patterns
      WHERE type = 'semantic_amendment'
        AND status IN ('rejected', 'pending')
        AND source_entity = $1
        AND org_id IS NOT DISTINCT FROM $2`,
    [sourceEntity, orgId],
  );

  let pendingId: string | null = null;
  for (const row of rows) {
    const key = amendmentIdentityFromRow({
      sourceEntity,
      connectionGroupId: row.connection_group_id,
      amendmentPayload: row.amendment_payload,
    });
    if (key === null) {
      // A stored rejected/pending row whose payload can't be reconstructed to
      // an identity stops being enforced — surface it so an operator can spot
      // a rejection that has silently gone dark (should never happen: the
      // writer always stamps `amendmentType`).
      log.warn(
        { existingId: row.id, status: row.status, sourceEntity },
        "learned_patterns amendment row has an unreconstructable identity — not enforced by the rejection/dedup guard",
      );
      continue;
    }
    if (key !== identityKey) continue;
    if (row.status === "rejected") return { outcome: "rejected", id: row.id };
    if (row.status === "pending" && pendingId === null) pendingId = row.id;
  }
  return pendingId ? { outcome: "already_pending", id: pendingId } : null;
}

/**
 * Insert a semantic amendment proposal. Every row is inserted `pending` — the
 * decide seam is the only writer of `approved` (#4506); eligibility is
 * reported via `autoApprove` on the `inserted` outcome.
 * Unlike insertLearnedPattern (fire-and-forget), this awaits the result.
 *
 * Insert-enforced rejection memory + pending dedup (#4507): before queuing, the
 * amendment's canonical group-scoped identity is checked against the org's
 * existing rejected/pending rows. A rejected identity refuses the insert
 * (permanent — no time window); an identical pending identity converges on the
 * existing row. The identity is also the row's storage key (`pattern_sql`),
 * replacing the timestamp-uniquified key that made every re-proposal a
 * duplicate. This is the single choke point every path (chat tool, scheduler,
 * CLI) shares, so the guard holds on all three by construction.
 */
export async function insertSemanticAmendment(amendment: {
  orgId: string | null | undefined;
  description: string;
  sourceEntity: string;
  confidence: number;
  amendmentPayload: Record<string, unknown>;
  /**
   * Connection group the amendment targets (ADR-0012, #3284). NULL = the
   * default (flat `entities/`) group. Persisted so the admin approve paths,
   * which rebuild the proposal from the stored row (the group is not
   * derivable from `source_entity`), can recover the group and apply the
   * amendment against the correct scope (no 409, no default-scope
   * corruption). Required so the invariant is compile-enforced, not
   * doc-enforced: the scheduler and the CLI `improve` command pass the
   * finding's group (the CLI's flat-root findings map to NULL), and the
   * interactive `proposeAmendment` tool passes the `applyGroupId` its
   * baseline was resolved from via `resolveAmendmentBaseline` (#4488, #4498)
   * — so human-reviewed approves resolve the same scoped row the
   * propose-time diff was computed against, rather than depending on the
   * unscoped fallback (which remains only for stale group labels).
   */
  connectionGroupId: string | null;
}): Promise<InsertSemanticAmendmentResult> {
  // One-workspace-owner invariant (#4510): on SaaS an Amendment MUST be owned by
  // exactly one workspace. A NULL-owner ("global scope") row is a cross-tenant
  // leak vector — it would surface in, or be reviewable from, another workspace
  // (mirror of the reader guard in `amendmentOrgScope` / #4487). Refuse it at
  // this single insert choke point — the one path every caller (chat tool,
  // scheduler, CLI) shares — so no code path can mint a NULL-owner row anew on
  // SaaS. The SaaS-capable autonomous scheduler (#4516) is org-safe by
  // construction because of this guard: it stamps a real orgId per workspace,
  // and this invariant fails loud if a stamping regression ever passes NULL.
  // On self-hosted the single workspace
  // IS the whole deployment, so a NULL owner is that one
  // workspace's legacy global scope — tolerated (the CLI and scheduler
  // single-org paths still write it). Fail LOUD, never a silent global insert.
  if (!amendment.orgId && requireIsSaasModeForGuard()()) {
    throw new Error(
      "insertSemanticAmendment: a semantic amendment requires a workspace owner on SaaS " +
        "(org_id must be non-null). Refusing to queue a NULL-owner / global-scope amendment.",
    );
  }

  // #3392 — thread the amendment's org through so a per-workspace
  // auto-approve override (admin settings page) governs its own proposals.
  // null orgId (self-hosted / global scope) resolves at the platform tier.
  const settingsOrgId = amendment.orgId ?? undefined;
  const threshold = getAutoApproveThreshold(settingsOrgId);
  const allowedTypes = getAutoApproveTypes(settingsOrgId);
  const rawType = amendment.amendmentPayload.amendmentType;
  const amendmentType = typeof rawType === "string" ? rawType : undefined;

  if (amendmentType === undefined) {
    log.warn(
      { entity: amendment.sourceEntity, payloadKeys: Object.keys(amendment.amendmentPayload) },
      "amendmentPayload.amendmentType is missing or not a string — amendment will not be eligible for auto-approval",
    );
  }

  // Canonical group-scoped identity (#4507): (group, entity, type, target).
  // Drives the rejection guard + pending dedup below and becomes the row's
  // storage key. A malformed payload (no amendmentType) yields no identity —
  // fall back to a stable per-entity key so the NOT NULL storage slot is
  // filled without reintroducing timestamp uniquification.
  const identityRow: AmendmentIdentityRow = {
    sourceEntity: amendment.sourceEntity,
    connectionGroupId: amendment.connectionGroupId,
    amendmentPayload: amendment.amendmentPayload,
  };
  const identityKey =
    amendmentIdentityFromRow(identityRow) ??
    amendmentIdentityKey(amendment.connectionGroupId, amendment.sourceEntity, "unknown");

  // Insert-enforced rejection memory + pending dedup. A rejected identity is
  // refused permanently; an identical pending identity converges on its row.
  const conflict = await findConflictingAmendment(
    amendment.orgId ?? null,
    amendment.sourceEntity,
    identityKey,
  );
  if (conflict) {
    log.debug(
      { entity: amendment.sourceEntity, amendmentType, outcome: conflict.outcome, existingId: conflict.id },
      conflict.outcome === "rejected"
        ? "Amendment refused — identity previously rejected (permanent rejection memory)"
        : "Amendment converged on existing pending row — no duplicate queued",
    );
    return conflict;
  }

  const meetsThreshold = amendment.confidence >= threshold;
  const typeEligible = amendmentType !== undefined && allowedTypes.has(amendmentType);
  const autoApprove = meetsThreshold && typeEligible;

  if (meetsThreshold && !typeEligible) {
    log.debug(
      { entity: amendment.sourceEntity, amendmentType, confidence: amendment.confidence },
      "Amendment meets confidence threshold but type is not in auto-approve list — queuing for review",
    );
  }

  const rows = await internalQuery<{ id: string }>(
    `INSERT INTO learned_patterns
       (org_id, pattern_sql, description, source_entity, confidence,
        repetition_count, status, proposed_by, type, amendment_payload,
        connection_group_id)
     VALUES ($1, $2, $3, $4, $5, 1, 'pending', 'expert-agent', 'semantic_amendment', $6, $7)
     RETURNING id`,
    [
      amendment.orgId ?? null,
      identityKey,
      amendment.description,
      amendment.sourceEntity,
      amendment.confidence,
      JSON.stringify(amendment.amendmentPayload),
      amendment.connectionGroupId,
    ],
  );

  if (rows.length === 0) {
    throw new Error(
      `insertSemanticAmendment: INSERT returned no rows for entity "${amendment.sourceEntity}". The row may not have been created.`,
    );
  }

  return { outcome: "inserted", id: rows[0].id, autoApprove };
}

// ---------------------------------------------------------------------------
// Decide-seam claim helpers (#4506)
//
// The decide seam (`lib/semantic/expert/decide.ts`) owns the semantic
// Amendment `pending → approved | rejected` transition with claim-then-apply
// ordering. These four helpers are its ONLY DB surface — no other code path
// may write `status = 'approved'` on a `semantic_amendment` row:
//
//   claimPendingAmendment      pending → applying   (atomic conditional claim)
//   stampClaimedAmendmentApproved  applying → approved  (only after apply OK)
//   releaseClaimedAmendment    applying → pending   (compensation, w/ reason)
//   rejectPendingAmendment     pending → rejected   (atomic, no apply)
//
// `applying` is a transient claim state, not a wire status: the review-queue
// reads treat a claim older than AMENDMENT_CLAIM_STALE_MINUTES as abandoned
// (process died mid-apply) so the row resurfaces and the claim can be retaken.
//
// Ownership is enforced by the claim token (`claimed_at` = the reviewed_at
// the claim stamped): stamp/release match only THIS claim, so a decision that
// outlives the stale window observes "claim lost" instead of overwriting a
// takeover. The one deliberately qualified guarantee: reject/claim treat a
// STALE claim as claimable (a crashed process must not strand rows), so an
// apply still alive past the window can land YAML after a takeover decided
// the row — bounded to >stale-window applies, surfaced via decide.ts logs,
// idempotent and convergent on the next approve.
// ---------------------------------------------------------------------------

/**
 * Minutes after which an `applying` claim is considered abandoned. Applies run
 * in seconds; a claim this old means the process died between claim and
 * stamp/release. Stale claims resurface in the pending queue and are
 * re-claimable, so a crash can never strand a row invisibly.
 */
export const AMENDMENT_CLAIM_STALE_MINUTES = 10;

/** Shared WHERE arm: a row is claimable when pending or holding a stale claim. */
const CLAIMABLE_STATUS_SQL = `(status = 'pending' OR (status = 'applying' AND updated_at < now() - interval '${AMENDMENT_CLAIM_STALE_MINUTES} minutes'))`;

/** Row returned by claimPendingAmendment on a successful claim. */
export type ClaimedAmendmentRow = Record<string, unknown> & {
  id: string;
  source_entity: string;
  connection_group_id: string | null;
  amendment_payload: Record<string, unknown> | null;
  /**
   * Claim token: the `reviewed_at` this claim stamped, as text. Stamp/release
   * condition on it so an apply that outlived the stale window can never
   * overwrite a takeover's live claim — ownership is enforced by the row, not
   * by timing (#4506).
   */
  claimed_at: string;
};

/**
 * Atomically claim a pending semantic amendment for an approve-apply (#4506).
 * Conditional update `pending → applying`: exactly one concurrent caller wins;
 * losers get `null` and must report the row as already under review. Also
 * retakes claims stale past {@link AMENDMENT_CLAIM_STALE_MINUTES} (crashed
 * process). Clears `last_apply_error` so a retried approve starts clean.
 * Returns the claim token (`claimed_at`) that stamp/release require.
 *
 * SaaS scoping mirrors the pending reads (#4487): NULL-org rows are
 * unclaimable from any workspace, and the org-less path is refused outright.
 *
 * @throws {Error} If the internal database is not configured.
 */
export async function claimPendingAmendment(
  id: string,
  orgId: string | null,
  claimedBy: string,
): Promise<ClaimedAmendmentRow | null> {
  if (!hasInternalDB()) {
    throw new Error("Internal database is not configured. Amendment review requires DATABASE_URL.");
  }

  // Tenant scoping lives in the shared helper (#4487, #4510) — the org-less
  // SaaS path withholds (null → "not pending" at the seam).
  const scope = amendmentOrgScope(orgId, "$3");
  if (scope.withhold) return null;

  const rows = await internalQuery<ClaimedAmendmentRow>(
    `UPDATE learned_patterns
       SET status = 'applying', reviewed_by = $1, reviewed_at = now(),
           updated_at = now(), last_apply_error = NULL
     WHERE id = $2 AND type = 'semantic_amendment' AND ${CLAIMABLE_STATUS_SQL}
     AND ${scope.clause}
     RETURNING id, source_entity, connection_group_id, amendment_payload, reviewed_at::text AS claimed_at`,
    orgId ? [claimedBy, id, orgId] : [claimedBy, id],
  );

  return rows[0] ?? null;
}

/**
 * Stamp a claimed amendment `approved` — called by the decide seam ONLY after
 * a successful apply + version snapshot (#4506). Conditional on THIS claim
 * (`status = 'applying' AND reviewed_at = claimedAt`), so an apply that
 * outlived the stale window can never stamp over a takeover's live claim.
 * Returns false when the claim is no longer held by this claimant.
 */
export async function stampClaimedAmendmentApproved(
  id: string,
  claimedAt: string,
): Promise<boolean> {
  if (!hasInternalDB()) return false;

  const rows = await internalQuery<{ id: string }>(
    `UPDATE learned_patterns
       SET status = 'approved', last_apply_error = NULL,
           reviewed_at = now(), updated_at = now()
     WHERE id = $1 AND type = 'semantic_amendment' AND status = 'applying'
     AND reviewed_at = $2::timestamptz
     RETURNING id`,
    [id, claimedAt],
  );

  return rows.length > 0;
}

/**
 * Compensation: return a claimed amendment to `pending` after its apply failed
 * (#4506), recording the failure in `last_apply_error` so the review queue
 * shows WHY the row bounced. Conditional on THIS claim (see
 * {@link stampClaimedAmendmentApproved}) and clears the reviewer fields the
 * claim stamped. Returns false when the claim is no longer held by this
 * claimant (stale-claim takeover).
 */
export async function releaseClaimedAmendment(
  id: string,
  claimedAt: string,
  // A failure reason to surface in the review queue, or `null` to clear
  // `last_apply_error` — the #4511 stale-baseline path releases with `null`
  // because a changed baseline is a continuation of review, not an apply
  // failure, so the queue must not show a scary "last approval failed" reason.
  reason: string | null,
): Promise<boolean> {
  if (!hasInternalDB()) return false;

  const rows = await internalQuery<{ id: string }>(
    `UPDATE learned_patterns
       SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL,
           last_apply_error = $3, updated_at = now()
     WHERE id = $1 AND type = 'semantic_amendment' AND status = 'applying'
     AND reviewed_at = $2::timestamptz
     RETURNING id`,
    [id, claimedAt, reason === null ? null : reason.slice(0, 2000)],
  );

  return rows.length > 0;
}

/**
 * Atomically reject a pending semantic amendment (#4506). Conditional on
 * `pending` (or a STALE claim), so a reject cannot stamp an applied change as
 * rejected: once an approve has claimed (within the stale window) or stamped
 * the row, the reject matches zero rows and the caller reports "already
 * reviewed". (Qualified for >stale-window applies — see the block comment
 * above.) Rejection never touches the semantic layer, so no claim state is
 * needed.
 *
 * SaaS scoping mirrors the pending reads (#4487).
 *
 * @throws {Error} If the internal database is not configured.
 */
export async function rejectPendingAmendment(
  id: string,
  orgId: string | null,
  rejectedBy: string,
): Promise<boolean> {
  if (!hasInternalDB()) {
    throw new Error("Internal database is not configured. Amendment review requires DATABASE_URL.");
  }

  // Tenant scoping lives in the shared helper (#4487, #4510) — the org-less
  // SaaS path withholds (false → "not pending" at the seam).
  const scope = amendmentOrgScope(orgId, "$3");
  if (scope.withhold) return false;

  const rows = await internalQuery<{ id: string }>(
    `UPDATE learned_patterns
       SET status = 'rejected', reviewed_by = $1, reviewed_at = now(), updated_at = now()
     WHERE id = $2 AND type = 'semantic_amendment' AND ${CLAIMABLE_STATUS_SQL}
     AND ${scope.clause}
     RETURNING id`,
    orgId ? [rejectedBy, id, orgId] : [rejectedBy, id],
  );

  return rows.length > 0;
}

/**
 * Result of {@link amendmentOrgScope}: either the reader withholds (returns its
 * empty value without querying) or it has a ready-to-splice `org_id` predicate.
 */
export type AmendmentOrgScope = { withhold: true } | { withhold: false; clause: string };

/**
 * Shared org-scope filter for the semantic-amendment readers — the ONE home for
 * the SaaS-vs-self-hosted `org_id` conditional (#4487, #4510). Every amendment
 * reader (count, list, and the decide seam's claim/reject, #4506) MUST derive
 * its predicate from here rather than inlining the ternary;
 * `semantic-amendment-saas-scoping.test.ts` pins the reader set and fails if a
 * new reader bypasses this helper.
 *
 *   - SaaS + workspace        → `org_id = <ph>` — a NULL-owner ("global scope")
 *                               row never surfaces in a tenant workspace (the
 *                               #4487 leak fix).
 *   - self-hosted + workspace → `(org_id = <ph> OR org_id IS NULL)` — legacy
 *                               NULL-owner rows stay readable as the single
 *                               workspace's global scope (never produced anew —
 *                               see the invariant in `insertSemanticAmendment`).
 *   - org-less, self-hosted   → `org_id IS NULL` (the global-admin view).
 *   - org-less, SaaS          → `{ withhold: true }`: there is no global tenant,
 *                               so the caller returns its empty value without
 *                               touching the DB.
 *
 * @param orgId       the workspace owner, or null for the org-less path.
 * @param placeholder the positional parameter that binds `orgId` (e.g. "$1").
 */
export function amendmentOrgScope(
  orgId: string | null,
  // A positional bind marker, not free text — the raw splice below is only safe
  // because the type forbids anything but `$<n>` (both call sites pass literals).
  placeholder: `$${number}`,
): AmendmentOrgScope {
  const saas = requireIsSaasModeForGuard()();
  if (!orgId) {
    return saas ? { withhold: true } : { withhold: false, clause: "org_id IS NULL" };
  }
  return {
    withhold: false,
    clause: saas ? `org_id = ${placeholder}` : `(org_id = ${placeholder} OR org_id IS NULL)`,
  };
}

/**
 * Count pending semantic amendment proposals for an org.
 * Returns 0 when no internal DB is available.
 */
export async function getPendingAmendmentCount(orgId: string | null): Promise<number> {
  if (!hasInternalDB()) return 0;

  const scope = amendmentOrgScope(orgId, "$1");
  if (scope.withhold) return 0;

  const rows = await internalQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM learned_patterns
       WHERE type = 'semantic_amendment' AND ${CLAIMABLE_STATUS_SQL}
       AND ${scope.clause}`,
    orgId ? [orgId] : [],
  );

  return parseInt(rows[0]?.count ?? "0", 10);
}

/** Row shape returned by getPendingAmendments. */
export type PendingAmendmentRow = Record<string, unknown> & {
  id: string;
  source_entity: string;
  /**
   * Connection group the amendment targets (ADR-0012, #3284). NULL = the
   * default (flat `entities/`) group. The admin approve path threads this into
   * `applyAmendmentToEntity` so the amendment hits the correct group's row.
   */
  connection_group_id: string | null;
  description: string | null;
  confidence: number;
  amendment_payload: Record<string, unknown> | null;
  /**
   * Reason the last approve-apply failed (#4506) — set when the decide seam
   * compensated the row back to pending, cleared on the next claim. Surfaced
   * in the review queue so a bounced approval is never a silent re-listing.
   */
  last_apply_error: string | null;
  created_at: string;
};

/**
 * List pending semantic amendment proposals for an org, newest first.
 * Includes rows holding a stale `applying` claim (crashed mid-apply, #4506)
 * so no amendment can be stranded invisibly. Returns [] when no internal DB
 * is available.
 */
export async function getPendingAmendments(orgId: string | null): Promise<PendingAmendmentRow[]> {
  if (!hasInternalDB()) return [];

  const scope = amendmentOrgScope(orgId, "$1");
  if (scope.withhold) return [];

  return internalQuery<PendingAmendmentRow>(
    `SELECT id, source_entity, connection_group_id, description, confidence, amendment_payload, last_apply_error, created_at::text
       FROM learned_patterns
       WHERE type = 'semantic_amendment' AND ${CLAIMABLE_STATUS_SQL}
       AND ${scope.clause}
       ORDER BY created_at DESC`,
    orgId ? [orgId] : [],
  );
}

/** Row shape returned by {@link getRecentlyDecidedAmendments}. */
export type DecidedAmendmentRow = Record<string, unknown> & {
  id: string;
  source_entity: string;
  connection_group_id: string | null;
  amendment_payload: Record<string, unknown> | null;
  status: "approved" | "rejected";
  reviewed_at: string;
};

/**
 * List the most-recently DECIDED semantic amendments (approved or rejected) for
 * an org, newest-decision first — the briefing's "recent panel decisions" feed
 * (#4514). Lets the expert agent learn what the admin decided in the review
 * panel mid-conversation without a synthetic transcript message.
 *
 * Org scope routes through {@link amendmentOrgScope} like the pending readers,
 * so a NULL-owner ("global scope") row never surfaces in a tenant workspace on
 * SaaS. Filters on `status IN ('approved','rejected')` — deliberately NOT the
 * claimable-pending arm — so the reader-enumeration guard
 * (`semantic-amendment-saas-scoping.test.ts`) does not (and should not) pin it
 * with the pending readers; it is a decided-history read, not a queue read.
 * Returns [] when no internal DB is available.
 */
export async function getRecentlyDecidedAmendments(
  orgId: string | null,
  limit = 10,
): Promise<DecidedAmendmentRow[]> {
  if (!hasInternalDB()) return [];

  const scope = amendmentOrgScope(orgId, "$1");
  if (scope.withhold) return [];

  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;

  return internalQuery<DecidedAmendmentRow>(
    `SELECT id, source_entity, connection_group_id, amendment_payload, status, reviewed_at::text
       FROM learned_patterns
       WHERE type = 'semantic_amendment'
       AND status IN ('approved', 'rejected')
       AND reviewed_at IS NOT NULL
       AND ${scope.clause}
       ORDER BY reviewed_at DESC
       LIMIT ${safeLimit}`,
    orgId ? [orgId] : [],
  );
}

/** Row shape returned by getRejectedAmendments. */
export type RejectedAmendmentRow = Record<string, unknown> & {
  id: string;
  source_entity: string;
  connection_group_id: string | null;
  description: string | null;
  confidence: number;
  amendment_payload: Record<string, unknown> | null;
  /** When the reject was recorded (`reviewed_at`), as text. */
  reviewed_at: string | null;
  /**
   * Who rejected it (`reviewed_by`). The web review is the only reject path
   * today (the scheduler / auto-approve machine actors only ever approve), so
   * in practice this is the `"admin"` sentinel that path records.
   */
  reviewed_by: string | null;
  created_at: string;
};

/**
 * List rejected semantic amendments for an org, most-recently-rejected first
 * (#4512). The Rejected view reads this to offer Reconsider — the one action
 * that lifts a rejection. Tenant-scoped through the shared `amendmentOrgScope`
 * helper exactly like the pending reads; returns [] when no internal DB is
 * available.
 */
export async function getRejectedAmendments(orgId: string | null): Promise<RejectedAmendmentRow[]> {
  if (!hasInternalDB()) return [];

  const scope = amendmentOrgScope(orgId, "$1");
  if (scope.withhold) return [];

  return internalQuery<RejectedAmendmentRow>(
    `SELECT id, source_entity, connection_group_id, description, confidence, amendment_payload,
            reviewed_by, reviewed_at::text AS reviewed_at, created_at::text
       FROM learned_patterns
       WHERE type = 'semantic_amendment' AND status = 'rejected'
       AND ${scope.clause}
       ORDER BY reviewed_at DESC NULLS LAST, created_at DESC`,
    orgId ? [orgId] : [],
  );
}

/**
 * Reconsider a rejected semantic amendment — the admin action that lifts a
 * rejection (#4512). One atomic conditional update `rejected → pending`: the
 * row re-enters the Pending queue (`CLAIMABLE_STATUS_SQL` matches `pending`)
 * AND leaves rejection memory in the same write, because rejection memory IS
 * the set of `status = 'rejected'` rows (`loadRejectedKeys` /
 * `findConflictingAmendment` both key on that status). The identity therefore
 * becomes proposable again — a fresh proposal of it converges on this now-
 * pending row instead of being refused. Reviewer fields + any stale
 * `last_apply_error` are cleared so the reconsidered row is indistinguishable
 * from a freshly-queued pending Amendment.
 *
 * Conditional on `status = 'rejected'`, so it can only ever lift a rejection:
 * a pending / applying / approved row matches zero rows and the caller reports
 * "not found". SaaS scoping mirrors the pending reads (#4487) via the shared
 * `amendmentOrgScope` helper — a NULL-owner row is unreconsiderable from a
 * tenant workspace, and the org-less SaaS path withholds.
 *
 * @throws {Error} If the internal database is not configured.
 */
export async function reconsiderRejectedAmendment(id: string, orgId: string | null): Promise<boolean> {
  if (!hasInternalDB()) {
    throw new Error("Internal database is not configured. Amendment reconsider requires DATABASE_URL.");
  }

  const scope = amendmentOrgScope(orgId, "$2");
  if (scope.withhold) return false;

  const rows = await internalQuery<{ id: string }>(
    `UPDATE learned_patterns
       SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL,
           last_apply_error = NULL, updated_at = now()
     WHERE id = $1 AND type = 'semantic_amendment' AND status = 'rejected'
     AND ${scope.clause}
     RETURNING id`,
    orgId ? [id, orgId] : [id],
  );

  return rows.length > 0;
}

/**
 * Increment repetition_count by 1 and increase confidence by 0.1 (capped at 1.0).
 * When sourceFingerprint is provided, appends it to source_queries (capped at 100 entries).
 *
 * Latency (#3635, PRD #3617 B-1): when a finite, non-negative `durationMs` is
 * supplied, folds it into `avg_duration_ms` as an incremental rolling mean and
 * advances `last_seen_at`. The new average weights the existing mean by the
 * *old* `repetition_count` — `(avg * n + d) / (n + 1)` — which converges to the
 * true mean across repetitions. Every SET clause's RHS reads the pre-UPDATE row,
 * so `repetition_count` here is the old `n` even though another clause bumps it.
 * A first-ever observation (`avg_duration_ms IS NULL`) seeds directly to `d`. A
 * missing/invalid measurement leaves both latency columns untouched.
 *
 * Never mutates a `rejected` row (`AND status <> 'rejected'`): the proposer
 * already skips rejected matches, but this is the durable backstop so no caller
 * can resurrect an admin-rejected pattern by bumping its confidence (#3636).
 *
 * Fire-and-forget — errors are logged, never thrown.
 */
export function incrementPatternCount(
  id: string,
  sourceFingerprint?: string,
  durationMs?: number | null,
): void {
  const observation =
    typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null;

  // Rolling-average + last_seen_at fragment, parameterized on the observation.
  // NULL observation → no-op on both columns (keeps the prior value).
  //
  // This path stays SQL-only: it has no pre-read of the old avg/count, so the
  // fold runs atomically inside the same UPDATE that bumps `repetition_count`
  // (every SET clause's RHS reads the pre-UPDATE row, so `repetition_count` here
  // is the old `n`). A pre-read-then-write would lose that atomicity. The CASE
  // therefore mirrors `foldRollingMean(oldAvg, oldCount, sample)` (#3723)
  // clause-for-clause — keep the two in lockstep:
  //   sample === null            → return oldAvg              (WHEN $LAT IS NULL)
  //   oldAvg === null            → return sample              (WHEN avg IS NULL)
  //   else (oldAvg*n + sample)/(n+1)                          (ELSE branch)
  // The real-Postgres `db/__tests__/rolling-mean-twin-pg.test.ts` (#4576) drives
  // repeated observations through this UPDATE and pins the stored
  // `avg_duration_ms` EQUAL to `foldRollingMean` over the same sequence, so a
  // divergent edit to either the CASE or the TS twin fails CI.
  const latencyAssignments = `
        avg_duration_ms = CASE
          WHEN $LAT::double precision IS NULL THEN avg_duration_ms
          WHEN avg_duration_ms IS NULL THEN $LAT::double precision
          ELSE (avg_duration_ms * repetition_count + $LAT::double precision) / (repetition_count + 1)
        END,
        last_seen_at = CASE WHEN $LAT::double precision IS NULL THEN last_seen_at ELSE now() END,`;

  if (sourceFingerprint) {
    const newEntry = JSON.stringify([sourceFingerprint]);
    internalExecute(
      `UPDATE learned_patterns SET
        repetition_count = repetition_count + 1,
        confidence = LEAST(1.0, confidence + 0.1),${latencyAssignments.replaceAll("$LAT", "$3")}
        source_queries = CASE
          WHEN source_queries IS NULL THEN $2::jsonb
          WHEN jsonb_array_length(source_queries) >= 100 THEN source_queries
          ELSE source_queries || $2::jsonb
        END,
        updated_at = now()
      WHERE id = $1 AND status <> 'rejected'`,
      [id, newEntry, observation],
    );
  } else {
    internalExecute(
      `UPDATE learned_patterns SET
        repetition_count = repetition_count + 1,
        confidence = LEAST(1.0, confidence + 0.1),${latencyAssignments.replaceAll("$LAT", "$2")}
        updated_at = now()
      WHERE id = $1 AND status <> 'rejected'`,
      [id, observation],
    );
  }
}

/** Row shape returned by getApprovedPatterns. */
export interface ApprovedPatternRow {
  id: string;
  org_id: string | null;
  /** Connection group the pattern was learned against (#3611). NULL = the
   *  default (flat `entities/`) scope. */
  connection_group_id: string | null;
  pattern_sql: string;
  description: string | null;
  source_entity: string | null;
  /** Confidence score between 0.0 and 1.0. */
  confidence: number;
  /** Rolling-mean wall-clock execution time (ms), or null until first observed
   *  (PRD #3617 B-0). Drives perf-weighted retrieval down-weighting (B-2). */
  avg_duration_ms: number | null;
  /** True when the nightly auto-promote job promoted this row (machine road);
   *  false for a human-approved pattern (#4571). Drives the eligible-set bypass:
   *  human-approved rows are eligible for injection regardless of confidence. */
  auto_promoted: boolean;
  /** Last-observed timestamp as `timestamptz::text` (space-separated, not strict
   *  ISO-8601; `Date.parse`-able), or null until first observed. The eligible-set
   *  saturation tiebreak among confidence ties (#4571). */
  last_seen_at: string | null;
  [key: string]: unknown;
}

/** Row shape for query_suggestions table. */
export interface QuerySuggestionRow {
  readonly id: string;
  readonly org_id: string | null;
  readonly description: string;
  readonly pattern_sql: string;
  readonly normalized_hash: string;
  readonly tables_involved: string; // JSONB string, parse to string[]
  readonly primary_table: string | null;
  readonly frequency: number;
  readonly clicked_count: number;
  readonly score: number;
  readonly approval_status: import("@useatlas/types").SuggestionApprovalStatus;
  readonly status: import("@useatlas/types").SuggestionStatus;
  readonly approved_by: string | null;
  readonly approved_at: string | null;
  readonly distinct_user_clicks: number;
  readonly last_seen_at: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly [key: string]: unknown;
}

/**
 * Fetch approved learned patterns for agent-context injection, scoped to an org
 * AND a connection group (#3611). Restricted to `type = 'query_pattern'` rows
 * (#4534) — `semantic_amendment` rows share this table and can reach
 * `status = 'approved'`, but their sentinel `pattern_sql` is not an executable
 * query and must never be injected as one.
 *
 * Org scoping is deploy-mode aware (#4487, #4534): on SaaS the `OR org_id IS
 * NULL` arm is dropped for a workspace — and an org-less read withholds entirely
 * (no global tenant) — so a NULL-org ("global scope") pattern can never surface
 * cross-tenant in an agent's system prompt; on self-hosted the arm stays,
 * keeping the single deployment's legacy global scope readable.
 *
 * Group scoping mirrors the self-hosted org rule: a pattern is in scope when its
 * `connection_group_id` matches the active group OR is NULL (the default flat
 * `entities/` scope). When `connectionGroupId` is null/omitted the active scope
 * IS the default group, so only `connection_group_id IS NULL` rows match — this
 * keeps `us-prod` patterns out of a `eu-prod` agent session and vice-versa.
 *
 * Applies NO confidence gate here (unlike a confidence-filtered fetch) — it
 * returns every approved query pattern for the scope, up to the safety cap.
 * Approval is an eligibility bypass, so a human-approved row must reach the
 * injection stage regardless of confidence; the gate applies to machine-promoted
 * rows and is enforced downstream by {@link selectEligiblePatterns}
 * (`getRelevantPatterns`). Ordered by the shared {@link ELIGIBLE_SET_ORDER_BY_SQL}
 * (human-approved first, then confidence DESC, then last-observed) and capped at
 * {@link ELIGIBLE_SET_SAFETY_CAP} — the ordering makes the cap keep every
 * human-approved row (up to the cap; see {@link ELIGIBLE_SET_SAFETY_CAP}) plus
 * the highest-confidence machine rows (#4571).
 */
export async function getApprovedPatterns(
  orgId: string | null,
  connectionGroupId?: string | null,
): Promise<ApprovedPatternRow[]> {
  if (!hasInternalDB()) return [];

  const params: unknown[] = [];

  // Org scope, deploy-mode aware (#4487, #4534). On SaaS a NULL-org ("global
  // scope") approved pattern must NEVER surface in a tenant's agent context:
  //   - workspace → `org_id = $N` only (the `OR org_id IS NULL` leak arm is
  //                 dropped, so a NULL-org row can't be injected cross-tenant);
  //   - org-less  → withhold entirely — there is no global tenant on SaaS, so
  //                 fail closed rather than return NULL-org rows to a no-tenant
  //                 read.
  // Both mirror `amendmentOrgScope`'s SaaS behavior. On self-hosted the single
  // workspace IS the whole deployment, so a NULL-org row is that deployment's
  // legacy global scope and stays readable in both cases. Inlined rather than
  // routed through `amendmentOrgScope` — that helper is the amendment readers'
  // and is pinned to that set by the #4510 reader-enumeration guard, and it emits
  // no group clause; this is a `query_pattern` reader with its own group scope.
  const saas = requireIsSaasModeForGuard()();
  let orgClause: string;
  if (orgId) {
    params.push(orgId);
    orgClause = saas
      ? `org_id = $${params.length}`
      : `(org_id = $${params.length} OR org_id IS NULL)`;
  } else if (saas) {
    return [];
  } else {
    orgClause = `org_id IS NULL`;
  }

  let groupClause: string;
  if (connectionGroupId) {
    params.push(connectionGroupId);
    groupClause = `(connection_group_id = $${params.length} OR connection_group_id IS NULL)`;
  } else {
    groupClause = `connection_group_id IS NULL`;
  }

  // `type = 'query_pattern'` is load-bearing (#4534): `semantic_amendment` rows
  // live in this same table and reach `status = 'approved'` on approval, but
  // their `pattern_sql` is a non-executable identity-key sentinel (see
  // `amendmentIdentityKey`), never a runnable query — injecting one as a query
  // pattern is garbage in the prompt. Mirrors the filter
  // `getPromoteDecayCandidates` already applies.
  const rows = await internalQuery<ApprovedPatternRow>(
    `SELECT id, org_id, connection_group_id, pattern_sql, description, source_entity, confidence, avg_duration_ms, auto_promoted, last_seen_at::text AS last_seen_at
     FROM learned_patterns
     WHERE status = 'approved' AND type = 'query_pattern' AND ${orgClause} AND ${groupClause}
     ORDER BY ${ELIGIBLE_SET_ORDER_BY_SQL}
     LIMIT ${ELIGIBLE_SET_SAFETY_CAP}`,
    params,
  );

  // Surface the PRD #4570 scaling-exit trigger: at exactly the cap the scope's
  // approved-pattern library has hit the eligible-set ceiling and rows may be
  // truncated at fetch — the actionable signal that full-text retrieval is due
  // (silent truncation would otherwise be invisible to an operator).
  if (rows.length === ELIGIBLE_SET_SAFETY_CAP) {
    log.warn(
      { orgId, connectionGroupId, cap: ELIGIBLE_SET_SAFETY_CAP },
      "Approved-pattern eligible set hit the safety cap — scope is at the eligible-set ceiling (PRD #4570 full-text-retrieval trigger)",
    );
  }

  return rows;
}

// ── Injection attribution (#4573) ─────────────────────────────────

/** One injected pattern to attribute for a single agent turn. */
export interface PatternInjectionRecord {
  /** The injected pattern's `learned_patterns.id`. */
  readonly patternId: string;
  /** Workspace scope, denormalized from the pattern (null = legacy global). */
  readonly orgId: string | null;
  /** Connection group the injecting session ran under (null = default flat). */
  readonly connectionGroupId: string | null;
  /** The conversation the turn belonged to, when known. */
  readonly conversationId: string | null;
  /** Request correlation id for the turn, when known. */
  readonly requestId: string | null;
}

/**
 * Record injection attribution for one agent turn: one row per injected pattern
 * (CONTEXT.md § Learned query patterns, "Injection" — every injection is
 * attributed). Prompt assembly (`resolveOrgKnowledgeSection`) calls this with
 * exactly the patterns it rendered into the turn, so attribution reflects what
 * entered the prompt, not what was fetched.
 *
 * Fire-and-forget via {@link internalExecute}: a write failure is logged (never
 * thrown) and the circuit breaker drops rows under sustained failure, so
 * attribution can never fail the agent turn (PRD #4570 acceptance). No-op when
 * the internal DB is absent (self-hosted without `DATABASE_URL`) or the batch is
 * empty. A single multi-row INSERT keeps it one round-trip regardless of turn
 * width.
 */
export function recordPatternInjections(records: readonly PatternInjectionRecord[]): void {
  if (records.length === 0 || !hasInternalDB()) return;

  const params: unknown[] = [];
  const valueRows = records.map((r) => {
    const base = params.length;
    params.push(r.patternId, r.orgId, r.connectionGroupId, r.conversationId, r.requestId);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
  });

  internalExecute(
    `INSERT INTO learned_pattern_injections
       (pattern_id, org_id, connection_group_id, conversation_id, request_id)
     VALUES ${valueRows.join(", ")}`,
    params,
  );
}

// ── Auto-promote / decay (PRD #3617 B-2, #3636) ─────────────────────

/** `reviewed_by` stamp the nightly job writes on an auto-promotion, so the
 *  audit trail and admin UI can tell a machine approval from a human one even
 *  before reading the `auto_promoted` flag. */
export const AUTO_PROMOTE_REVIEWER = "atlas-auto-promote";

/** Projection of `learned_patterns` the promote/decay decision needs. */
export interface PromoteDecayCandidateRow {
  readonly id: string;
  readonly org_id: string | null;
  readonly type: string;
  readonly status: string;
  readonly confidence: number;
  readonly repetition_count: number;
  readonly avg_duration_ms: number | null;
  readonly last_seen_at: string | null;
  readonly auto_promoted: boolean;
  readonly [key: string]: unknown;
}

/**
 * Fetch the rows the promote/decay job evaluates for ONE workspace: that
 * workspace's pending query patterns (promotion candidates) and the approved
 * query patterns the job itself promoted (decay candidates). `semantic_amendment`
 * rows are excluded — they keep human review. The apply step
 * (`promoteLearnedPatterns` / `demoteLearnedPatterns`) still keys updates by `id`
 * and never writes `org_id` / `connection_group_id`, so it can never move a
 * pattern across tenants (#3610/#3611); each row's own `org_id` (for cache
 * invalidation) rides along on the projection and the apply step's `RETURNING`.
 *
 * Workspace scope (#4582): the SaaS-first tick iterates opted-in workspaces and
 * evaluates each in isolation, so `orgId` scopes the scan — `null` is the
 * self-hosted single implicit workspace (its patterns carry a NULL org, matching
 * the eligible-set retrieval's null-org scoping). Isolating the scan per
 * workspace is what makes the freshest-first cap below fair: a single global
 * scan would let one noisy tenant's churn crowd a quiet tenant's rows out past
 * the cap.
 *
 * Capped at `limit` rows so a runaway table can't make one tick unbounded. The
 * order is `updated_at DESC` — most-recently-touched first (a re-run bumps
 * `updated_at` via `incrementPatternCount`, the dominant writer for pending
 * rows) — so when the cap bites it keeps the fresh patterns worth promoting
 * rather than starving them behind stale rows (#4582); the scheduler logs when
 * the cap is hit.
 */
export async function getPromoteDecayCandidates(
  orgId: string | null,
  limit = 10000,
): Promise<PromoteDecayCandidateRow[]> {
  if (!hasInternalDB()) return [];
  // `$1` is always the limit (referenced by LIMIT below); the org filter, when
  // present, is `$2`. A null org narrows to the single-tenant NULL-org rows.
  const params: Array<string | number> = [limit];
  let orgClause: string;
  if (orgId === null) {
    orgClause = "org_id IS NULL";
  } else {
    params.push(orgId);
    orgClause = `org_id = $${params.length}`;
  }
  // Seen-once tier (#4581): a `repetition_count = 1` pending row is a single
  // capture, not evidence — it is excluded from the promotion candidate set until
  // it repeats, so the auto-promoter never amplifies a shape seen exactly once
  // (regardless of a low `minRepetitions` threshold). The floor is scoped to the
  // pending arm only: decay candidates (machine-approved rows) stay reachable at
  // any repetition so a stale auto-promotion can always be demoted.
  return internalQuery<PromoteDecayCandidateRow>(
    `SELECT id, org_id, type, status, confidence, repetition_count,
            avg_duration_ms, last_seen_at::text AS last_seen_at, auto_promoted
     FROM learned_patterns
     WHERE type = 'query_pattern'
       AND (
         (status = 'pending' AND repetition_count >= ${REPEATED_PATTERN_MIN_REPETITIONS})
         OR (status = 'approved' AND auto_promoted = true)
       )
       AND ${orgClause}
     ORDER BY updated_at DESC
     LIMIT $1`,
    params,
  );
}

/** Distinct org ids (including a single NULL bucket) from a set of returned
 *  rows — the cache-invalidation key set for the affected workspaces. */
function distinctOrgIds(rows: ReadonlyArray<{ org_id: string | null }>): Array<string | null> {
  const seen = new Set<string | null>();
  for (const r of rows) seen.add(r.org_id);
  return [...seen];
}

/**
 * Promote a batch of pending query patterns to approved (auto-promotion).
 *
 * The WHERE re-asserts `status = 'pending'` / `type = 'query_pattern'` so a
 * human approve/reject landing between the candidate read and this update can
 * never be clobbered. Returns the affected-row count and the distinct org ids
 * for cache invalidation.
 */
export async function promoteLearnedPatterns(
  ids: readonly string[],
): Promise<{ count: number; orgIds: Array<string | null> }> {
  if (ids.length === 0 || !hasInternalDB()) return { count: 0, orgIds: [] };
  const rows = await internalQuery<{ org_id: string | null }>(
    `UPDATE learned_patterns
     SET status = 'approved', auto_promoted = true,
         reviewed_by = $1, reviewed_at = now(), updated_at = now()
     WHERE id = ANY($2::uuid[]) AND status = 'pending' AND type = 'query_pattern'
     RETURNING org_id`,
    [AUTO_PROMOTE_REVIEWER, [...ids]],
  );
  return { count: rows.length, orgIds: distinctOrgIds(rows) };
}

/**
 * Demote a batch of stale auto-promoted patterns back to pending (decay).
 *
 * `auto_promoted` is intentionally left true so the row stays a machine-managed
 * candidate and can be re-promoted if it's seen again. The WHERE re-asserts
 * `auto_promoted = true` so a human approval (which clears the flag) is never
 * demoted out from under the admin.
 */
export async function demoteLearnedPatterns(
  ids: readonly string[],
): Promise<{ count: number; orgIds: Array<string | null> }> {
  if (ids.length === 0 || !hasInternalDB()) return { count: 0, orgIds: [] };
  const rows = await internalQuery<{ org_id: string | null }>(
    `UPDATE learned_patterns
     SET status = 'pending', updated_at = now()
     WHERE id = ANY($1::uuid[]) AND status = 'approved'
       AND auto_promoted = true AND type = 'query_pattern'
     RETURNING org_id`,
    [[...ids]],
  );
  return { count: rows.length, orgIds: distinctOrgIds(rows) };
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
  /**
   * When true, new rows land as `approval_status = 'approved'` and
   * `status = 'published'` — bypassing the admin moderation queue. Used
   * only via `atlas-operator learn --auto-approve`, which surfaces the explicit
   * operator intent. Existing rows are NOT retroactively approved on
   * ON CONFLICT: the ON CONFLICT clause below only refreshes metrics,
   * so an admin's prior hide or approve decision is preserved across
   * re-runs.
   */
  autoApprove?: boolean;
}): Promise<"created" | "updated" | "skipped"> {
  if (!hasInternalDB()) return "skipped";
  const approvalStatus = suggestion.autoApprove ? "approved" : "pending";
  const status = suggestion.autoApprove ? "published" : "draft";
  try {
    // approval_status / status are written explicitly rather than relying
    // on the column default (migration 0029). Explicit writes make the CLI
    // contract grep-visible and immune to a future ALTER TABLE that
    // changes the default. ON CONFLICT DO UPDATE touches only metrics —
    // see the field comment on `autoApprove` for why.
    const rows = await internalQuery<{ id: string; created: boolean }>(
      `INSERT INTO query_suggestions (
         org_id, description, pattern_sql, normalized_hash,
         tables_involved, primary_table,
         frequency, score, last_seen_at,
         approval_status, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
        approvalStatus,
        status,
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
  limit: number = 10,
  /**
   * Mode-system filter (1.2.0): `published` (default) returns only
   * `status = 'published'` rows — the user-facing surface. `developer`
   * additionally includes `status = 'draft'` so admins can preview
   * queued edits before hitting publish. Non-admin callers always land
   * on `published` because mode resolution upstream downgrades them.
   */
  mode: import("@useatlas/types/auth").AtlasMode = "published",
): Promise<QuerySuggestionRow[]> {
  if (!hasInternalDB()) return [];

  // Two independent gates enforce end-to-end moderation visibility:
  //   approval_status = 'approved' — pending / hidden rows never
  //     surface to the empty state, regardless of mode.
  //   status IN (...)              — the 1.2.0 mode axis: non-admin
  //     callers are downgraded to `published` upstream by
  //     resolveMode(), so drafts can only leak via developer-mode
  //     admins previewing their own queue.
  //
  // `resolveStatusClause()` (in `content-mode/port.ts`) is the single
  // source of truth for simple-table mode semantics — the same helper
  // the Effect `ContentModeRegistry.readFilter` delegates to. Using it
  // here keeps `query_suggestions` in lockstep with connections and
  // prompt_collections on every mode-semantics change. The helper
  // returns `query_suggestions.status = 'published'` (or `IN (...)`),
  // with no leading AND — we prefix it ourselves.
  //
  // Computed outside the try/catch on purpose: the helper's throw path
  // is reserved for programmer errors (bogus table name, tuple rename
  // that drops `query_suggestions`). The DB-connectivity catch below
  // returns `[]` + log.error, which would mask that class of bug as
  // "no popular suggestions" — the user sees an empty state, alerting
  // fires on every call, but nothing distinguishes it from a real DB
  // outage. Surfacing the throw to the caller converts it to a 500
  // with a stack instead.
  const statusClause = resolveStatusClause(
    "query_suggestions",
    mode,
    "query_suggestions",
  );

  try {
    const orgClause = orgId != null ? "org_id = $1" : "org_id IS NULL";
    const params: unknown[] = orgId != null ? [orgId, limit] : [limit];
    const limitIdx = params.length;

    return await internalQuery<QuerySuggestionRow>(
      `SELECT * FROM query_suggestions
       WHERE ${orgClause} AND approval_status = 'approved' AND ${statusClause}
       ORDER BY score DESC LIMIT $${limitIdx}`,
      params
    );
  } catch (err) {
    // Bump to error so alerting picks up a connectivity/query failure.
    // Callers cannot distinguish [] = no approved rows vs [] = DB outage —
    // making this log.error ensures the failure is surfaced out-of-band.
    log.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to get popular suggestions");
    return [];
  }
}

/**
 * Record a click on a query suggestion (fire-and-forget).
 *
 * Always bumps `clicked_count`. When `userId` is provided, also records
 * a row in `suggestion_user_clicks` with a (suggestion_id, user_id)
 * primary key so repeat clicks from the same user are deduplicated. On
 * the first click from a given user, `distinct_user_clicks` is
 * incremented atomically via a CTE so the counter cannot drift from the
 * join table.
 *
 * The auto-promote decision is policy-only (see
 * `@atlas/api/lib/suggestions/approval-service`) — this function only
 * maintains the counter that policy reads. The queue endpoint applies
 * the threshold + window at read time.
 */
export function incrementSuggestionClick(
  id: string,
  orgId: string | null,
  userId: string | null = null,
): void {
  if (!hasInternalDB()) return;
  const orgClause = orgId != null ? "org_id = $1" : "org_id IS NULL";

  if (userId == null) {
    const params: unknown[] = orgId != null ? [orgId, id] : [id];
    const idIdx = params.length;
    internalExecute(
      `UPDATE query_suggestions SET clicked_count = clicked_count + 1 WHERE ${orgClause} AND id = $${idIdx}`,
      params,
    );
    return;
  }

  // Distinct-user tracking path: upsert click row, then bump counters
  // atomically. `ON CONFLICT DO NOTHING` makes the insert idempotent
  // per (suggestion_id, user_id); the UPDATE adds to
  // distinct_user_clicks only when the insert actually produced a row.
  const orgParam = orgId;
  const params: unknown[] =
    orgParam != null ? [orgParam, id, userId] : [id, userId];
  const idIdx = orgParam != null ? 2 : 1;
  const userIdx = orgParam != null ? 3 : 2;

  internalExecute(
    `WITH inserted AS (
       INSERT INTO suggestion_user_clicks (suggestion_id, user_id)
       VALUES ($${idIdx}, $${userIdx})
       ON CONFLICT (suggestion_id, user_id) DO NOTHING
       RETURNING 1
     )
     UPDATE query_suggestions SET
       clicked_count = clicked_count + 1,
       distinct_user_clicks = distinct_user_clicks + (SELECT COUNT(*) FROM inserted)::int
     WHERE ${orgClause} AND id = $${idIdx}`,
    params,
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
export type PlanTier = "free" | "trial" | "starter" | "pro" | "business" | "locked";

/**
 * Why a workspace is suspended (#3424). NULL when not suspended.
 * - `billing` — the delinquency ladder suspended it (unpaid / 3+ failed
 *   payment attempts). The Stripe recovery handler may clear ONLY these.
 * - `operator` — an admin / platform operator suspended it manually (e.g.
 *   ToS abuse). A billing recovery must NEVER clear these.
 */
export type SuspensionSource = "billing" | "operator";

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  workspace_status: WorkspaceStatus;
  plan_tier: PlanTier;
  byot: boolean;
  /**
   * Sourced from the @better-auth/stripe plugin's camelCase
   * `"stripeCustomerId"` column (aliased in the SELECT) — the plugin owns
   * the value and writes it lazily at the org's first
   * `/subscription/upgrade` (#3417). The legacy snake_case
   * `stripe_customer_id` column (0027) is unread and unwritten, pending
   * a phase-2 drop.
   */
  stripe_customer_id: string | null;
  trial_ends_at: string | null;
  suspended_at: string | null;
  /**
   * Why the workspace is suspended (#3424). NULL when not suspended. The
   * Stripe recovery handler unsuspends ONLY when this is `'billing'`, so an
   * operator suspension survives a billing recovery.
   */
  suspension_source: SuspensionSource | null;
  /**
   * Operator plan-override window (#3427). NULL (or a past timestamp) means
   * Stripe is authoritative for `plan_tier`. A future timestamp means a
   * platform admin set `plan_tier` directly and the Stripe-webhook tier sync
   * (`applyWorkspaceTier` in lib/auth/server.ts) must NOT overwrite it until
   * the window lapses. Stamped/cleared via {@link updateWorkspacePlanTier}.
   */
  plan_override_until: string | null;
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
 * Batch-resolve display names for a list of organization ids. Every
 * requested id is present in the returned map; the value is `null` when the
 * row is missing (deleted / unknown), when the internal DB is unavailable,
 * or when the row exists but its `name` column is itself `null`. Safe to
 * call with an empty list — returns an empty map without touching the DB.
 */
export async function getWorkspaceNamesByIds(
  orgIds: string[],
): Promise<Map<string, string | null>> {
  const byId = new Map<string, string | null>();
  if (orgIds.length === 0) return byId;
  for (const id of orgIds) byId.set(id, null);
  if (!hasInternalDB()) return byId;
  const rows = await internalQuery<{ id: string; name: string | null }>(
    `SELECT id, name FROM organization WHERE id = ANY($1::text[])`,
    [orgIds],
  );
  for (const row of rows) byId.set(row.id, row.name);
  return byId;
}

/**
 * Get full workspace details for an organization.
 */
export async function getWorkspaceDetails(orgId: string): Promise<WorkspaceRow | null> {
  if (!hasInternalDB()) return null;
  const rows = await internalQuery<WorkspaceRow>(
    `SELECT id, name, slug, workspace_status, plan_tier, byot, "stripeCustomerId" AS stripe_customer_id, trial_ends_at, suspended_at, suspension_source, plan_override_until, deleted_at, region, region_assigned_at, "createdAt"
     FROM organization WHERE id = $1`,
    [orgId],
  );
  return rows[0] ?? null;
}

/**
 * Update workspace status. Returns true if the org was found and updated,
 * false if no row matched the given orgId.
 *
 * `suspensionSource` (#3424) records WHY a workspace is suspended so the Stripe
 * recovery handler can scope itself to billing-induced suspensions and never
 * clear an operator/manual one. It is required when suspending (callers state
 * the cause explicitly — `'billing'` from the delinquency ladder, `'operator'`
 * from admin/platform routes) and ignored otherwise. Activating or deleting
 * always clears `suspension_source` back to NULL.
 */
export async function updateWorkspaceStatus(
  orgId: string,
  status: WorkspaceStatus,
  suspensionSource?: SuspensionSource,
): Promise<boolean> {
  let sqlStr: string;
  let params: unknown[];
  if (status === "suspended") {
    // Default to 'operator' so an unsourced suspend fails safe — recovery
    // refuses to clear it (only an explicit 'billing' suspension is cleared).
    sqlStr = `UPDATE organization SET workspace_status = $1, suspended_at = now(), suspension_source = $3 WHERE id = $2 RETURNING id`;
    params = [status, orgId, suspensionSource ?? "operator"];
  } else if (status === "deleted") {
    sqlStr = `UPDATE organization SET workspace_status = $1, deleted_at = now(), suspension_source = NULL WHERE id = $2 RETURNING id`;
    params = [status, orgId];
  } else {
    // Activating: clear both timestamps and the suspension source.
    sqlStr = `UPDATE organization SET workspace_status = $1, suspended_at = NULL, deleted_at = NULL, suspension_source = NULL WHERE id = $2 RETURNING id`;
    params = [status, orgId];
  }

  const rows = await internalQuery<{ id: string }>(sqlStr, params);
  return rows.length > 0;
}

/**
 * Operator plan-override directive for {@link updateWorkspacePlanTier} (#3427).
 *
 * Stripe-driven writes (the webhook tier sync) pass NO `override` and leave
 * `plan_override_until` untouched — a future operator window keeps protecting
 * the grant, and once it lapses Stripe writes flow through normally.
 *
 * Operator-driven writes (platform-admin / admin-orgs plan changes) pass an
 * explicit directive:
 *  - `{ until: Date }` — stamp the precedence window so the next Stripe webhook
 *    skips its tier write until `until`.
 *  - `"clear"` — release control back to Stripe immediately (NULL the column),
 *    e.g. when an operator deliberately re-syncs an org to its Stripe state.
 */
export type PlanOverrideDirective = { readonly until: Date } | "clear";

/**
 * Whether a workspace's operator plan-override window is currently active
 * (#3427) — i.e. `plan_override_until` is set and in the future. When true,
 * the Stripe-webhook tier sync must NOT overwrite `plan_tier`. A NULL,
 * unparseable, or past timestamp returns false (Stripe is authoritative).
 *
 * @param planOverrideUntil the org row's `plan_override_until` value
 * @param now injectable clock for testing (defaults to wall-clock)
 */
export function isPlanOverrideActive(
  planOverrideUntil: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!planOverrideUntil) return false;
  const until = new Date(planOverrideUntil);
  if (Number.isNaN(until.getTime())) return false;
  return until.getTime() > now.getTime();
}

/**
 * Update workspace plan tier. Returns true if the org was found and updated,
 * false if no row matched the given orgId.
 *
 * `override` (#3427) controls the operator precedence window. Omit it on the
 * Stripe-webhook path (`plan_override_until` is left as-is); pass a directive on
 * operator paths to stamp or clear the window. See {@link PlanOverrideDirective}.
 *
 * The 0-row arm logs at error level: every caller passes an orgId that is
 * supposed to exist (Stripe webhook `referenceId`, platform-admin override),
 * so a miss is a contract violation — most likely a user-scoped referenceId
 * leaking into an org-scoped path (#3416) — not a benign not-found.
 */
export async function updateWorkspacePlanTier(
  orgId: string,
  planTier: PlanTier,
  override?: PlanOverrideDirective,
): Promise<boolean> {
  let sqlStr: string;
  let params: unknown[];
  if (override === undefined) {
    sqlStr = `UPDATE organization SET plan_tier = $1 WHERE id = $2 RETURNING id`;
    params = [planTier, orgId];
  } else if (override === "clear") {
    sqlStr = `UPDATE organization SET plan_tier = $1, plan_override_until = NULL WHERE id = $2 RETURNING id`;
    params = [planTier, orgId];
  } else {
    sqlStr = `UPDATE organization SET plan_tier = $1, plan_override_until = $3 WHERE id = $2 RETURNING id`;
    params = [planTier, orgId, override.until.toISOString()];
  }
  const rows = await internalQuery<{ id: string }>(sqlStr, params);
  if (rows.length === 0) {
    log.error(
      { orgId, planTier },
      "updateWorkspacePlanTier matched 0 rows — orgId does not exist in organization table (referenceId contract violation?)",
    );
    return false;
  }
  return true;
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
 * Assign a region to a workspace. One-way: once set, returns
 * `{ assigned: false, existing: <current region> }` without updating — this
 * path never changes an existing region (that goes through the admin
 * cross-region migration flow). On first assignment, returns
 * `{ assigned: true }`. If the workspace does not exist, returns
 * `{ assigned: false }` without an `existing` field.
 */
export async function setWorkspaceRegion(
  orgId: string,
  region: string,
): Promise<{ assigned: boolean; existing?: string }> {
  // Only assign if region is currently NULL — this path is one-way; an
  // existing region is changed only via the admin cross-region migration flow.
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
 * Numeric namespace for the per-workspace last-admin advisory lock — the
 * `classkey` arg of the two-arg `pg_advisory_xact_lock(int4, int4)`. Postgres
 * keeps the single-arg `pg_advisory_lock(bigint)` and two-arg `(int4, int4)`
 * lock spaces fully disjoint, so this can never collide with any single-arg
 * user. The two-arg peers are the chat-install gate (`3001`), `lead-outbox`
 * (`2870`), and the Stripe webhook lock (`3445`); all four namespaces are
 * pairwise distinct. Value is this guard's issue number (#3158).
 */
const LAST_ADMIN_LOCK_NAMESPACE = 3158;

/**
 * A parameterized-query runner. Structurally satisfied by {@link internalQuery}
 * (pooled, one connection per call) and by the transaction-bound `tx.query`
 * handed to {@link withWorkspaceAdminLock} / {@link withDemoSeedLock} callbacks.
 * Lets a helper that normally runs on the pool be threaded onto a single
 * transaction connection so a multi-statement sequence commits atomically.
 */
export type InternalQueryExecutor = <T extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;

/** Query bound to the {@link withWorkspaceAdminLock} transaction connection. */
export interface WorkspaceAdminLockTx {
  query: InternalQueryExecutor;
}

/**
 * Run `fn` inside a transaction holding per-workspace advisory locks for EVERY
 * workspace in `orgIds`, so every "last admin/owner" guard touching any of them
 * serializes. Without it, two concurrent demotions — or a demote racing a
 * membership removal / user delete — each read the OTHER admin as still present
 * in their own uncommitted snapshot and both succeed, stripping the workspace of
 * its last admin/owner (#3158).
 *
 * A plain `UPDATE ... WHERE EXISTS (another admin)` does NOT close this window
 * under READ COMMITTED: the EXISTS subquery takes no row lock, so two demotions
 * of DIFFERENT admins never conflict. The count (the decision) and the mutation
 * must both run while a shared lock is held.
 *
 * Advisory locks — not `SELECT ... FOR UPDATE` on the admin rows — because the
 * user-delete guard mutates through Better Auth's `removeUser` on a SEPARATE
 * connection; row locks this transaction held on the rows `removeUser` deletes
 * would deadlock. The advisory locks serialize the *decision* across every
 * guarded path (role change / membership removal / user delete) without locking
 * the member rows themselves. Mirrors the chat-install gate (#3001).
 *
 * Multiple locks (the global user delete, #3166): a `platform_admin` delete
 * cascades across ALL of the target's workspaces, so the guard must lock every
 * workspace where the target is an admin/owner — not just the caller's active
 * one. The ids are deduped and acquired in SORTED order so two concurrent
 * multi-workspace deletes with overlapping sets always grab shared locks in the
 * same sequence and can never deadlock-cycle. A single-workspace guard (1 lock)
 * never waits on a second lock, so it can't cycle against a multi-lock caller
 * either. All locks share the one {@link LAST_ADMIN_LOCK_NAMESPACE}, so a
 * single-workspace demotion in workspace B and a multi-workspace delete that
 * includes B serialize on `hashtext(B)`.
 *
 * The callback's count + role re-read MUST go through `tx.query` (the locked
 * connection) to be transaction-consistent — a stray `internalQuery` would land
 * on a different pooled connection, outside the lock. Throwing from the callback
 * rolls back and re-throws so the caller surfaces a 5xx. Always uses the raw
 * pool (a dedicated transaction connection), not the shared `_sqlClient` — the
 * same manual BEGIN/COMMIT/ROLLBACK + destroy-on-failed-rollback mechanics as
 * the raw-pool fallback in {@link cascadeWorkspaceDelete} and the chat-install
 * gate.
 *
 * Acquire one connection per call and hold every lock on it for the whole
 * transaction — never nest a second {@link withWorkspaceAdminLock(s)} (or any
 * other pool checkout) inside `fn`. The internal pool is bounded (max 5);
 * nesting checkouts under the lock lets concurrent callers each hold a client
 * while waiting for another, starving the pool (the nested-pool deadlock Codex
 * flagged on PR #3162). All the workspaces a call needs go in the single
 * `orgIds` array passed here.
 */
export async function withWorkspaceAdminLocks<T>(
  orgIds: readonly string[],
  fn: (tx: WorkspaceAdminLockTx) => Promise<T>,
): Promise<T> {
  // Dedupe + sort so the lock-acquisition order is identical for every caller
  // regardless of the order their orgIds arrive in — the deadlock-avoidance
  // invariant. Empty input still opens the transaction (the callback may run
  // guard-free reads), it just holds no advisory lock.
  const sortedOrgIds = [...new Set(orgIds)].sort();
  const client = await getInternalDB().connect();
  // Destroy the client on a failed ROLLBACK so a dirty socket doesn't poison
  // the next borrower (matches cascadeWorkspaceDelete).
  let rollbackErr: Error | null = null;
  const tx: WorkspaceAdminLockTx = {
    query: async <R extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const res = await client.query(sql, params);
      return res.rows as R[];
    },
  };
  try {
    await client.query("BEGIN");
    // Transaction-scoped advisory locks keyed on each workspace; released
    // automatically on COMMIT/ROLLBACK. hashtext maps the text org id to the
    // int4 the lock takes — a cross-workspace hash collision only costs extra
    // serialization, never correctness. Acquired in sorted order (see above).
    for (const orgId of sortedOrgIds) {
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
        LAST_ADMIN_LOCK_NAMESPACE,
        orgId,
      ]);
    }
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.warn(
        { orgIds: sortedOrgIds, err: rollbackErr.message },
        "ROLLBACK failed during withWorkspaceAdminLocks — client will be destroyed",
      );
    });
    throw err;
  } finally {
    client.release(rollbackErr ?? undefined);
  }
}

/**
 * Single-workspace convenience wrapper over {@link withWorkspaceAdminLocks} —
 * the common case for the role-change and membership-removal guards, which only
 * ever touch the caller's active workspace. See that function for the full
 * rationale on why this is an advisory lock and not row locks.
 */
export async function withWorkspaceAdminLock<T>(
  orgId: string,
  fn: (tx: WorkspaceAdminLockTx) => Promise<T>,
): Promise<T> {
  return withWorkspaceAdminLocks([orgId], fn);
}

/**
 * Numeric namespace for the per-workspace demo-seed advisory lock — the
 * `classkey` arg of the two-arg `pg_advisory_xact_lock(int4, int4)`. Distinct
 * from the last-admin (`3158`), chat-install (`3001`), lead-outbox (`2870`) and
 * Stripe webhook (`3445`) two-arg namespaces; pairwise distinct so a demo seed
 * never serializes against an unrelated guard on the same workspace. Value is
 * this guard's issue number (#3683).
 */
const DEMO_SEED_LOCK_NAMESPACE = 3683;

/** Query bound to the {@link withDemoSeedLock} transaction connection. */
export interface DemoSeedTx {
  query: InternalQueryExecutor;
}

/**
 * Run `fn` inside a single transaction holding a per-workspace advisory lock, so
 * the `/use-demo` seed (semantic-entity import → `workspace_plugins` published
 * flip) is BOTH mutually exclusive per workspace AND atomic (#3683).
 *
 * Atomicity: every write `fn` issues through `tx.query` runs on the one
 * transaction connection, so a blip / pool exhaustion / process kill between the
 * entity import and the published flip rolls the whole seed back — there is no
 * window where draft `semantic_entities` are committed with no published
 * datasource install (the orphaned-partial-demo state). Throwing anywhere in
 * `fn` rolls back and re-throws so the caller surfaces a 5xx.
 *
 * Mutual exclusion: two concurrent same-`orgId` POSTs (double-click, two tabs,
 * retry-while-pending) serialize on `pg_advisory_xact_lock(namespace,
 * hashtext(orgId))` instead of interleaving `ON CONFLICT DO UPDATE` upserts on
 * the same rows — which deadlock under Postgres row-lock ordering → intermittent
 * 500s. The lock is transaction-scoped, released automatically on
 * COMMIT/ROLLBACK. A cross-workspace `hashtext` collision only costs extra
 * serialization, never correctness.
 *
 * `fn`'s writes MUST go through `tx.query` (the locked connection) to be in the
 * transaction — a stray `internalQuery` lands on a different pooled connection,
 * outside both the lock and the transaction. Uses the main internal pool (one
 * dedicated connection per call) with the same manual BEGIN/COMMIT/ROLLBACK +
 * destroy-on-failed-rollback mechanics as {@link withWorkspaceAdminLocks}; never
 * nest another lock-holding pool checkout inside `fn` (the bounded-pool
 * nested-checkout deadlock — see {@link withWorkspaceAdminLocks}). Caller must
 * have already confirmed {@link hasInternalDB}.
 */
export async function withDemoSeedLock<T>(
  orgId: string,
  fn: (tx: DemoSeedTx) => Promise<T>,
): Promise<T> {
  const client = await getInternalDB().connect();
  // Destroy the client on a failed ROLLBACK so a dirty socket doesn't poison
  // the next borrower (matches withWorkspaceAdminLocks).
  let rollbackErr: Error | null = null;
  const tx: DemoSeedTx = {
    query: async <R extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const res = await client.query(sql, params);
      return res.rows as R[];
    },
  };
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
      DEMO_SEED_LOCK_NAMESPACE,
      orgId,
    ]);
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.warn(
        { orgId, err: rollbackErr.message },
        "ROLLBACK failed during withDemoSeedLock — client will be destroyed",
      );
    });
    throw err;
  } finally {
    client.release(rollbackErr ?? undefined);
  }
}

/**
 * Numeric namespace for the per-subscription Stripe webhook lock — the
 * `classkey` arg of the two-arg `pg_advisory_xact_lock(int4, int4)`.
 * Distinct from the last-admin (`3158`), chat-install (`3001`) and
 * lead-outbox (`2870`) two-arg namespaces. Value is this guard's issue
 * number (#3445).
 */
const STRIPE_SUBSCRIPTION_LOCK_NAMESPACE = 3445;

/**
 * Run `fn` while holding a per-subscription advisory lock, so the Stripe
 * webhook classify→sync→record sequence in `onEvent` serializes across
 * concurrent deliveries for the SAME `stripe_subscription_id` (#3445).
 * Without it, two parallel deliveries both pass the `classifyStripeEvent`
 * preflight read as `fresh`, and the OLDER event's sync can finish last,
 * overwriting the newer tier/lock state before recording successfully.
 * Under the lock, the second delivery sees the first's recorded ledger
 * row and classifies `stale`/`duplicate`.
 *
 * The lock SERIALIZES — it does not claim. Record-last semantics are the
 * caller's contract (a failed sync records nothing so the `onEvent`
 * throw → 400 → Stripe redelivery path stays live), and a thrown error
 * anywhere inside `fn` rolls back (releasing the transaction-scoped
 * lock) and re-throws. DB errors in the wrapper itself equally propagate
 * — never fail open into an unserialized sync.
 *
 * Deliveries for DIFFERENT subscriptions hash to different lock keys and
 * stay concurrent; events with no subscription id (and no-internal-DB
 * deployments, where there is no ledger to race on) skip the lock
 * entirely and just run `fn`.
 *
 * `fn`'s inner queries deliberately keep using the pooled
 * `internalQuery` — they don't need the lock-holder's transaction, only
 * mutual exclusion. The lock client comes from a DEDICATED lock-only
 * pool ({@link getStripeLockPool}), never the main internal pool: a
 * holder sits idle-in-transaction for the whole locked section, and if
 * lock traffic shared the bounded main pool, a burst of concurrent
 * deliveries could pin all of its clients in lock transactions and
 * starve the very `internalQuery` calls the holders need to finish — a
 * circular wait with no timeout (#3465 review). With the split, a
 * holder's progress depends only on the main pool, which no lock
 * participant occupies. Same manual BEGIN/COMMIT +
 * destroy-on-failed-rollback mechanics as
 * {@link withWorkspaceAdminLocks}; never nest another lock-holding pool
 * checkout inside `fn` (the nested-pool deadlock — see
 * {@link withWorkspaceAdminLocks}).
 */
export async function withStripeSubscriptionLock<T>(
  stripeSubscriptionId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (!stripeSubscriptionId || !hasInternalDB()) return fn();
  const client = await getStripeLockPool().connect();
  // Destroy the client on a failed ROLLBACK so a dirty socket doesn't
  // poison the next borrower (matches withWorkspaceAdminLocks).
  let rollbackErr: Error | null = null;
  try {
    await client.query("BEGIN");
    // Transaction-scoped advisory lock keyed on the subscription id;
    // released automatically on COMMIT/ROLLBACK. hashtext maps the text
    // id to the int4 the lock takes — a cross-subscription hash
    // collision only costs extra serialization, never correctness.
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
      STRIPE_SUBSCRIPTION_LOCK_NAMESPACE,
      stripeSubscriptionId,
    ]);
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (err) {
    // Log + re-throw: the caller (`onEvent`) propagates so Stripe
    // redelivers — a swallowed error here would silently drop the sync.
    log.warn(
      { stripeSubscriptionId, err: err instanceof Error ? err.message : String(err) },
      "Stripe webhook locked section failed — propagating so Stripe redelivers",
    );
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.warn(
        { stripeSubscriptionId, err: rollbackErr.message },
        "ROLLBACK failed during withStripeSubscriptionLock — client will be destroyed",
      );
    });
    throw err;
  } finally {
    client.release(rollbackErr ?? undefined);
  }
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
  // Destroy the client on a failed ROLLBACK so a dirty socket doesn't
  // poison the next borrower.
  let rollbackErr: Error | null = null;
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
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.warn(
        { orgId, err: rollbackErr.message },
        "ROLLBACK failed during cascadeWorkspaceDelete — client will be destroyed",
      );
    });
    throw err;
  } finally {
    client.release(rollbackErr ?? undefined);
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
      // Exclude archive tombstones for the same reason as the plan-limit
      // and billing counts — hidden `__global__` connections shouldn't
      // inflate workspace health summaries.
      countQuery(
        `SELECT COUNT(*)::int as count FROM workspace_plugins
          WHERE workspace_id = $1 AND pillar = 'datasource' AND status != 'archived'`,
        [orgId],
      ),
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

// setWorkspaceStripeCustomerId was deleted in #3417: the @better-auth/stripe
// plugin owns organization."stripeCustomerId" (written lazily at first
// /subscription/upgrade) — Atlas never writes the customer id itself.

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

// ---------------------------------------------------------------------------
// GDPR hard-delete (purge) — removes ALL org-scoped data permanently
// ---------------------------------------------------------------------------

/**
 * Hard-delete result — counts of rows removed from each table.
 */
export interface HardDeleteResult {
  // Data tables (org_id)
  auditLog: number;
  conversations: number;
  messages: number;
  slackInstallations: number;
  slackThreads: number;
  actionLog: number;
  scheduledTaskRuns: number;
  scheduledTasks: number;
  tokenUsage: number;
  pluginSettings: number;
  settings: number;
  semanticEntityVersions: number;
  semanticEntities: number;
  learnedPatterns: number;
  promptItems: number;
  promptCollections: number;
  querySuggestions: number;
  ssoProviders: number;
  ipAllowlist: number;
  customRoles: number;
  auditRetentionConfig: number;
  workspaceModelConfig: number;
  approvalQueue: number;
  approvalRules: number;
  workspaceBranding: number;
  onboardingEmails: number;
  piiColumnClassifications: number;
  scimGroupMappings: number;
  sandboxCredentials: number;
  dashboardCards: number;
  dashboards: number;
  oauthState: number;
  // Integration tables (org_id). teams/telegram/gchat/whatsapp_installations
  // were dropped by migration 0119 (#3161); discord_installations stays (BYOT).
  discordInstallations: number;
  githubInstallations: number;
  linearInstallations: number;
  emailInstallations: number;
  // Tables keyed by workspace_id
  usageEvents: number;
  usageSummaries: number;
  abuseEvents: number;
  customDomains: number;
  slaMetrics: number;
  slaAlerts: number;
  slaThresholds: number;
  regionMigrations: number;
  workspacePlugins: number;
  // Per-workspace credential stores (workspace_id) — encrypted secrets at rest.
  // integration_credentials: lazy-OAuth bundles (Salesforce/Jira/etc., ADR-0005).
  // twenty_integrations: Twenty CRM API key.
  integrationCredentials: number;
  twentyIntegrations: number;
  // Stripe billing linkage (#3425): @better-auth/stripe `subscription` rows
  // (0 when the plugin's table doesn't exist) + Atlas's stripe_webhook_events
  // dedupe-ledger rows for the org's subscription ids.
  subscriptions: number;
  stripeWebhookEvents: number;
  // Better Auth tables
  members: number;
  betterAuthInvitations: number;
  orphanedUsers: number;
  organization: number;
}

/**
 * GDPR-compliant hard delete — permanently removes ALL data for a workspace.
 *
 * Deletes every row across all tables scoped to the given orgId/workspaceId,
 * including Better Auth records (members, organization). Users who have no
 * remaining org memberships after removal are also deleted (sessions, accounts,
 * user row).
 *
 * This is irreversible. The workspace must already be soft-deleted before
 * calling this function.
 *
 * All operations run in a single transaction — either everything is purged
 * or nothing changes.
 */
export async function hardDeleteWorkspace(orgId: string): Promise<HardDeleteResult> {
  const pool = getInternalDB();
  const client = await pool.connect();
  // Destroy the client on a failed ROLLBACK so a dirty socket doesn't poison
  // the next borrower (matches cascadeWorkspaceDelete + admin-archive/publish).
  let rollbackErr: Error | null = null;

  try {
    await client.query("BEGIN");

    // Lock the organization row and verify it is still in "deleted" status.
    // Prevents a race where another admin reactivates the workspace between
    // the route handler's pre-check and this transaction.
    const statusCheck = await client.query(
      `SELECT workspace_status FROM organization WHERE id = $1 FOR UPDATE`,
      [orgId],
    );
    const status = (statusCheck.rows[0] as Record<string, unknown> | undefined)?.workspace_status;
    if (statusCheck.rows.length === 0 || status !== "deleted") {
      await client.query("ROLLBACK").catch((rbErr: unknown) => {
        rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
        log.warn(
          { orgId, err: rollbackErr.message },
          "ROLLBACK failed during hardDeleteWorkspace status check — client will be destroyed",
        );
      });
      throw new Error("Workspace is not in deleted status — purge aborted");
    }

    // del() executes a DELETE with RETURNING 1 to count affected rows
    const del = async (sql: string, params: unknown[] = [orgId]) => {
      const result = await client.query(sql + " RETURNING 1", params);
      return result.rows.length;
    };
    // delRaw() for statements that already include RETURNING 1 in the SQL
    // (used when subqueries make naive append break syntax)
    const delRaw = async (sql: string, params: unknown[] = [orgId]) => {
      const result = await client.query(sql, params);
      return result.rows.length;
    };

    // ── Phase 1: Child tables with FK dependencies (delete children first) ──

    // slack_threads uses conversation_id (no FK constraint) — delete before conversations to avoid orphans
    const slackThreads = await delRaw(
      `DELETE FROM slack_threads WHERE conversation_id IN (SELECT id FROM conversations WHERE org_id = $1) RETURNING 1`,
    );

    // messages cascade from conversations via FK (schema.ts:107), but we delete
    // explicitly as a GDPR completeness guarantee — older deployments may predate the FK
    const messages = await delRaw(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE org_id = $1) RETURNING 1`);

    // scheduled_task_runs references scheduled_tasks via FK cascade
    const scheduledTaskRuns = await delRaw(
      `DELETE FROM scheduled_task_runs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE org_id = $1) RETURNING 1`,
    );

    // semantic_entity_versions references semantic_entities via FK cascade
    const semanticEntityVersions = await del(
      `DELETE FROM semantic_entity_versions WHERE org_id = $1`,
    );

    // prompt_items references prompt_collections via FK cascade
    const promptItems = await delRaw(
      `DELETE FROM prompt_items WHERE collection_id IN (SELECT id FROM prompt_collections WHERE org_id = $1) RETURNING 1`,
    );

    // dashboard_cards references dashboards via FK cascade
    const dashboardCards = await delRaw(
      `DELETE FROM dashboard_cards WHERE dashboard_id IN (SELECT id FROM dashboards WHERE org_id = $1) RETURNING 1`,
    );

    // ── Phase 2: All org_id tables ──

    const auditLog = await del(`DELETE FROM audit_log WHERE org_id = $1`);
    const conversations = await del(`DELETE FROM conversations WHERE org_id = $1`);
    // Slack installs live in `chat_cache` post-#2634 (key prefix
    // `slack:installation:`). The partial expression index on
    // `value->>'orgId'` makes the org-scoped delete a cheap lookup.
    // The `'orgId'` literal mirrors `lib/slack/store.ts:FIELD.orgId`
    // — kept inline here to avoid a `db/internal.ts → lib/slack`
    // import cycle. If FIELD ever changes, grep this file too.
    const slackInstallations = await del(
      `DELETE FROM chat_cache WHERE key LIKE 'slack:installation:%' AND value->>'orgId' = $1`,
    );
    const actionLog = await del(`DELETE FROM action_log WHERE org_id = $1`);
    const scheduledTasks = await del(`DELETE FROM scheduled_tasks WHERE org_id = $1`);
    // `connections` table dropped by 0096 cutover — datasource installs
    // live in `workspace_plugins` (pillar='datasource') and are wiped
    // alongside other installs in Phase 3 below.
    const tokenUsage = await del(`DELETE FROM token_usage WHERE org_id = $1`);
    // Legacy `invitations` (plural) table has been dropped. Better Auth's
    // `invitation` (singular) table cascades via the foreign-key drop
    // when `DELETE FROM organization` fires below — no explicit DELETE needed.
    const pluginSettings = await del(`DELETE FROM plugin_settings WHERE org_id = $1`);
    const settings = await del(`DELETE FROM settings WHERE org_id = $1`);
    const semanticEntities = await del(`DELETE FROM semantic_entities WHERE org_id = $1`);
    const learnedPatterns = await del(`DELETE FROM learned_patterns WHERE org_id = $1`);
    const promptCollections = await del(`DELETE FROM prompt_collections WHERE org_id = $1`);
    const querySuggestions = await del(`DELETE FROM query_suggestions WHERE org_id = $1`);
    const ssoProviders = await del(`DELETE FROM sso_providers WHERE org_id = $1`);
    const ipAllowlist = await del(`DELETE FROM ip_allowlist WHERE org_id = $1`);
    const customRoles = await del(`DELETE FROM custom_roles WHERE org_id = $1`);
    const auditRetentionConfig = await del(`DELETE FROM audit_retention_config WHERE org_id = $1`);
    const workspaceModelConfig = await del(`DELETE FROM workspace_model_config WHERE org_id = $1`);
    const approvalQueue = await del(`DELETE FROM approval_queue WHERE org_id = $1`);
    const approvalRules = await del(`DELETE FROM approval_rules WHERE org_id = $1`);
    const workspaceBranding = await del(`DELETE FROM workspace_branding WHERE org_id = $1`);
    const onboardingEmails = await del(`DELETE FROM onboarding_emails WHERE org_id = $1`);
    const piiColumnClassifications = await del(`DELETE FROM pii_column_classifications WHERE org_id = $1`);
    // scim_group_mappings ships in 0000_baseline.sql + migration 0152 (#4019),
    // but the EU/APAC prod region DBs were observed missing it — and unlike the
    // `subscription` deletes below, this DELETE had NO existence probe, so its
    // `relation "scim_group_mappings" does not exist` aborted the ENTIRE purge
    // transaction: a workspace could be soft-deleted but never GDPR-purged.
    // Probe with to_regclass so a region with residual drift skips this one
    // table instead of rolling the whole cascade back. The `subscription` probe
    // below stays silent on a miss (a historically Better-Auth-only table whose
    // probe predates 0152), but scim_group_mappings has always shipped in the
    // baseline, so post-0152 an absent table here is pure drift — log it rather
    // than skip silently.
    let scimGroupMappings = 0;
    const scimTableProbe = await client.query(
      `SELECT to_regclass('public.scim_group_mappings') IS NOT NULL AS table_exists`,
    );
    if ((scimTableProbe.rows[0] as { table_exists?: boolean } | undefined)?.table_exists === true) {
      scimGroupMappings = await del(`DELETE FROM scim_group_mappings WHERE org_id = $1`);
    } else {
      log.warn(
        { orgId },
        "scim_group_mappings absent during hardDeleteWorkspace — skipping its DELETE (region-DB drift; migration 0152 should have repaired this)",
      );
    }
    const sandboxCredentials = await del(`DELETE FROM sandbox_credentials WHERE org_id = $1`);
    const dashboards = await del(`DELETE FROM dashboards WHERE org_id = $1`);
    const oauthState = await del(`DELETE FROM oauth_state WHERE org_id = $1`);

    // Integration tables (org_id). teams/telegram/gchat/whatsapp_installations
    // were dropped by migration 0119 (#3161) — those static-bot installs live
    // in `workspace_plugins` (cleared below). discord_installations stays (BYOT).
    const discordInstallations = await del(`DELETE FROM discord_installations WHERE org_id = $1`);
    const githubInstallations = await del(`DELETE FROM github_installations WHERE org_id = $1`);
    const linearInstallations = await del(`DELETE FROM linear_installations WHERE org_id = $1`);
    const emailInstallations = await del(`DELETE FROM email_installations WHERE org_id = $1`);

    // ── Phase 3: Tables keyed by workspace_id (same value as orgId) ──

    const usageEvents = await del(`DELETE FROM usage_events WHERE workspace_id = $1`);
    const usageSummaries = await del(`DELETE FROM usage_summaries WHERE workspace_id = $1`);
    const abuseEvents = await del(`DELETE FROM abuse_events WHERE workspace_id = $1`);
    const customDomains = await del(`DELETE FROM custom_domains WHERE workspace_id = $1`);
    const slaMetrics = await del(`DELETE FROM sla_metrics WHERE workspace_id = $1`);
    const slaAlerts = await del(`DELETE FROM sla_alerts WHERE workspace_id = $1`);
    const slaThresholds = await del(`DELETE FROM sla_thresholds WHERE workspace_id = $1`);
    const regionMigrations = await del(`DELETE FROM region_migrations WHERE workspace_id = $1`);
    const workspacePlugins = await del(`DELETE FROM workspace_plugins WHERE workspace_id = $1`);
    // Per-workspace encrypted credential stores, matched on the workspace_id
    // column (same value as orgId — see the Phase-3 header above). Without
    // these, a "full" purge leaves secrets at rest: integration_credentials =
    // lazy-OAuth bundles (Salesforce/Jira/etc., ADR-0005); twenty_integrations
    // = Twenty CRM API key.
    const integrationCredentials = await del(`DELETE FROM integration_credentials WHERE workspace_id = $1`);
    const twentyIntegrations = await del(`DELETE FROM twenty_integrations WHERE workspace_id = $1`);

    // ── Phase 3b: Stripe billing linkage rows (#3425) ──
    // Better Auth creates the @better-auth/stripe `subscription` table only on
    // Stripe deployments (STRIPE_SECRET_KEY), but migration 0152 (#4019) now also
    // CREATEs it IF NOT EXISTS in every mode for region parity, so post-0152 it
    // exists everywhere. Probe with to_regclass anyway so a DB that pre-dates
    // 0152 (or carries residual drift) doesn't abort the purge transaction. The
    // REMOTE teardown (cancel subscription, delete the Stripe customer) runs in
    // lib/billing/workspace-teardown.ts BEFORE this cascade; these deletes remove
    // the local billable linkage for GDPR completeness. The stripe_webhook_events
    // dedupe ledger rows are matched via the org's subscription ids, so they must
    // go before the subscription rows.
    let subscriptions = 0;
    let stripeWebhookEvents = 0;
    const subscriptionTableProbe = await client.query(
      `SELECT to_regclass('public.subscription') IS NOT NULL AS table_exists`,
    );
    const subscriptionTableExists =
      (subscriptionTableProbe.rows[0] as { table_exists?: boolean } | undefined)?.table_exists === true;
    if (subscriptionTableExists) {
      // Tombstone the purged subscription ids FIRST (#3468): the remote
      // teardown's cancellations generate `customer.subscription.deleted`
      // webhooks that arrive after this transaction commits, and the
      // webhook ledger records events keyed on the subscription id even
      // when no org resolves — without the tombstone, a completed purge
      // immediately regrows `stripe_webhook_events` rows. Stamped inside
      // the purge transaction (same atomicity as the deletes below);
      // consulted by `classifyStripeEvent`; pruned after 30 days.
      await client.query(
        `INSERT INTO stripe_purged_subscriptions (stripe_subscription_id)
         SELECT "stripeSubscriptionId" FROM subscription
          WHERE "referenceId" = $1 AND "stripeSubscriptionId" IS NOT NULL
         ON CONFLICT (stripe_subscription_id) DO NOTHING`,
        [orgId],
      );
      stripeWebhookEvents = await delRaw(
        `DELETE FROM stripe_webhook_events WHERE stripe_subscription_id IN (
           SELECT "stripeSubscriptionId" FROM subscription
            WHERE "referenceId" = $1 AND "stripeSubscriptionId" IS NOT NULL
         ) RETURNING 1`,
      );
      subscriptions = await del(`DELETE FROM subscription WHERE "referenceId" = $1`);
    }

    // ── Phase 4: Better Auth — members + orphaned users ──

    // Find users who are ONLY in this org (no other memberships)
    const orphanedUserRows = await client.query(
      `SELECT m."userId"
       FROM member m
       WHERE m."organizationId" = $1
         AND NOT EXISTS (
           SELECT 1 FROM member m2
           WHERE m2."userId" = m."userId"
             AND m2."organizationId" != $1
         )`,
      [orgId],
    );
    const orphanedUserIds = (orphanedUserRows.rows as Array<{ userId: string }>).map((r) => r.userId);

    // Remove all memberships for this org
    const members = await del(`DELETE FROM member WHERE "organizationId" = $1`);

    // Delete Better Auth invitations for this org
    const betterAuthInvitations = await del(`DELETE FROM invitation WHERE "organizationId" = $1`);

    // Clean up orphaned users — sessions, accounts, onboarding, email prefs, then user
    let orphanedUsers = 0;
    if (orphanedUserIds.length > 0) {
      await delRaw(
        `DELETE FROM session WHERE "userId" = ANY($1) RETURNING 1`,
        [orphanedUserIds],
      );
      await delRaw(
        `DELETE FROM account WHERE "userId" = ANY($1) RETURNING 1`,
        [orphanedUserIds],
      );
      await delRaw(
        `DELETE FROM user_onboarding WHERE user_id = ANY($1) RETURNING 1`,
        [orphanedUserIds],
      );
      await delRaw(
        `DELETE FROM email_preferences WHERE user_id = ANY($1) RETURNING 1`,
        [orphanedUserIds],
      );
      const userResult = await client.query(
        `DELETE FROM "user" WHERE id = ANY($1) RETURNING 1`,
        [orphanedUserIds],
      );
      orphanedUsers = userResult.rows.length;
    }

    // ── Phase 5: Delete the organization row itself ──

    const organization = await del(`DELETE FROM organization WHERE id = $1`);

    await client.query("COMMIT");

    return {
      auditLog,
      conversations,
      messages,
      slackInstallations,
      slackThreads,
      actionLog,
      scheduledTaskRuns,
      scheduledTasks,
      tokenUsage,
      pluginSettings,
      settings,
      semanticEntityVersions,
      semanticEntities,
      learnedPatterns,
      promptItems,
      promptCollections,
      querySuggestions,
      ssoProviders,
      ipAllowlist,
      customRoles,
      auditRetentionConfig,
      workspaceModelConfig,
      approvalQueue,
      approvalRules,
      workspaceBranding,
      onboardingEmails,
      piiColumnClassifications,
      scimGroupMappings,
      sandboxCredentials,
      dashboardCards,
      dashboards,
      oauthState,
      discordInstallations,
      githubInstallations,
      linearInstallations,
      emailInstallations,
      usageEvents,
      usageSummaries,
      abuseEvents,
      customDomains,
      slaMetrics,
      slaAlerts,
      slaThresholds,
      regionMigrations,
      workspacePlugins,
      integrationCredentials,
      twentyIntegrations,
      subscriptions,
      stripeWebhookEvents,
      members,
      betterAuthInvitations,
      orphanedUsers,
      organization,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.warn(
        { orgId, err: rollbackErr.message },
        "ROLLBACK failed after purge transaction error — client will be destroyed",
      );
    });
    throw err;
  } finally {
    client.release(rollbackErr ?? undefined);
  }
}
