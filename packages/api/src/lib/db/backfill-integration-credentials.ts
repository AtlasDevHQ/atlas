/**
 * Backfill script for F-41 — workspace integration credential encryption.
 *
 * Migration `0036_integration_credentials_encryption.sql` only adds the
 * `*_encrypted` columns; it cannot do the encryption itself because the
 * cipher key lives in app config (ATLAS_ENCRYPTION_KEY / BETTER_AUTH_SECRET).
 *
 * This script walks every integration table, finds rows where the plaintext
 * column is populated but the encrypted column is still NULL, and writes
 * `encryptSecret(plaintext)` into the encrypted column. For the two JSONB
 * carriers (email_installations.config, sandbox_credentials.credentials)
 * it JSON-serializes the blob first.
 *
 * Idempotent — re-running is safe: the `IS NULL` guard skips already-
 * backfilled rows. Each table runs inside its own transaction so a failure
 * on one table doesn't roll back the others that already committed. A
 * failure does stop the script (remaining tables are not attempted) —
 * re-run after fixing the cause; earlier tables will be skipped because
 * their encrypted columns are already populated. A session-level
 * advisory lock prevents two operators from doing the same work
 * concurrently.
 *
 * Usage:
 *   bun run packages/api/src/lib/db/backfill-integration-credentials.ts
 *
 * Exit codes:
 *   0 — all tables processed, row counts printed
 *   1 — pool init failed or a table returned an unexpected error
 */

import { Pool } from "pg";
import { encryptSecret } from "@atlas/api/lib/db/secret-encryption";
import { activeKeyVersion } from "@atlas/api/lib/db/encryption-keys";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("backfill-f41");

/**
 * Narrowed pool interface — only the two methods `backfillTable` touches.
 * Avoiding the full `pg.PoolClient` type keeps the function easy to
 * exercise with a hand-rolled mock in tests.
 */
interface BackfillClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(err?: Error): void;
}
interface BackfillPool {
  connect(): Promise<BackfillClient>;
}

/**
 * A single backfill target. `kind` picks between plain-string and
 * JSON-stringified serialization; the other four fields name the table
 * and columns that get interpolated into the raw SQL below. They must
 * pass `assertIdentifier` — the `TABLES` literal below does, and
 * `backfillTable` re-checks at runtime to keep the attack surface closed
 * if the helper is ever called with caller-supplied config.
 */
export interface TableConfig {
  kind: "text" | "jsonb";
  table: string;
  pk: string;
  plaintext: string;
  encrypted: string;
  /**
   * Name of the F-47 companion `_key_version` column that stores the
   * keyset version used to produce the row's `encrypted` ciphertext.
   * Named `…Column` (not just `keyVersion`) to avoid confusion with an
   * actual version *number* — every other field here is a SQL
   * identifier, and this one is too.
   */
  keyVersionColumn: string;
}

/**
 * Every integration credential table. Extending this list is how new
 * encrypted integrations opt into the backfill. Names are validated at
 * `backfillTable` entry against `/^[a-z_][a-z0-9_]*$/`.
 */
export const TABLES: ReadonlyArray<TableConfig> = [
  { kind: "text", table: "slack_installations", pk: "team_id", plaintext: "bot_token", encrypted: "bot_token_encrypted", keyVersionColumn: "bot_token_key_version" },
  { kind: "text", table: "teams_installations", pk: "tenant_id", plaintext: "app_password", encrypted: "app_password_encrypted", keyVersionColumn: "app_password_key_version" },
  { kind: "text", table: "discord_installations", pk: "guild_id", plaintext: "bot_token", encrypted: "bot_token_encrypted", keyVersionColumn: "bot_token_key_version" },
  { kind: "text", table: "telegram_installations", pk: "bot_id", plaintext: "bot_token", encrypted: "bot_token_encrypted", keyVersionColumn: "bot_token_key_version" },
  { kind: "text", table: "gchat_installations", pk: "project_id", plaintext: "credentials_json", encrypted: "credentials_json_encrypted", keyVersionColumn: "credentials_json_key_version" },
  { kind: "text", table: "github_installations", pk: "user_id", plaintext: "access_token", encrypted: "access_token_encrypted", keyVersionColumn: "access_token_key_version" },
  { kind: "text", table: "linear_installations", pk: "user_id", plaintext: "api_key", encrypted: "api_key_encrypted", keyVersionColumn: "api_key_key_version" },
  { kind: "text", table: "whatsapp_installations", pk: "phone_number_id", plaintext: "access_token", encrypted: "access_token_encrypted", keyVersionColumn: "access_token_key_version" },
  { kind: "jsonb", table: "email_installations", pk: "config_id", plaintext: "config", encrypted: "config_encrypted", keyVersionColumn: "config_key_version" },
  { kind: "jsonb", table: "sandbox_credentials", pk: "id", plaintext: "credentials", encrypted: "credentials_encrypted", keyVersionColumn: "credentials_key_version" },
] as const;

