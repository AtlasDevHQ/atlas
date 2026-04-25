/**
 * F-42 plaintext-residue audit script (#1835).
 *
 * Read-only walk over the at-rest secret surface that scans for any
 * `secret: true` field whose value is NOT prefixed `enc:v<N>:` and any
 * F-41 integration row whose encrypted column is missing. Surfaces
 * residue as machine-readable output so the operator pre-flight against
 * US/EU/APAC has a clean exit-code contract.
 *
 *   exit 0 — no residue. Output is a single JSON line with row counts +
 *            secret-field counts + tables scanned.
 *   exit 2 — residue found. Output is a single JSON line with row IDs
 *            (NOT values) per affected table/key.
 *   exit 1 — script failure (DB connection, unexpected error). The
 *            error message is logged via pino.
 *
 * Usage:
 *   bun run packages/api/scripts/audit-plugin-config-residue.ts
 *
 * The script is read-only — no UPDATE / DELETE statements, no implicit
 * transactions. Safe to run against a production replica.
 *
 * Coverage (matches F-41 + F-42 surface):
 *   • F-41: `INTEGRATION_TABLES` — assert the encrypted column is
 *     populated per row when the table's invariant is "always
 *     populated" (everything except admin-consent Teams + OAuth-only
 *     Discord). Asserts ciphertext shape (`enc:v<N>:`) when present.
 *   • F-42: `plugin_settings.config` and `workspace_plugins.config` —
 *     join with `plugin_catalog.config_schema` to identify per-row
 *     `secret: true` fields, then assert each carries `enc:v<N>:`.
 *     Falls back to "every non-empty string is suspicious" when the
 *     catalog row is missing — mirrors the encryptor's fail-closed
 *     branch so the audit doesn't under-report under schema drift.
 *
 * Closes: F-42 audit row in `.claude/research/security-audit-1-2-3.md`.
 */

import { Pool } from "pg";
import { createLogger } from "@atlas/api/lib/logger";
import { INTEGRATION_TABLES, NON_NULL_ENCRYPTED_TABLES } from "@atlas/api/lib/db/integration-tables";
import { parseConfigSchema, type ConfigSchema } from "@atlas/api/lib/plugins/secrets";

const log = createLogger("audit-residue");

const ENCRYPTED_PREFIX_RE = /^enc:v\d+:/;

/**
 * One residue finding — a single row carrying a value the audit would
 * have rejected. The shape is row-IDs-only by design: per the F-42
 * issue, residue logs MUST NOT carry the offending values, only the
 * locator. Operators pivot from `id` to a manual investigation.
 */
export interface ResidueFinding {
  table: string;
  /**
   * For integration tables: the primary-key column's value. For plugin
   * config rows: `plugin_settings.id` or `workspace_plugins.id`.
   */
  rowId: string;
  /**
   * Why this row is flagged. `missing_encrypted_column` covers F-41
   * residue (the post-#1832 invariant); the remaining variants cover
   * F-42:
   *   • `plaintext_secret_field` — schema parsed, key marked `secret: true`
   *     in the catalog, value is plaintext.
   *   • `plaintext_string_under_corrupt_schema` — catalog row exists but
   *     `config_schema` is malformed; fail-closed scan flags every
   *     non-empty plaintext string (we can't tell which keys are secret).
   *   • `plaintext_string_orphan_row` — `plugin_settings` row whose
   *     `plugin_catalog` row was deleted post-install. Same fail-closed
   *     policy as `corrupt`, but tagged distinctly so operators can
   *     diagnose the upstream cause (catalog deletion vs schema drift).
   */
  reason:
    | "missing_encrypted_column"
    | "plaintext_secret_field"
    | "plaintext_string_under_corrupt_schema"
    | "plaintext_string_orphan_row";
  /**
   * For F-42: which JSONB key carries the suspicious value. Omitted for
   * F-41 column-level findings.
   */
  key?: string;
}

export interface AuditReport {
  ok: boolean;
  scanned: {
    integrationRows: number;
    pluginSettingsRows: number;
    workspacePluginsRows: number;
    secretFieldsVerified: number;
  };
  findings: ResidueFinding[];
}

interface AuditClient {
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;
function assertIdentifier(name: string, role: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`Audit ${role} ${JSON.stringify(name)} is not a valid SQL identifier`);
  }
}

// ---------------------------------------------------------------------------
// F-41 integration-table sweep
// ---------------------------------------------------------------------------

/**
 * Scan one integration table for residue. Two checks per row:
 *
 *   1. If the table is in `NON_NULL_ENCRYPTED_TABLES`, the encrypted
 *      column must be a non-empty string. The 0040 migration tightened
 *      it to NOT NULL — a NULL here means a bypass or a botched
 *      pre-flight, not a normal install state.
 *
 *   2. The value (when present) must carry the `enc:v<N>:` prefix.
 *      A bare plaintext value would slip past at-rest encryption.
 */
