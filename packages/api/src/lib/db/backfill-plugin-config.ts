/**
 * Backfill script for F-42 — plugin config at-rest encryption.
 *
 * Migration `0037_plugin_config_encryption.sql` stamps a COMMENT on the
 * two JSONB columns but does not encrypt existing rows — the cipher key
 * lives in app config (ATLAS_ENCRYPTION_KEY / BETTER_AUTH_SECRET), so
 * encryption has to happen in app code.
 *
 * This script walks both carriers:
 *
 *   1. `plugin_settings` — platform-wide config for built-in plugins,
 *      keyed by `plugin_id`. Catalog schema comes from `plugin.getConfigSchema()`
 *      at runtime, but we don't run the registry here; we fall back to a
 *      schemaless corrupt-like mode where every non-empty string gets
 *      encrypted. That is symmetric with the route-level fail-closed
 *      branch in `encryptSecretFields` — the backfill is at worst
 *      over-encrypting operational strings (port, region) one time, and
 *      a future PUT through the admin UI rewrites those under the real
 *      schema if the operator cares.
 *
 *   2. `workspace_plugins` — per-workspace marketplace installs, keyed
 *      by `id`. Catalog schema comes from `plugin_catalog.config_schema`
 *      via an inner join, so the backfill knows exactly which keys are
 *      secret. Corrupt / missing schemas fall through to the same
 *      fail-closed walker the route uses.
 *
 * Idempotent on secret fields: `encryptSecretFields` skips any string
 * value that already begins with `enc:v1:`. Re-runs do not re-encrypt
 * those. Note — a `workspace_plugins` row whose *non-secret* fields are
 * still plaintext (region, port, debug) will trigger a rewrite on each
 * run because the row-level short-circuit looks at every string value,
 * not just `secret:true` ones; the rewrite itself is a no-op on the
 * secret fields and the operational-string no-op cost is acceptable for
 * a one-time pass. A session-level advisory lock (same shape as F-41)
 * stops two operators from doing the work concurrently.
 *
 * Usage:
 *   bun run packages/api/src/lib/db/backfill-plugin-config.ts
 *
 * Exit codes:
 *   0 — all rows processed, row counts printed
 *   1 — pool init failed or the batch threw with no path forward
 *
 * F-47 (#1820) adds a rotation path that re-encrypts under a new key —
 * a separate backfill because it also has to decrypt first. Single-key
 * verification here is all that's needed for F-42; see the "rotation
 * pre-test" comment in `secrets-encryption.test.ts`.
 */

import { Pool } from "pg";
import {
  encryptSecretFields,
  parseConfigSchema,
  isEncryptedSecret,
  type ConfigSchema,
} from "@atlas/api/lib/plugins/secrets";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("backfill-f42");

/**
 * Narrowed pool interface — only the two methods the backfill touches.
 * Avoiding the full `pg.PoolClient` keeps the unit shape tiny and
 * mockable from tests.
 */
interface BackfillClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(err?: Error): void;
}
interface BackfillPool {
  connect(): Promise<BackfillClient>;
}

export interface BackfillPluginConfigResult {
  table: "plugin_settings" | "workspace_plugins";
  scanned: number;
  updated: number;
  alreadyEncrypted: number;
  skipped: number;
}

/**
 * Coerce a DB-returned `config` value (whatever shape pg's JSONB parser
 * produced) into the Record<string, unknown> that encryptSecretFields
 * operates on. Null / non-object shapes are returned as null — the
 * backfill skips those rows (they'd be wiped by the fail-closed branch
 * otherwise, which is not what we want for pre-existing data).
 */
function asConfigRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  // String variant: pg drivers with JSONB text parser registered return
  // the raw JSON string. Parse before walking. Anything else (array,
  // scalar) is malformed — skip.
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // intentionally ignored: caller treats null as "skip this row"
    }
  }
  return null;
}

/**
 * Row-level short-circuit: true when every string value in `config` is
 * either empty or already `enc:v1:`. Skipping these rows keeps the
 * re-run cost low on carriers where fail-closed backfill has already
 * encrypted everything (`plugin_settings`). For `workspace_plugins`
 * under a parsed catalog schema, non-secret strings stay plaintext by
 * design, so this short-circuit only fires on rows with no non-secret
 * string values — a second run on such a row still invokes the walker,
 * which is a no-op on already-encrypted secret keys.
 */
function allStringsAreCiphertext(config: Record<string, unknown>): boolean {
  for (const value of Object.values(config)) {
    if (typeof value === "string" && value.length > 0 && !isEncryptedSecret(value)) {
      return false;
    }
  }
  return true;
}

