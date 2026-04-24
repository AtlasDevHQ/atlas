/**
 * F-47 re-encryption script.
 *
 * Iterates every encrypted column in the internal database, decrypts
 * under whichever keyset entry the ciphertext carries, re-encrypts
 * under the active key, and stamps the companion `_key_version` column
 * with the new version.
 *
 * Idempotent via the `<col>_key_version < $active` guard — rows already
 * at the active version are skipped. Safe to run repeatedly.
 *
 * Usage:
 *   # Before: ATLAS_ENCRYPTION_KEYS carries the new key in position 0.
 *   bun run packages/api/scripts/rotate-encryption-key.ts
 *
 * The script expects `ATLAS_ENCRYPTION_KEYS` (or legacy single-key env
 * vars) to be set. See
 * `apps/docs/content/docs/platform-ops/encryption-key-rotation.mdx`
 * for the full rotation procedure.
 */

import { Pool, type PoolClient } from "pg";
import { createLogger } from "@atlas/api/lib/logger";
import {
  decryptUrl,
  encryptUrl,
  isPlaintextUrl,
} from "@atlas/api/lib/db/internal";
import {
  activeKeyVersion,
  getEncryptionKeyset,
} from "@atlas/api/lib/db/encryption-keys";
import {
  decryptSecret,
  encryptSecret,
} from "@atlas/api/lib/db/secret-encryption";
import { TABLES as INTEGRATION_TABLES } from "@atlas/api/lib/db/backfill-integration-credentials";

const log = createLogger("rotate-encryption-key");

// ---------------------------------------------------------------------------
// Table catalog
// ---------------------------------------------------------------------------

/** A column whose value is encrypted with `encryptSecret` (F-41 + model-config-style) or `encryptUrl` (connection URL). */
interface RotateTarget {
  table: string;
  pk: string;
  encrypted: string;
  keyVersion: string;
  /**
   * `url`: uses `encryptUrl` / `decryptUrl` (connection URL with
   * plaintext `postgres://…` fallback). `secret`: uses `encryptSecret`
   * / `decryptSecret` (every F-41 integration column plus the
   * workspace model-config API key, which was historically encrypted
   * via `encryptUrl` but reads identically because both helpers now
   * share the versioned-keyset decryptor).
   */
  kind: "url" | "secret";
}

const ROTATION_TABLES: readonly RotateTarget[] = [
  { table: "connections", pk: "id", encrypted: "url", keyVersion: "url_key_version", kind: "url" },
  { table: "workspace_model_config", pk: "id", encrypted: "api_key_encrypted", keyVersion: "api_key_key_version", kind: "secret" },
  ...INTEGRATION_TABLES.map((t): RotateTarget => ({
    table: t.table,
    pk: t.pk,
    encrypted: t.encrypted,
    keyVersion: t.keyVersion,
    kind: "secret",
  })),
];

// Parameterize table / column names into validated identifiers — we
// deliberately splice them into SQL because pg doesn't allow
// parameterized identifiers, and every name flows from the code
// catalog above (not from user input).
const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;
function assertIdentifier(name: string, role: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`Rotation ${role} ${JSON.stringify(name)} is not a valid SQL identifier`);
  }
}

// ---------------------------------------------------------------------------
// Per-row rotation
// ---------------------------------------------------------------------------

/**
 * Decrypt the stored ciphertext (under whichever keyset entry its
 * prefix names) and re-encrypt with the active key. Returns the new
 * ciphertext, or `null` when the row's stored value is already
 * plaintext (connection URLs only — `postgres://…` style).
 */
function rotateValue(kind: RotateTarget["kind"], stored: string): string | null {
  if (kind === "url") {
    if (isPlaintextUrl(stored)) {
      // Legacy plaintext connection URL. Encrypt it for the first time
      // under the active key — a rotation is a convenient moment to
      // close out the pre-encryption back-compat window.
      return encryptUrl(stored);
    }
    const decoded = decryptUrl(stored);
    return encryptUrl(decoded);
  }
  const decoded = decryptSecret(stored);
  return encryptSecret(decoded);
}