export async function auditIntegrationTable(
  client: AuditClient,
  table: { table: string; pk: string; encrypted: string },
  enforceNotNull: boolean,
): Promise<{ scanned: number; findings: ResidueFinding[] }> {
  assertIdentifier(table.table, "table");
  assertIdentifier(table.pk, "pk");
  assertIdentifier(table.encrypted, "encrypted column");

  const result = await client.query<Record<string, unknown>>(
    `SELECT ${table.pk} AS id, ${table.encrypted} AS encrypted FROM ${table.table}`,
  );

  const findings: ResidueFinding[] = [];
  for (const row of result.rows) {
    const id = String(row.id);
    const encrypted = row.encrypted;
    const isMissing = encrypted === null || encrypted === undefined ||
      (typeof encrypted === "string" && encrypted.length === 0);
    if (isMissing) {
      if (enforceNotNull) {
        findings.push({ table: table.table, rowId: id, reason: "missing_encrypted_column" });
      }
      continue;
    }
    if (typeof encrypted !== "string" || !ENCRYPTED_PREFIX_RE.test(encrypted)) {
      findings.push({ table: table.table, rowId: id, reason: "plaintext_secret_field" });
    }
  }

  return { scanned: result.rows.length, findings };
}

// ---------------------------------------------------------------------------
// F-42 plugin-config JSONB sweep
// ---------------------------------------------------------------------------

interface PluginSettingsRow extends Record<string, unknown> {
  id: string;
  config: Record<string, unknown> | null;
  config_schema: unknown;
  orphan: boolean;
}

interface WorkspacePluginRow extends Record<string, unknown> {
  id: string;
  config: Record<string, unknown> | null;
  config_schema: unknown;
  orphan: boolean;
}

/**
 * For one plugin-config row, walk every key and emit a finding when:
 *
 *   • the schema is parsed and the key is `secret: true` but the value
 *     is a non-empty string lacking the `enc:v<N>:` prefix; or
 *   • the schema is corrupt — fail-closed: every non-empty string value
 *     looks like a secret residue. Matches the encryptor's policy in
 *     `secrets.ts::encryptSecretFields`.
 *   • the catalog row is missing entirely (`isOrphan` true) — same
 *     fail-closed treatment as `corrupt`. The audit cannot prove a
 *     missing-catalog row's pre-existing secrets were encrypted, and
 *     LEFT JOIN'ing past a deleted catalog row would otherwise let
 *     plaintext residue pass silently. Tag the reason
 *     `plaintext_string_orphan_row` so operators can distinguish a
 *     malformed schema from an outright catalog deletion.
 *
 * Returns the finding count plus the count of secret-typed values that
 * were verified clean (used in the success-path JSON for ops triage).
 */
function auditPluginConfigRow(
  table: string,
  rowId: string,
  config: Record<string, unknown> | null,
  schema: ConfigSchema,
  isOrphan: boolean,
): { findings: ResidueFinding[]; secretFieldsVerified: number } {
  if (config == null || typeof config !== "object" || Array.isArray(config)) {
    return { findings: [], secretFieldsVerified: 0 };
  }

  const findings: ResidueFinding[] = [];
  let secretFieldsVerified = 0;

  // Fail-closed for orphans (catalog row deleted post-install): we can't
  // prove which keys are secret, so every non-empty plaintext string is
  // suspicious. Same policy as the corrupt-schema branch.
  if (isOrphan || schema.state === "corrupt") {
    const reason: ResidueFinding["reason"] = isOrphan
      ? "plaintext_string_orphan_row"
      : "plaintext_string_under_corrupt_schema";
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === "string" && value.length > 0 && !ENCRYPTED_PREFIX_RE.test(value)) {
        findings.push({ table, rowId, reason, key });
      }
    }
    return { findings, secretFieldsVerified };
  }

  if (schema.state === "absent" || schema.fields.length === 0) {
    return { findings, secretFieldsVerified };
  }

  const secretKeys = new Set(
    schema.fields.filter((f) => f.secret === true).map((f) => f.key),
  );
  for (const [key, value] of Object.entries(config)) {
    if (!secretKeys.has(key)) continue;
    if (typeof value !== "string" || value.length === 0) continue;
    if (ENCRYPTED_PREFIX_RE.test(value)) {
      secretFieldsVerified += 1;
    } else {
      findings.push({ table, rowId, reason: "plaintext_secret_field", key });
    }
  }
  return { findings, secretFieldsVerified };
}

