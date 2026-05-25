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
  activeKeyVersion,
  getEncryptionKeyset,
} from "@atlas/api/lib/db/encryption-keys";
import {
  decryptSecret,
  encryptSecret,
  hasVersionedPrefix,
  type OpaqueSecret,
} from "@atlas/api/lib/db/secret-encryption";
import {
  INTEGRATION_TABLES,
  type IntegrationTable,
} from "@atlas/api/lib/db/integration-tables";

const log = createLogger("rotate-encryption-key");

// ---------------------------------------------------------------------------
// Table catalog
// ---------------------------------------------------------------------------

/**
 * A column whose ciphertext the rotation script should re-encrypt. Every
 * rotation target uses the `db/secret-encryption.ts` helper pair
 * (versioned-prefix-only `encryptSecret` / `decryptSecret`).
 *
 * Pre-1.5.3 the script also rotated `connections.url` via the URL-aware
 * `db/internal.ts` helper (with plaintext `postgres://…` first-time
 * encryption fallback). That table was dropped in 0096 / #2744 per
 * ADR-0007; datasource URLs now live inside `workspace_plugins.config`
 * JSONB and are not in scope for this column-oriented rotation pass.
 * The two remaining `db/internal.ts` consumers (`workspace_model_config`,
 * `sso_providers`) read identically through the versioned-prefix
 * decryptor — ciphertext format is shared across both helper pairs.
 */
type RotateTarget = IntegrationTable;

const ROTATION_TABLES: readonly RotateTarget[] = [
  { table: "workspace_model_config", pk: "id", encrypted: "api_key_encrypted", keyVersionColumn: "api_key_key_version" },
  // Derive from F-41's INTEGRATION_TABLES so adding a new integration
  // in one place covers rotation, audit, and any future column-walking
  // tooling — matches the "single source of truth" convention.
  ...INTEGRATION_TABLES,
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
 * Raised by `rotateValue` when the stored ciphertext does not carry the
 * `enc:v<N>:` prefix. Surfaces separately from the generic decrypt
 * failure path so the operator log distinguishes "dropped legacy key
 * from ATLAS_ENCRYPTION_KEYS" (orphaned) from "row never had a
 * prefix" (unprefixed — could be legitimate legacy plaintext, could be
 * a corrupted/truncated `enc:v<N>:` prefix). Both are refusals: the
 * script never silently re-encrypts an un-prefixed value, because a
 * corrupted prefix round-tripped through `decryptSecret`/`encryptSecret`
 * would emerge as ciphertext-of-the-broken-string with no way to
 * recover the original.
 */
export class UnprefixedSecretError extends Error {
  readonly _tag = "UnprefixedSecretError" as const;
  constructor() {
    super("Stored secret does not carry an enc:v<N>: prefix — rotation refused");
    this.name = "UnprefixedSecretError";
  }
}

/**
 * Decrypt the stored ciphertext (under whichever keyset entry its
 * prefix names) and re-encrypt with the active key. Returns an
 * `OpaqueSecret` brand. Throws on decryption failure (caller handles
 * orphan counting), and refuses to operate on values that don't carry
 * a `enc:v<N>:` prefix (`UnprefixedSecretError`).
 */