export interface RotateResult {
  table: string;
  scanned: number;
  updated: number;
  skipped: number;
}

/**
 * Re-encrypt every row in one table whose `_key_version < $active`.
 * Runs in a single transaction — mid-batch failure rolls back cleanly.
 */
export async function rotateTable(
  client: PoolClient,
  target: RotateTarget,
  activeVersion: number,
): Promise<RotateResult> {
  assertIdentifier(target.table, "table");
  assertIdentifier(target.pk, "pk");
  assertIdentifier(target.encrypted, "encrypted");
  assertIdentifier(target.keyVersion, "keyVersion");

  try {
    await client.query("BEGIN");
    const rows = (
      await client.query(
        `SELECT ${target.pk} AS pk, ${target.encrypted} AS encrypted
         FROM ${target.table}
         WHERE ${target.encrypted} IS NOT NULL
           AND ${target.keyVersion} < $1`,
        [activeVersion],
      )
    ).rows as Array<{ pk: string; encrypted: unknown }>;

    let updated = 0;
    let skipped = 0;
    for (const row of rows) {
      if (typeof row.encrypted !== "string" || row.encrypted.length === 0) {
        skipped += 1;
        continue;
      }
      let re: string | null;
      try {
        re = rotateValue(target.kind, row.encrypted);
      } catch (err) {
        // Leave the row alone and surface the error — operators need
        // to decide whether to drop the row or re-enter the credential.
        log.error(
          {
            table: target.table,
            pk: row.pk,
            err: err instanceof Error ? err.message : String(err),
          },
          "Failed to rotate row — leaving under legacy version",
        );
        skipped += 1;
        continue;
      }
      if (re === null) {
        skipped += 1;
        continue;
      }
      await client.query(
        `UPDATE ${target.table}
         SET ${target.encrypted} = $1, ${target.keyVersion} = $2
         WHERE ${target.pk} = $3`,
        [re, activeVersion, row.pk],
      );
      updated += 1;
    }

    await client.query("COMMIT");
    return { table: target.table, scanned: rows.length, updated, skipped };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Rollback failure is secondary — the original error is what matters.
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** 32-bit stable hash — same key family as `backfill-integration-credentials` */
const LOCK_KEY = 0x1f47; // arbitrary, stable across runs so concurrent operators block

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log.error("DATABASE_URL is not set — nothing to rotate");
    process.exit(1);
  }

  const keyset = getEncryptionKeyset();
  if (!keyset) {
    log.error(
      "ATLAS_ENCRYPTION_KEYS / ATLAS_ENCRYPTION_KEY / BETTER_AUTH_SECRET is not set — " +
      "cannot rotate against a missing keyset. Configure the new active key first.",
    );
    process.exit(1);
  }
  const active = activeKeyVersion();
  log.info({ active, sources: keyset.decrypt.map((k) => k.version) }, "Rotation starting");

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);

    let totalUpdated = 0;
    let totalSkipped = 0;
    for (const target of ROTATION_TABLES) {
      const client = await pool.connect();
      try {
        log.info({ table: target.table }, "rotate starting");
        const result = await rotateTable(client, target, active);
        totalUpdated += result.updated;
        totalSkipped += result.skipped;
        log.info(
          {
            table: result.table,
            scanned: result.scanned,
            updated: result.updated,
            skipped: result.skipped,
          },
          "rotate complete",
        );
      } finally {
        client.release();
      }
    }

    log.info(
      { active, totalUpdated, totalSkipped, tableCount: ROTATION_TABLES.length },
      "Rotation complete across all tables",
    );
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {
      // intentionally ignored: advisory unlock is best-effort; session
      // teardown below releases the lock regardless.
    });
    lockClient.release();
    await pool.end();
  }
}

// Run only when invoked directly — importing for tests must not trigger
// `main()` side effects.
if (import.meta.main) {
  main().catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "Rotation failed");
    process.exit(1);
  });
}