export async function auditPluginSettings(
  client: AuditClient,
): Promise<{ scanned: number; secretFieldsVerified: number; findings: ResidueFinding[] }> {
  // `plugin_settings` is keyed by `plugin_id` (the registry key). The
  // catalog join keys on `slug` because there's no FK — `plugin_settings`
  // predates the catalog. The `pc.id IS NULL` projection lets us
  // distinguish a catalog-orphaned row (catalog deleted, settings row
  // survives) from a row whose catalog is genuinely there but carries
  // no schema. The audit fail-closes orphans rather than skipping them,
  // because an orphaned plugin_settings row could legitimately carry
  // plaintext secrets from a pre-encryption era and the catalog row was
  // the only signal pointing at which fields are sensitive.
  const result = await client.query<PluginSettingsRow>(
    `SELECT ps.plugin_id AS id, ps.config, pc.config_schema, (pc.id IS NULL)::boolean AS orphan
     FROM plugin_settings ps
     LEFT JOIN plugin_catalog pc ON pc.slug = ps.plugin_id`,
  );

  const findings: ResidueFinding[] = [];
  let secretFieldsVerified = 0;
  for (const row of result.rows) {
    const schema = parseConfigSchema(row.config_schema);
    const subResult = auditPluginConfigRow(
      "plugin_settings",
      row.id,
      row.config,
      schema,
      row.orphan === true,
    );
    findings.push(...subResult.findings);
    secretFieldsVerified += subResult.secretFieldsVerified;
  }
  return { scanned: result.rows.length, secretFieldsVerified, findings };
}

export async function auditWorkspacePlugins(
  client: AuditClient,
): Promise<{ scanned: number; secretFieldsVerified: number; findings: ResidueFinding[] }> {
  // `workspace_plugins` has an FK to `plugin_catalog` so an orphan is
  // structurally impossible today. We still project `pc.id IS NULL` for
  // symmetry with `auditPluginSettings` — if the FK ever gets relaxed
  // or a row is bulk-loaded out of band, the orphan branch catches it.
  const result = await client.query<WorkspacePluginRow>(
    `SELECT wp.id, wp.config, pc.config_schema, (pc.id IS NULL)::boolean AS orphan
     FROM workspace_plugins wp
     LEFT JOIN plugin_catalog pc ON pc.id = wp.catalog_id`,
  );

  const findings: ResidueFinding[] = [];
  let secretFieldsVerified = 0;
  for (const row of result.rows) {
    const schema = parseConfigSchema(row.config_schema);
    const subResult = auditPluginConfigRow(
      "workspace_plugins",
      row.id,
      row.config,
      schema,
      row.orphan === true,
    );
    findings.push(...subResult.findings);
    secretFieldsVerified += subResult.secretFieldsVerified;
  }
  return { scanned: result.rows.length, secretFieldsVerified, findings };
}

// ---------------------------------------------------------------------------
// Top-level audit driver
// ---------------------------------------------------------------------------

/**
 * Runs every check above against the supplied client. Returned report
 * is the same shape main() emits — exposed for unit tests to drive the
 * function with a mock pg client without spawning the script.
 */
export async function runAudit(client: AuditClient): Promise<AuditReport> {
  const findings: ResidueFinding[] = [];
  let integrationRows = 0;

  const enforceSet = new Set(NON_NULL_ENCRYPTED_TABLES.map((t) => t.table));
  for (const table of INTEGRATION_TABLES) {
    const { scanned, findings: tableFindings } = await auditIntegrationTable(
      client,
      table,
      enforceSet.has(table.table),
    );
    integrationRows += scanned;
    findings.push(...tableFindings);
  }

  const settings = await auditPluginSettings(client);
  const workspace = await auditWorkspacePlugins(client);
  findings.push(...settings.findings, ...workspace.findings);

  return {
    ok: findings.length === 0,
    scanned: {
      integrationRows,
      pluginSettingsRows: settings.scanned,
      workspacePluginsRows: workspace.scanned,
      secretFieldsVerified: settings.secretFieldsVerified + workspace.secretFieldsVerified,
    },
    findings,
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log.error("DATABASE_URL is not set — nothing to audit");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  // Compute the exit code, await pool teardown, THEN exit. The previous
  // shape (`process.exit()` inside the try with `pool.end()` in
  // finally) raced the kernel-level socket teardown against the
  // exit() — fine in practice but produces sporadic "client has
  // already ended" diagnostics in CI runners that pipe output through
  // a subsequent invocation.
  let exitCode: number;
  try {
    const report = await runAudit(pool);
    // Single-line JSON output keeps `bun run … | jq` clean and the CI
    // wrapper that runs this script across regions can simply diff.
    process.stdout.write(`${JSON.stringify(report)}\n`);
    exitCode = report.ok ? 0 : 2;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Plugin-config residue audit failed",
    );
    exitCode = 1;
  }
  await pool.end();
  process.exit(exitCode);
}

if (import.meta.main) {
  main().catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "Audit threw");
    process.exit(1);
  });
}