function rotateValue(stored: string): OpaqueSecret {
  if (!hasVersionedPrefix(stored)) throw new UnprefixedSecretError();
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
  /**
   * Rows whose ciphertext does not carry the `enc:v<N>:` prefix. Either
   * legitimate legacy plaintext predating F-47 OR a corrupted/truncated
   * prefix; either way the rotation script refuses to touch the row.
   * Operator must inspect and re-save the credential through the
   * admin UI (which writes a fresh `enc:v<active>:` value) before the
   * legacy key can be dropped.
   */
  unprefixed: number;
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
    let unprefixed = 0;
    for (const row of rows) {
      if (typeof row.encrypted !== "string" || row.encrypted.length === 0) {
        skippedEmpty += 1;
        continue;
      }
      let re: string;
      try {
        re = rotateValue(row.encrypted);
      } catch (err) {
        if (err instanceof UnprefixedSecretError) {
          // Un-prefixed: either legitimate legacy plaintext (predates F-47)
          // or a corrupted/truncated `enc:v<N>:` prefix. Distinct from
          // `orphaned` because the remediation differs — the operator
          // can't fix this by adding a legacy key back to the keyset;
          // they have to inspect the row and re-save through the admin
          // UI (which writes a fresh `enc:v<active>:` value).
          log.error(
            { table: target.table, pk: row.pk },
            "Row missing enc:v<N>: prefix — manual intervention required (re-save via admin UI)",
          );
          unprefixed += 1;
          continue;
        }
        // Orphan: the row's ciphertext references a key version that
        // isn't in the current keyset (or decryption failed outright).
        // The operator needs to add the legacy key back before we can
        // rotate this row. Tracked separately from `skippedEmpty` so
        // the final summary distinguishes "nothing to rotate" from
        // "partial-success rotation". main() exits non-zero on orphans.
        log.error(
          { table: target.table, pk: row.pk, err },
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
    return { table: target.table, scanned: rows.length, updated, skippedEmpty, orphaned, unprefixed };
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

/** 32-bit stable hash — distinct family from any prior backfill scripts */
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

    // Pre-flight: verify every table in ROTATION_TABLES actually exists
    // in the connected DB before we start mutating anything. Without
    // this, a stale `INTEGRATION_TABLES` entry (e.g. an integration
    // removed without dropping its table, or vice-versa) surfaces as a
    // raw `relation "x" does not exist` mid-loop — operator gets no
    // signal that prior tables already committed at the new key
    // version. Bail before BEGIN so partial-rotation is impossible.
    const missingTables: string[] = [];
    for (const target of ROTATION_TABLES) {
      const { rows } = await lockClient.query(
        "SELECT to_regclass($1) AS exists",
        [target.table],
      );
      if (rows[0]?.exists == null) missingTables.push(target.table);
    }
    if (missingTables.length > 0) {
      log.error(
        { missingTables, tableCount: ROTATION_TABLES.length },
        "Rotation aborted: ROTATION_TABLES references table(s) missing from the connected DB. " +
        "Either the migrations are out of date or INTEGRATION_TABLES is stale — investigate before rotating.",
      );
      process.exit(1);
    }

    let totalUpdated = 0;
    let totalSkippedEmpty = 0;
    let totalOrphaned = 0;
    let totalUnprefixed = 0;
    const failedTables: Array<{ table: string; err: unknown }> = [];
    for (const target of ROTATION_TABLES) {
      const client = await pool.connect();
      try {
        log.info({ table: target.table }, "rotate starting");
        const result = await rotateTable(client, target, active);
        totalUpdated += result.updated;
        totalSkippedEmpty += result.skippedEmpty;
        totalOrphaned += result.orphaned;
        totalUnprefixed += result.unprefixed;
        log.info(
          {
            table: result.table,
            scanned: result.scanned,
            updated: result.updated,
            skippedEmpty: result.skippedEmpty,
            orphaned: result.orphaned,
            unprefixed: result.unprefixed,
          },
          "rotate complete",
        );
      } catch (err) {
        // Per-table failure (rolled back inside rotateTable). Capture
        // and continue — do NOT propagate, because tables earlier in
        // the loop already committed at the new key version and the
        // operator needs the full picture (which tables landed, which
        // tables need a re-run). The accumulator + summary below makes
        // the partial-success state legible; without it the script
        // would exit with a single error line and no record of what
        // already succeeded.
        log.error(
          { table: target.table, err },
          "rotate failed for table — continuing with remaining tables; see summary below",
        );
        failedTables.push({ table: target.table, err });
      } finally {
        client.release();
      }
    }

    const partialFailure =
      totalOrphaned > 0 || totalUnprefixed > 0 || failedTables.length > 0;

    if (partialFailure) {
      // Loud summary-line error — the per-row log.errors above are easy
      // to miss in a long log tail. An operator walking the runbook
      // should not be able to exit this command and believe rotation
      // completed when in fact rows stayed at the legacy version (and
      // will 500 once the legacy key is dropped from the keyset).
      log.error(
        {
          active,
          totalUpdated,
          totalSkippedEmpty,
          totalOrphaned,
          totalUnprefixed,
          failedTableCount: failedTables.length,
          failedTables: failedTables.map((f) => f.table),
          tableCount: ROTATION_TABLES.length,
        },
        `Rotation finished with partial failure: ` +
        `${totalOrphaned} orphaned row(s), ${totalUnprefixed} un-prefixed row(s), ` +
        `${failedTables.length} failed table(s). ` +
        "Orphans: add the missing legacy key(s) back under the correct v<N>: label and re-run. " +
        "Un-prefixed: re-save through admin UI to write a fresh enc:v<active>: value. " +
        "Failed tables: see per-table error logs above; tables earlier in the loop already committed.",
      );
    } else {
      log.info(
        { active, totalUpdated, totalSkippedEmpty, tableCount: ROTATION_TABLES.length },
        "Rotation complete across all tables",
      );
    }
    if (partialFailure) {
      // Exit code 2 distinguishes "ran to completion with partial
      // failure" from exit 1 (script bailed early: no DATABASE_URL /
      // no keyset / pre-flight to_regclass found missing tables).
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
    // Pass `err` directly so pino's `err` serializer (logger.ts:185)
    // preserves the stack — a rotation failure may surface a deeply
    // nested pg error, and the stack is the primary debugging
    // artifact. Collapsing to `.message` here would drop it.
    log.error({ err }, "Rotation failed");
    process.exit(1);
  });
}
