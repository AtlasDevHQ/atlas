/**
 * F-47 re-encryption script.
 *
 * Two rotation shapes share the same operator entry point:
 *
 *   • **Column-oriented** — every F-41 `*_encrypted` column (Teams,
 *     Discord, Telegram, gchat, GitHub, Linear, WhatsApp, Email,
 *     Sandbox, sub-processor subscriptions, integration_credentials,
 *     Twenty CRM, workspace_model_config). One ciphertext per row,
 *     gated by a companion `_key_version` column for cheap idempotent
 *     re-runs (`WHERE <col>_key_version < $active`).
 *
 *   • **JSONB selective-field** — `workspace_plugins.config` post-#2744
 *     cutover. Datasource credentials and every other plugin secret
 *     (Linear api_key #2750, GitHub-PAT #2807, …) live inside the JSONB
 *     blob, with the catalog row's `config_schema` `secret: true` flag
 *     driving which fields to walk. No companion `_key_version` column
 *     — idempotence is gated per-field on the `enc:v<N>:` prefix.
 *
 * Safe to run repeatedly: both shapes skip rows that are already at the
 * active version.
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
 *     a JSONB blob keyed by a hand-rolled `clientSecret` field, not the
 *     catalog-driven selective-field walker. The ciphertext carries
 *     the `enc:v<N>:` prefix so it stays readable while the legacy key
 *     is in the keyset. Operators re-save OIDC configs via admin UI to
 *     re-encrypt them under the active key. A future generalization
 *     (`oidc-jsonb` target kind) would close this gap.
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
import { parseConfigSchema } from "@atlas/api/lib/plugins/secrets";

const log = createLogger("rotate-encryption-key");

// ---------------------------------------------------------------------------
// Table catalog
// ---------------------------------------------------------------------------

/**
 * Column-oriented rotation target — the F-41 shape. One encrypted
 * column per row, with a companion `_key_version` column used to gate
 * idempotent re-runs (`WHERE <col>_key_version < $active`).
 */
interface ColumnTarget extends IntegrationTable {
  readonly kind: "column";
}

/**
 * Selective-field-inside-JSONB rotation target — the post-#2744 shape.
 * `workspace_plugins.config` is a JSONB blob; the catalog row's
 * `config_schema` declares which fields are `secret: true`. Those
 * ciphertext values carry the `enc:v<N>:` prefix per field, and there
 * is no companion `_key_version` column — idempotence is gated on the
 * prefix itself (an `enc:v<N>:` value with N < active triggers
 * rotation; anything at the active version is a no-op).
 *
 * The JOIN against `plugin_catalog` makes the rotation generic across
 * every plugin install: datasource URLs (slice 5 / #2744), Linear
 * api_key (#2750), GitHub-PAT (#2807), and every future
 * selective-field secret all get covered by the same walk.
 */
interface JsonbSelectiveFieldTarget {
  readonly kind: "jsonb-selective-field";
  /** Table holding the JSONB column (`workspace_plugins`). */
  readonly table: string;
  /** Primary-key column used to scope per-row UPDATEs. */
  readonly pk: string;
  /** JSONB column carrying selective-field-encrypted secrets (`config`). */
  readonly jsonbColumn: string;
  /** FK column joining to the catalog table (`catalog_id`). */
  readonly catalogIdColumn: string;
  /** Catalog table (`plugin_catalog`). */
  readonly catalogTable: string;
  /** Catalog PK column referenced by `catalogIdColumn` (`id`). */
  readonly catalogPk: string;
  /** Catalog JSONB column carrying the per-plugin schema (`config_schema`). */
  readonly catalogSchemaColumn: string;
}

/**
 * A rotation target. Two shapes today (column / JSONB selective-field);
 * a third (`oidc-jsonb`) is plausible if `sso_providers.config.clientSecret`
 * ever needs to participate without a manual admin re-save.
 */
type RotateTarget = ColumnTarget | JsonbSelectiveFieldTarget;

