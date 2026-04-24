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
 *
 * Not covered by this script (by design):
 *   • OIDC `sso_providers.config` — `clientSecret` is encrypted inside
 *     a JSONB blob with no companion `_key_version` column, so the
 *     column-oriented UPDATE pattern here doesn't apply. The ciphertext
 *     carries the `enc:v<N>:` prefix so it stays readable while the
 *     legacy key is in the keyset. Operators re-save OIDC configs via
 *     admin UI to re-encrypt them under the active key.
 *   • Integration tests against a seeded DB — this file's unit tests
 *     use a mock pg client to pin per-row behavior. An end-to-end test
 *     against the live migration + row fixtures is worthwhile future
 *     work, but not currently wired up.
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
import {
  TABLES as INTEGRATION_TABLES,
  type TableConfig,
} from "@atlas/api/lib/db/backfill-integration-credentials";

const log = createLogger("rotate-encryption-key");

// ---------------------------------------------------------------------------
// Table catalog
// ---------------------------------------------------------------------------

/**
 * A column whose ciphertext the rotation script should re-encrypt. The
 * shape overlaps with F-41's `TableConfig` — every field except
 * `plaintext` (which only matters for backfill) is identical — so we
 * reuse it and tack on a `kind` discriminator to pick the right cipher
 * helper pair:
 *
 *   `url`    → `encryptUrl` / `decryptUrl` (connection URL, with
 *              plaintext `postgres://…` fallback for pre-encryption
 *              rows)
 *   `secret` → `encryptSecret` / `decryptSecret` (every F-41
 *              integration column plus the workspace model-config API
 *              key, which historically used `encryptUrl` but reads
 *              identically now that both helpers share the versioned-
 *              keyset decryptor)
 */
type RotateTarget = Omit<TableConfig, "plaintext" | "kind"> & { kind: "url" | "secret" };

const ROTATION_TABLES: readonly RotateTarget[] = [
  { table: "connections", pk: "id", encrypted: "url", keyVersionColumn: "url_key_version", kind: "url" },
  { table: "workspace_model_config", pk: "id", encrypted: "api_key_encrypted", keyVersionColumn: "api_key_key_version", kind: "secret" },
  // Derive from F-41's INTEGRATION_TABLES so adding a new integration
  // in one place covers both backfill and rotation — matches the
  // "single source of truth" convention already used by F-41.
  ...INTEGRATION_TABLES.map((t): RotateTarget => ({
    table: t.table,
    pk: t.pk,
    encrypted: t.encrypted,
    keyVersionColumn: t.keyVersionColumn,
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
 * prefix names) and re-encrypt with the active key. Always returns a
 * new ciphertext string:
 *   • secret kind — decryptSecret passthrough for un-prefixed plaintext
 *     + re-encrypt under the active key
 *   • url kind — plaintext URLs (`postgres://…`) get encrypted for the
 *     first time; versioned/unversioned ciphertext is decrypted +
 *     re-encrypted
 * Rotation is a convenient moment to close out the pre-encryption
 * back-compat window, so plaintext rows land encrypted on the other
 * side. Throws on decryption failure (caller handles orphan counting).
 */
function rotateValue(kind: RotateTarget["kind"], stored: string): string {
  if (kind === "url") {
    if (isPlaintextUrl(stored)) {
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
  /** Rows where the encrypted column was empty / non-string (data drift, not a rotation problem). */
  skippedEmpty: number;
  /** Rows that failed to decrypt under the current keyset — operator misconfig (dropped legacy key). */
  orphaned: number;
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
  assertIdentifier(target.keyVersionColumn, "keyVersionColumn");

  try {
    await client.query("BEGIN");
    const rows = (
      await client.query(
        `SELECT ${target.pk} AS pk, ${target.encrypted} AS encrypted
         FROM ${target.table}
         WHERE ${target.encrypted} IS NOT NULL
           AND ${target.keyVersionColumn} < $1`,
        [activeVersion],
      )
    ).rows as Array<{ pk: string; encrypted: unknown }>;

    let updated = 0;
    let skippedEmpty = 0;
    let orphaned = 0;
    for (const row of rows) {
      if (typeof row.encrypted !== "string" || row.encrypted.length === 0) {
        skippedEmpty += 1;
        continue;
      }
      let re: string;
      try {
        re = rotateValue(target.kind, row.encrypted);
      } catch (err) {
        // Orphan: the row's ciphertext references a key version that
        // isn't in the current keyset (or decryption failed outright).
        // The operator needs to add the legacy key back before we can
        // rotate this row. Tracked separately from `skippedEmpty` so
        // the final summary distinguishes "nothing to rotate" from
        // "partial-success rotation". main() exits non-zero on orphans.
        log.error(
          {
            table: target.table,
            pk: row.pk,
            err: err instanceof Error ? err.message : String(err),
          },
          "Failed to rotate row — legacy key likely dropped from ATLAS_ENCRYPTION_KEYS",
        );
        orphaned += 1;
        continue;
      }
      await client.query(
        `UPDATE ${target.table}
         SET ${target.encrypted} = $1, ${target.keyVersionColumn} = $2
         WHERE ${target.pk} = $3`,
        [re, activeVersion, row.pk],
      );
      updated += 1;
    }

    await client.query("COMMIT");
    return { table: target.table, scanned: rows.length, updated, skippedEmpty, orphaned };
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
    let totalSkippedEmpty = 0;
    let totalOrphaned = 0;
    for (const target of ROTATION_TABLES) {
      const client = await pool.connect();
      try {
        log.info({ table: target.table }, "rotate starting");
        const result = await rotateTable(client, target, active);
        totalUpdated += result.updated;
        totalSkippedEmpty += result.skippedEmpty;
        totalOrphaned += result.orphaned;
        log.info(
          {
            table: result.table,
            scanned: result.scanned,
            updated: result.updated,
            skippedEmpty: result.skippedEmpty,
            orphaned: result.orphaned,
          },
          "rotate complete",
        );
      } finally {
        client.release();
      }
    }

    if (totalOrphaned > 0) {
      // Loud summary-line error — the per-row log.errors above are easy
      // to miss in a long log tail. An operator walking the runbook
      // should not be able to exit this command and believe rotation
      // completed when in fact `totalOrphaned` rows stayed at the
      // legacy version and will 500 when `#1832` drops the plaintext.
      log.error(
        { active, totalUpdated, totalSkippedEmpty, totalOrphaned, tableCount: ROTATION_TABLES.length },
        `Rotation finished with ${totalOrphaned} orphaned row(s) — their ciphertext references a key version ` +
        "missing from ATLAS_ENCRYPTION_KEYS. Add the legacy key(s) back under the correct v<N>: label and re-run.",
      );
    } else {
      log.info(
        { active, totalUpdated, totalSkippedEmpty, tableCount: ROTATION_TABLES.length },
        "Rotation complete across all tables",
      );
    }
    if (totalOrphaned > 0) {
      // Exit code 2 distinguishes "ran to completion with orphans" from
      // exit 1 (script bailed early: no DATABASE_URL / no keyset).
      process.exit(2);
    }
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