export interface BackfillResult {
  table: string;
  scanned: number;
  updated: number;
  skipped: number;
}

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(name: string, role: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`Backfill ${role} ${JSON.stringify(name)} is not a valid SQL identifier`);
  }
}

/**
 * Backfill one table. Pulls every row where the encrypted column is NULL
 * and the plaintext column carries a usable value, encrypts the plaintext
 * via `encryptSecret`, and writes it back. All UPDATEs run inside one
 * transaction so a mid-batch failure rolls back cleanly.
 *
 * Uses a simple `SELECT … WHERE encrypted IS NULL` pattern rather than a
 * cursor because the total row count across integration tables is tiny
 * (thousands at most per workspace) and a cursor would complicate
 * transaction boundaries for no real benefit.
 */
export async function backfillTable(
  pool: BackfillPool,
  config: TableConfig,
): Promise<BackfillResult> {
  for (const [role, name] of Object.entries({
    table: config.table,
    pk: config.pk,
    plaintext: config.plaintext,
    encrypted: config.encrypted,
    keyVersionColumn: config.keyVersionColumn,
  })) {
    assertIdentifier(name, role);
  }

  const client = await pool.connect();
  let caught: unknown;
  try {
    await client.query("BEGIN");

    const rows = (
      await client.query(
        `SELECT ${config.pk} AS pk, ${config.plaintext} AS plaintext
         FROM ${config.table}
         WHERE ${config.encrypted} IS NULL
           AND ${config.plaintext} IS NOT NULL`,
      )
    ).rows as Array<{ pk: string; plaintext: unknown }>;

    let updated = 0;
    let skipped = 0;
    for (const row of rows) {
      const plaintext = serializePlaintext(config, row.plaintext);
      if (plaintext === null) {
        skipped += 1;
        continue;
      }
      const encrypted = encryptSecret(plaintext);
      const keyVersion = activeKeyVersion();
      await client.query(
        `UPDATE ${config.table} SET ${config.encrypted} = $1, ${config.keyVersionColumn} = $3 WHERE ${config.pk} = $2`,
        [encrypted, row.pk, keyVersion],
      );
      updated += 1;
    }

    await client.query("COMMIT");
    return { table: config.table, scanned: rows.length, updated, skipped };
  } catch (err) {
    caught = err;
    await client.query("ROLLBACK").catch(() => {
      // Rollback failure is secondary — the original error is what matters.
    });
    throw err;
  } finally {
    // Pass a truthy error so node-postgres destroys the socket instead
    // of returning a client in-transaction (or otherwise-broken) to the
    // pool. `undefined` on success lets the pool reuse it normally.
    client.release(caught instanceof Error ? caught : undefined);
  }
}

/**
 * Coerce the raw plaintext column value into the string that
 * `encryptSecret` operates on. The SQL `WHERE` already excludes NULL
 * plaintext values, but these null/empty branches are belt-and-braces
 * safety — encrypting an empty blob and persisting `enc:v1:…` would be
 * strictly worse than leaving the row untouched for a future audit.
 * JSONB columns arrive as objects from the pg driver and are
 * re-stringified verbatim so `JSON.parse(decryptSecret(x))` round-trips
 * to the same shape the stored JSONB holds.
 */
function serializePlaintext(config: TableConfig, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (config.kind === "text") {
    if (typeof raw !== "string" || raw.length === 0) return null;
    return raw;
  }
  // JSONB path. If the driver returns a string (depends on column-type
  // parsers — some apps register a JSONB text parser override), take it
  // as-is; otherwise stringify the object.
  if (typeof raw === "string") return raw.length === 0 ? null : raw;
  if (typeof raw === "object") return JSON.stringify(raw);
  return null;
}

/** 32-bit stable hash of a literal — used as the `pg_advisory_lock` key. */
const LOCK_KEY = 0x1f41; // arbitrary, stable across runs so concurrent operators block

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log.error("DATABASE_URL is not set — nothing to backfill");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  // Hold the advisory lock on a single session for the whole run so two
  // operators invoking the script in parallel don't re-encrypt the same
  // rows (correct-but-wasteful — second write just produces fresh IVs,
  // but the first also uses CPU + WAL).
  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    let grandTotal = 0;
    for (const config of TABLES) {
      log.info({ table: config.table }, "backfill starting");
      const result = await backfillTable(pool, config);
      grandTotal += result.updated;
      log.info(
        { table: result.table, scanned: result.scanned, updated: result.updated, skipped: result.skipped },
        "backfill complete",
      );
    }
    log.info({ grandTotal, tableCount: TABLES.length }, "Backfill complete across all tables");
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {
      // intentionally ignored: advisory unlock is best-effort; session
      // teardown below releases the lock regardless.
    });
    lockClient.release();
    await pool.end();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "Backfill failed");
    process.exit(1);
  });
}