/**
 * Backfill platform-wide plugin settings. No catalog schema is available
 * (the registry isn't loaded here); fall back to fail-closed mode which
 * encrypts every non-empty string. Tests cover the "mixed: non-secret
 * strings are over-encrypted" edge — operators accept that for the one-
 * time backfill because the admin UI rewrites the row under the real
 * schema on the next edit.
 */
export async function backfillPluginSettings(
  pool: BackfillPool,
): Promise<BackfillPluginConfigResult> {
  const client = await pool.connect();
  let caught: unknown;
  try {
    await client.query("BEGIN");

    const rows = (
      await client.query(`SELECT plugin_id, config FROM plugin_settings WHERE config IS NOT NULL`)
    ).rows as Array<{ plugin_id: string; config: unknown }>;

    const schema: ConfigSchema = { state: "corrupt", reason: "registry not loaded in backfill; encrypt every string" };
    let updated = 0;
    let alreadyEncrypted = 0;
    let skipped = 0;

    for (const row of rows) {
      const config = asConfigRecord(row.config);
      if (config === null) {
        skipped += 1;
        continue;
      }
      if (allStringsAreCiphertext(config)) {
        alreadyEncrypted += 1;
        continue;
      }
      const encrypted = encryptSecretFields(config, schema);
      await client.query(
        `UPDATE plugin_settings SET config = $1::jsonb, updated_at = now() WHERE plugin_id = $2`,
        [JSON.stringify(encrypted), row.plugin_id],
      );
      updated += 1;
    }

    await client.query("COMMIT");
    return { table: "plugin_settings", scanned: rows.length, updated, alreadyEncrypted, skipped };
  } catch (err) {
    caught = err;
    await client.query("ROLLBACK").catch(() => {
      // intentionally ignored: rollback failure is secondary; the
      // original error is what we surface.
    });
    throw err;
  } finally {
    client.release(caught instanceof Error ? caught : undefined);
  }
}

/**
 * Backfill per-workspace marketplace installs. Each row's catalog schema
 * is joined in so `encryptSecretFields` acts on the precise set of
 * `secret: true` keys, leaving operational fields (region, endpoint,
 * debug flags) readable as plain JSONB. A catalog row with a malformed
 * `config_schema` falls through `parseConfigSchema` as `state: "corrupt"`
 * and fail-closes to encrypting every string — matches the route-level
 * behavior so the on-disk shape after backfill is indistinguishable from
 * a fresh install under the same corrupt schema.
 */
export async function backfillWorkspacePlugins(
  pool: BackfillPool,
): Promise<BackfillPluginConfigResult> {
  const client = await pool.connect();
  let caught: unknown;
  try {
    await client.query("BEGIN");

    const rows = (
      await client.query(
        `SELECT wp.id, wp.config, pc.config_schema, pc.slug AS plugin_slug
         FROM workspace_plugins wp
         LEFT JOIN plugin_catalog pc ON pc.id = wp.catalog_id
         WHERE wp.config IS NOT NULL`,
      )
    ).rows as Array<{ id: string; config: unknown; config_schema: unknown; plugin_slug: string | null }>;

    let updated = 0;
    let alreadyEncrypted = 0;
    let skipped = 0;

    for (const row of rows) {
      const config = asConfigRecord(row.config);
      if (config === null) {
        skipped += 1;
        continue;
      }
      if (allStringsAreCiphertext(config)) {
        alreadyEncrypted += 1;
        continue;
      }
      const schema = parseConfigSchema(row.config_schema);
      if (schema.state === "corrupt") {
        log.warn(
          { installationId: row.id, slug: row.plugin_slug, reason: schema.reason },
          "Catalog config_schema unreadable — encrypting every string value defensively",
        );
      }
      const encrypted = encryptSecretFields(config, schema);
      await client.query(
        `UPDATE workspace_plugins SET config = $1::jsonb WHERE id = $2`,
        [JSON.stringify(encrypted), row.id],
      );
      updated += 1;
    }

    await client.query("COMMIT");
    return { table: "workspace_plugins", scanned: rows.length, updated, alreadyEncrypted, skipped };
  } catch (err) {
    caught = err;
    await client.query("ROLLBACK").catch(() => {
      // intentionally ignored: rollback failure is secondary.
    });
    throw err;
  } finally {
    client.release(caught instanceof Error ? caught : undefined);
  }
}

/** 32-bit stable key for `pg_advisory_lock` — distinct from F-41's. */
const LOCK_KEY = 0x1f42;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log.error("DATABASE_URL is not set — nothing to backfill");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    const settings = await backfillPluginSettings(pool);
    log.info(settings, "plugin_settings backfill complete");
    const workspace = await backfillWorkspacePlugins(pool);
    log.info(workspace, "workspace_plugins backfill complete");
    log.info(
      { grandTotal: settings.updated + workspace.updated },
      "F-42 plugin config backfill complete",
    );
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {
      // intentionally ignored: session teardown releases the lock anyway.
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
