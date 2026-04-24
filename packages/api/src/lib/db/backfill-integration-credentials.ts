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
 * Idempotent — re-running is safe, the `IS NULL` guard skips already-
 * backfilled rows. Runs each table in its own transaction so a failure
 * on one table doesn't roll back the others.
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

/**
 * Narrowed pool interface — only the two methods `backfillTable` touches.
 * Avoiding the full `pg.PoolClient` type here keeps the function easy to
 * exercise with a hand-rolled mock in tests.
 */
interface BackfillClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(err?: Error): void;
}
interface BackfillPool {
  connect(): Promise<BackfillClient>;
}

interface TextTable {
  kind: "text";
  table: string;
  pk: string;
  plaintext: string;
  encrypted: string;
}

interface JsonbTable {
  kind: "jsonb";
  table: string;
  pk: string;
  plaintext: string;
  encrypted: string;
}

type TableConfig = TextTable | JsonbTable;

/**
 * Ordered list of tables to backfill. Order is presentation-only — each
 * table runs in its own transaction. Primary-key columns drive the
 * per-row UPDATE so the script works even when the plaintext value
 * itself is not unique.
 */
const TABLES: ReadonlyArray<TableConfig> = [
  { kind: "text", table: "slack_installations", pk: "team_id", plaintext: "bot_token", encrypted: "bot_token_encrypted" },
  { kind: "text", table: "teams_installations", pk: "tenant_id", plaintext: "app_password", encrypted: "app_password_encrypted" },
  { kind: "text", table: "discord_installations", pk: "guild_id", plaintext: "bot_token", encrypted: "bot_token_encrypted" },
  { kind: "text", table: "telegram_installations", pk: "bot_id", plaintext: "bot_token", encrypted: "bot_token_encrypted" },
  { kind: "text", table: "gchat_installations", pk: "project_id", plaintext: "credentials_json", encrypted: "credentials_json_encrypted" },
  { kind: "text", table: "github_installations", pk: "user_id", plaintext: "access_token", encrypted: "access_token_encrypted" },
  { kind: "text", table: "linear_installations", pk: "user_id", plaintext: "api_key", encrypted: "api_key_encrypted" },
  { kind: "text", table: "whatsapp_installations", pk: "phone_number_id", plaintext: "access_token", encrypted: "access_token_encrypted" },
  { kind: "jsonb", table: "email_installations", pk: "config_id", plaintext: "config", encrypted: "config_encrypted" },
  { kind: "jsonb", table: "sandbox_credentials", pk: "id", plaintext: "credentials", encrypted: "credentials_encrypted" },
] as const;

interface BackfillResult {
  table: string;
  scanned: number;
  updated: number;
  skipped: number;
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
  const client = await pool.connect();
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
      await client.query(
        `UPDATE ${config.table} SET ${config.encrypted} = $1 WHERE ${config.pk} = $2`,
        [encrypted, row.pk],
      );
      updated += 1;
    }

    await client.query("COMMIT");
    return { table: config.table, scanned: rows.length, updated, skipped };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Rollback failure is secondary — the original error is what matters.
    });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Coerce the raw plaintext column value into the string that
 * `encryptSecret` operates on. JSONB columns arrive as objects from the
 * pg driver and need JSON.stringify. A null, undefined, or empty row is
 * skipped rather than encrypted (the migration already relaxed NOT NULL,
 * so empty rows are legal and should not be rewritten to `enc:v1:…`).
 */
function serializePlaintext(config: TableConfig, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (config.kind === "text") {
    if (typeof raw !== "string" || raw.length === 0) return null;
    return raw;
  }
  // JSONB: pg driver returns objects; re-stringify verbatim so round-trip
  // parse(decrypt(x)) matches the stored JSONB content. If the driver
  // returned a string (rare — depends on column parsers), take it as-is.
  if (typeof raw === "string") return raw.length === 0 ? null : raw;
  if (typeof raw === "object") return JSON.stringify(raw);
  return null;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set — nothing to backfill");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    let grandTotal = 0;
    for (const config of TABLES) {
      const result = await backfillTable(pool, config);
      grandTotal += result.updated;
      console.log(
        `[${result.table}] scanned=${result.scanned} updated=${result.updated} skipped=${result.skipped}`,
      );
    }
    console.log(`Backfill complete — ${grandTotal} rows encrypted across ${TABLES.length} tables`);
  } finally {
    await pool.end();
  }
}

// `import.meta.main` is true when this file is invoked directly with bun,
// false when imported from a test. Keeps the script dual-purpose.
if (import.meta.main) {
  main().catch((err) => {
    console.error("Backfill failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
