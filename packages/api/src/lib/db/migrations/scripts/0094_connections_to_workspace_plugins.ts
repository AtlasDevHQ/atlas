/**
 * Sanity-check harness for migration `0094_drop_connections_table.sql`.
 *
 * Accompanies the 1.5.3 cutover (#2744 / PRD #2738 / ADR-0007). The
 * migration itself does all structural work + the SQL-only backfill —
 * see the migration header for why no in-band TS re-encryption is
 * needed (the URL ciphertext format is identical between the two
 * encryption modules, so the copy is bit-exact).
 *
 * This script runs AFTER the migration has applied and verifies, on
 * the production deploy target, that:
 *   1. Every migrated `workspace_plugins` row (pillar='datasource',
 *      install_id != '__demo__') has a `config->>'url'` that
 *      decrypts cleanly via `decryptSecretFields` keyed off the
 *      catalog row's `config_schema`.
 *   2. The decrypted URL matches the expected scheme for the row's
 *      `config->>'db_type'`.
 *   3. Every `organization` row has a `demo-postgres` install (the
 *      auto_install backfill from step 3 of the migration).
 *
 * Read-only: never writes. A failure here means the migration's SQL
 * backfill produced an unreadable row — surface as a release-blocker.
 *
 * The script is named after the migration it accompanies; the prod-run
 * date is recorded in the deploy runbook (see #2744 PR description).
 *
 * Invocation:
 *   DATABASE_URL=... bun run packages/api/src/lib/db/migrations/scripts/0094_connections_to_workspace_plugins.ts
 *   DRY_RUN=1 ...  (print counts only; default behaviour is identical because the script never writes)
 *
 * Prod-run dates:
 *   - dogfood:   <pending — record on PR merge>
 *   - atlas-prod: <pending — record on PR merge>
 */

import { Client } from "pg";
import { decryptSecretFields, parseConfigSchema } from "@atlas/api/lib/plugins/secrets";

const DRY_RUN = process.env.DRY_RUN === "1";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

interface VerificationStats {
  datasourceInstalls: number;
  demoInstalls: number;
  orgs: number;
  decryptFailures: number;
  schemeMismatches: number;
  orgsMissingDemo: number;
}