const ROTATION_TABLES: readonly RotateTarget[] = [
  { kind: "column", table: "workspace_model_config", pk: "id", encrypted: "api_key_encrypted", keyVersionColumn: "api_key_key_version" },
  // Derive from F-41's INTEGRATION_TABLES so adding a new integration
  // in one place covers rotation, audit, and any future column-walking
  // tooling — matches the "single source of truth" convention.
  ...INTEGRATION_TABLES.map((t) => ({ kind: "column" as const, ...t })),
  // 0096 / #2744 — datasource credentials live inside this JSONB column
  // post-cutover. Coverage is generic via `plugin_catalog.config_schema`:
  // every future plugin install that flags a field `secret: true` is
  // rotated by the same walk (no per-integration entry needed here).
  {
    kind: "jsonb-selective-field",
    table: "workspace_plugins",
    pk: "id",
    jsonbColumn: "config",
    catalogIdColumn: "catalog_id",
    catalogTable: "plugin_catalog",
    catalogPk: "id",
    catalogSchemaColumn: "config_schema",
  },
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
 * Re-encrypt every row in one column-shaped table whose
 * `_key_version < $active`. Runs in a single transaction — mid-batch
 * failure rolls back cleanly.
 */
export async function rotateTable(
  client: PoolClient,
  target: ColumnTarget,
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
// JSONB selective-field rotation (workspace_plugins.config post-#2744)
// ---------------------------------------------------------------------------

/**
 * Capture the `<N>` from an `enc:v<N>:` prefix without buying into the
 * full body parse — cheap idempotence gate inside the per-field loop.
 * Production reads rely on `decryptSecret`'s parse; this regex stays
 * separate so a malformed body still routes through the orphan path
 * via the `decryptSecret` throw, not silently here.
 */
const VERSION_PREFIX_RE = /^enc:v(\d+):/;

/**
 * Re-encrypt every `secret: true` field inside a JSONB column whose
 * ciphertext is at a version below the active key. Catalog-driven —
 * the rotation set per row is determined by joining to `plugin_catalog`
 * and parsing `config_schema`, so a future plugin that declares a new
 * `secret: true` field is covered without code changes here.
 *
 * Row-level outcome accounting (matches `rotateTable` for symmetry):
 *
 *   • `updated`     — row had ≥1 secret field rotated, no errors. One
 *                     UPDATE issued with the merged JSONB.
 *   • `orphaned`    — row had ≥1 secret field whose ciphertext could not
 *                     be decrypted (legacy key missing from keyset). No
 *                     UPDATE issued for the row — partial rotation
 *                     would leave the row at mixed versions; safer to
 *                     refuse until the operator re-adds the legacy key.
 *   • `unprefixed`  — row had ≥1 non-empty secret field whose value
 *                     lacked the `enc:v<N>:` prefix. Either legacy
 *                     plaintext or corrupted prefix; both refuse
 *                     rotation. No UPDATE issued for the row.
 *   • `skippedEmpty` — row had no secret fields (schema absent, empty
 *                      catalog schema, or no secret-marked field had a
 *                      non-empty string value), or every secret field
 *                      was already at the active version. Idempotent
 *                      re-runs land all rows here.
 *
 * Worst-outcome wins per row: a row with both an orphan and a
 * rotatable field is counted as `orphaned` and not updated. Operator
 * fixes the keyset and re-runs to converge.
 *
 * Runs in a single transaction — mid-batch UPDATE failure rolls back.
 */
export async function rotateJsonbSelectiveField(
  client: PoolClient,
  target: JsonbSelectiveFieldTarget,
  activeVersion: number,
): Promise<RotateResult> {
  assertIdentifier(target.table, "table");
  assertIdentifier(target.pk, "pk");
  assertIdentifier(target.jsonbColumn, "jsonbColumn");
  assertIdentifier(target.catalogIdColumn, "catalogIdColumn");
  assertIdentifier(target.catalogTable, "catalogTable");
  assertIdentifier(target.catalogPk, "catalogPk");
  assertIdentifier(target.catalogSchemaColumn, "catalogSchemaColumn");

  try {
    await client.query("BEGIN");

    // No row-level filter analogous to `<col>_key_version < $active`
    // for column targets — the version is embedded per-field inside
    // the JSONB blob, so we walk every row and gate per-field below.
    // Bounded by workspace × installs (sub-100k in practice).
    const rows = (
      await client.query(
        `SELECT t.${target.pk} AS pk,
                t.${target.jsonbColumn} AS config,
                c.${target.catalogSchemaColumn} AS config_schema
           FROM ${target.table} t
           JOIN ${target.catalogTable} c
             ON c.${target.catalogPk} = t.${target.catalogIdColumn}`,
      )
    ).rows as Array<{ pk: string; config: unknown; config_schema: unknown }>;

    let updated = 0;
    let skippedEmpty = 0;
    let orphaned = 0;
    let unprefixed = 0;
    for (const row of rows) {
      // A drifted JSONB shape (non-object) gets skipped — same posture
      // as the masking / encryption walkers in `lib/plugins/secrets.ts`.
      if (row.config == null || typeof row.config !== "object" || Array.isArray(row.config)) {
        skippedEmpty += 1;
        continue;
      }
      const config = row.config as Record<string, unknown>;
      const schema = parseConfigSchema(row.config_schema);

      // Fields to walk. `corrupt` falls back to every string field —
      // mirrors `encryptSecretFields`' fail-closed posture. `absent`
      // / empty: nothing to rotate.
      const secretKeys = pickSecretKeysForRotation(schema, config);
      if (secretKeys.length === 0) {
        skippedEmpty += 1;
        continue;
      }

      const merged: Record<string, unknown> = { ...config };
      let rowUpdated = false;
      let rowOrphaned = false;
      let rowUnprefixed = false;

      for (const key of secretKeys) {
        const value = config[key];
        if (typeof value !== "string" || value.length === 0) continue;

        if (!hasVersionedPrefix(value)) {
          // Legacy plaintext or corrupted prefix. Refuse — same
          // reasoning as the column path's `unprefixed` counter.
          log.error(
            { table: target.table, pk: row.pk, field: key },
            "JSONB secret field missing enc:v<N>: prefix — manual intervention required",
          );
          rowUnprefixed = true;
          continue;
        }

        // Cheap idempotence: parse `enc:v<N>:` once, skip if N is
        // already active. Avoids a decrypt + re-encrypt round-trip on
        // already-rotated fields and lets the re-run walk be entirely
        // allocation-free for healthy rows.
        const versionMatch = value.match(VERSION_PREFIX_RE);
        if (versionMatch && Number.parseInt(versionMatch[1], 10) >= activeVersion) {
          continue;
        }

        try {
          merged[key] = encryptSecret(decryptSecret(value));
          rowUpdated = true;
        } catch (err) {
          log.error(
            { table: target.table, pk: row.pk, field: key, err },
            "Failed to rotate JSONB secret field — legacy key likely dropped from ATLAS_ENCRYPTION_KEYS",
          );
          rowOrphaned = true;
        }
      }

      // Worst-outcome wins per row. Orphan beats unprefixed beats
      // updated, because the remediation order matches: fix the
      // keyset first (orphan), then re-save through admin UI to clear
      // unprefixed fields, then re-run rotation to land updates.
      if (rowOrphaned) {
        orphaned += 1;
      } else if (rowUnprefixed) {
        unprefixed += 1;
      } else if (rowUpdated) {
        await client.query(
          `UPDATE ${target.table}
             SET ${target.jsonbColumn} = $1::jsonb
           WHERE ${target.pk} = $2`,
          [JSON.stringify(merged), row.pk],
        );
        updated += 1;
      } else {
        // Every secret field was already at the active version —
        // typical for idempotent re-runs.
        skippedEmpty += 1;
      }
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

/**
 * Resolve the set of config keys this rotation pass should walk. Mirrors
 * `encryptSecretFields` (`lib/plugins/secrets.ts`) so the rotation
 * surface and the write path can't drift apart:
 *
 *   • `absent` / `parsed` with no `secret: true` fields → empty (nothing
 *     to rotate; the row's config is entirely non-secret).
 *   • `parsed` with secret fields → those keys.
 *   • `corrupt` → every string-valued key in the config blob. Fail
 *     closed — the catalog schema is broken and we can't trust the
 *     `secret: true` flag, so rotate every string just like the write
 *     path encrypts every string.
 */
function pickSecretKeysForRotation(
  schema: ReturnType<typeof parseConfigSchema>,
  config: Record<string, unknown>,
): string[] {
  if (schema.state === "corrupt") {
    // Every string field — broad but matches the write path's
    // fail-closed encrypt-every-string behavior.
    return Object.keys(config).filter((k) => typeof config[k] === "string");
  }
  if (schema.state === "absent" || schema.fields.length === 0) return [];
  return schema.fields.filter((f) => f.secret === true).map((f) => f.key);
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
        log.info({ table: target.table, kind: target.kind }, "rotate starting");
        const result =
          target.kind === "column"
            ? await rotateTable(client, target, active)
            : await rotateJsonbSelectiveField(client, target, active);
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