async function verify(): Promise<VerificationStats> {
  const url = requireEnv("DATABASE_URL");
  const client = new Client({ connectionString: url });
  await client.connect();

  const stats: VerificationStats = {
    datasourceInstalls: 0,
    demoInstalls: 0,
    orgs: 0,
    decryptFailures: 0,
    schemeMismatches: 0,
    orgsMissingDemo: 0,
  };

  try {
    // Sanity: required tables exist post-migration.
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('workspace_plugins', 'plugin_catalog', 'organization', 'connections', 'connection_groups')`,
    );
    const present = new Set(tables.rows.map((r) => r.table_name));
    if (!present.has("workspace_plugins") || !present.has("plugin_catalog") || !present.has("organization")) {
      throw new Error(
        `Required tables missing — wrong DB? found: ${[...present].join(", ") || "(none)"}`,
      );
    }
    if (present.has("connections") || present.has("connection_groups")) {
      throw new Error(
        "Migration 0094 has not run — `connections` and/or `connection_groups` still exist. " +
          "Run `bun run db:migrate` first, then re-run this script.",
      );
    }

    // 1. Every datasource install (excluding demo) round-trips through
    //    `decryptSecretFields` cleanly.
    const installs = await client.query<{
      workspace_id: string;
      install_id: string;
      catalog_slug: string;
      config: Record<string, unknown>;
      config_schema: unknown;
    }>(
      `SELECT wp.workspace_id, wp.install_id, pc.slug AS catalog_slug,
              wp.config, pc.config_schema
         FROM workspace_plugins wp
         JOIN plugin_catalog pc ON pc.id = wp.catalog_id
        WHERE wp.pillar = 'datasource'
          AND wp.install_id != '__demo__'`,
    );

    stats.datasourceInstalls = installs.rows.length;

    for (const row of installs.rows) {
      const schema = parseConfigSchema(row.config_schema);
      try {
        const decrypted = decryptSecretFields(row.config, schema);
        const url = typeof decrypted.url === "string" ? decrypted.url : "";
        const dbType = typeof row.config.db_type === "string" ? row.config.db_type : "";

        // Cheap scheme sanity check — catches "ciphertext interpreted as
        // plaintext URL" + "wrong-catalog dispatch landed an unmatched
        // dbType into the wrong slug" in one pass. Demo + Salesforce +
        // BigQuery + DuckDB don't ship URLs so they're skipped.
        if (dbType === "postgres" && url && !url.startsWith("postgres")) {
          stats.schemeMismatches++;
          console.error(
            `[scheme-mismatch] workspace=${row.workspace_id} install=${row.install_id} ` +
              `expected postgres:// or postgresql:// scheme, got: ${url.slice(0, 24)}…`,
          );
        } else if (dbType === "mysql" && url && !url.startsWith("mysql")) {
          stats.schemeMismatches++;
          console.error(
            `[scheme-mismatch] workspace=${row.workspace_id} install=${row.install_id} ` +
              `expected mysql:// scheme, got: ${url.slice(0, 24)}…`,
          );
        }
      } catch (err) {
        stats.decryptFailures++;
        console.error(
          `[decrypt-failed] workspace=${row.workspace_id} install=${row.install_id} ` +
            `catalog=${row.catalog_slug}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 2. Every organization has a `demo-postgres` install (auto_install).
    const demoRows = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM workspace_plugins wp
         JOIN plugin_catalog pc ON pc.id = wp.catalog_id
        WHERE wp.pillar = 'datasource'
          AND pc.slug = 'demo-postgres'`,
    );
    stats.demoInstalls = Number(demoRows.rows[0]?.count ?? 0);

    const orgRows = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM organization`);
    stats.orgs = Number(orgRows.rows[0]?.count ?? 0);

    const missingDemo = await client.query<{ id: string }>(
      `SELECT o.id
         FROM organization o
        WHERE NOT EXISTS (
          SELECT 1 FROM workspace_plugins wp
           JOIN plugin_catalog pc ON pc.id = wp.catalog_id
          WHERE wp.workspace_id = o.id
            AND wp.pillar = 'datasource'
            AND pc.slug = 'demo-postgres'
        )`,
    );
    stats.orgsMissingDemo = missingDemo.rows.length;
    if (stats.orgsMissingDemo > 0) {
      for (const r of missingDemo.rows.slice(0, 10)) {
        console.error(`[missing-demo] org=${r.id} has no demo-postgres install row`);
      }
      if (missingDemo.rows.length > 10) {
        console.error(`[missing-demo] … and ${missingDemo.rows.length - 10} more`);
      }
    }
  } finally {
    await client.end();
  }

  return stats;
}

async function main(): Promise<void> {
  const mode = DRY_RUN ? "DRY_RUN" : "VERIFY";
  console.log(`[0094-verify] running in ${mode} mode`);
  const stats = await verify();
  console.log(`[0094-verify] datasource installs:       ${stats.datasourceInstalls}`);
  console.log(`[0094-verify] demo installs:             ${stats.demoInstalls}`);
  console.log(`[0094-verify] organizations:             ${stats.orgs}`);
  console.log(`[0094-verify] decrypt failures:          ${stats.decryptFailures}`);
  console.log(`[0094-verify] scheme mismatches:         ${stats.schemeMismatches}`);
  console.log(`[0094-verify] orgs missing demo install: ${stats.orgsMissingDemo}`);

  const failed =
    stats.decryptFailures > 0 || stats.schemeMismatches > 0 || stats.orgsMissingDemo > 0;
  if (failed) {
    console.error(`[0094-verify] FAILED — migration produced unreadable or incomplete state`);
    process.exit(1);
  }
  console.log(`[0094-verify] OK`);
}

main().catch((err) => {
  console.error("[0094-verify] script crashed:", err);
  process.exit(1);
});
