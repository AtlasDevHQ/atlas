/**
 * Sanity-check harness for migration `0096_drop_connections_table.sql`.
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
 * date is recorded in the deploy runbook (see the #2744 PR description's
 * "Dogfood ✅" section).
 *
 * Invocation:
 *   DATABASE_URL=... bun run packages/api/src/lib/db/migrations/scripts/0096_connections_to_workspace_plugins.ts
 *   DRY_RUN=1 ...  (print counts only; default behaviour is identical because the script never writes)
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
  /** Rows whose db_type isn't in the documented skip set or the
   *  postgres/mysql native pair — likely legacy or drift. */
  unknownDbType: number;
  /** Rows whose decrypted URL is the empty string — silent data
   *  corruption that the original scheme check would short-circuit on. */
  emptyUrls: number;
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
    unknownDbType: 0,
    emptyUrls: 0,
  };
  // db_types that the scheme check intentionally skips (no URL, or
  // plugin-managed). Listed here so unknown types fail loud rather
  // than silently passing.
  const NO_URL_DB_TYPES = new Set(["bigquery", "duckdb", "salesforce", "demo-postgres"]);
  const NATIVE_DB_TYPES = new Set(["postgres", "mysql"]);
  const PLUGIN_URL_DB_TYPES = new Set(["snowflake", "clickhouse"]);

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
        "Migration 0096 has not run — `connections` and/or `connection_groups` still exist. " +
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
      try {
        // parseConfigSchema can throw on malformed catalog JSON — keep
        // it inside the per-row try so one bad row doesn't kill the loop.
        const schema = parseConfigSchema(row.config_schema);
        const decrypted = decryptSecretFields(row.config, schema);
        const url = typeof decrypted.url === "string" ? decrypted.url : "";
        const dbType = typeof row.config.db_type === "string" ? row.config.db_type : "";

        // Cheap scheme sanity check. Native (postgres/mysql) requires a
        // matching scheme; plugin URL types (snowflake/clickhouse) only
        // need a non-empty URL; no-URL types pass through. Any db_type
        // outside these sets fails loudly so a legacy `"pg"` from the
        // pre-cutover `connections.type` column surfaces.
        if (NATIVE_DB_TYPES.has(dbType)) {
          if (!url) {
            stats.emptyUrls++;
            console.error(
              `[empty-url] workspace=${row.workspace_id} install=${row.install_id} dbType=${dbType} — decrypted URL is empty`,
            );
          } else if (dbType === "postgres" && !url.startsWith("postgres")) {
            stats.schemeMismatches++;
            console.error(
              `[scheme-mismatch] workspace=${row.workspace_id} install=${row.install_id} ` +
                `expected postgres:// or postgresql:// scheme, got: ${url.slice(0, 24)}…`,
            );
          } else if (dbType === "mysql" && !url.startsWith("mysql")) {
            stats.schemeMismatches++;
            console.error(
              `[scheme-mismatch] workspace=${row.workspace_id} install=${row.install_id} ` +
                `expected mysql:// scheme, got: ${url.slice(0, 24)}…`,
            );
          }
        } else if (PLUGIN_URL_DB_TYPES.has(dbType)) {
          if (!url) {
            stats.emptyUrls++;
            console.error(
              `[empty-url] workspace=${row.workspace_id} install=${row.install_id} dbType=${dbType} — decrypted URL is empty`,
            );
          }
        } else if (!NO_URL_DB_TYPES.has(dbType)) {
          stats.unknownDbType++;
          console.error(
            `[unknown-db-type] workspace=${row.workspace_id} install=${row.install_id} ` +
              `catalog=${row.catalog_slug} db_type=${JSON.stringify(dbType)} — not in known set`,
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
  console.log(`[0096-verify] running in ${mode} mode`);
  const stats = await verify();
  console.log(`[0096-verify] datasource installs:       ${stats.datasourceInstalls}`);
  console.log(`[0096-verify] demo installs:             ${stats.demoInstalls}`);
  console.log(`[0096-verify] organizations:             ${stats.orgs}`);
  console.log(`[0096-verify] decrypt failures:          ${stats.decryptFailures}`);
  console.log(`[0096-verify] scheme mismatches:         ${stats.schemeMismatches}`);
  console.log(`[0096-verify] empty decrypted URLs:      ${stats.emptyUrls}`);
  console.log(`[0096-verify] unknown db_types:          ${stats.unknownDbType}`);
  console.log(`[0096-verify] orgs missing demo install: ${stats.orgsMissingDemo}`);

  // Positive lower bound — "wrong cluster, 0 rows, all green" is a real
  // failure mode the operator should never get past. If the deploy
  // target genuinely has zero orgs (e.g. a brand-new tenant DB), pass
  // `ALLOW_EMPTY=1` to override.
  if (stats.orgs === 0 && process.env.ALLOW_EMPTY !== "1") {
    console.error(
      `[0096-verify] FAILED — found 0 organizations. ` +
        `Either DATABASE_URL points at the wrong cluster, or this DB is genuinely empty (pass ALLOW_EMPTY=1 to confirm).`,
    );
    process.exit(1);
  }
  if (
    stats.datasourceInstalls + stats.demoInstalls === 0 &&
    process.env.ALLOW_EMPTY !== "1"
  ) {
    console.error(
      `[0096-verify] FAILED — found 0 datasource installs across ${stats.orgs} org(s). ` +
        `Migration 0096 likely hasn't run on this DB (pass ALLOW_EMPTY=1 to confirm).`,
    );
    process.exit(1);
  }

  const failed =
    stats.decryptFailures > 0 ||
    stats.schemeMismatches > 0 ||
    stats.emptyUrls > 0 ||
    stats.unknownDbType > 0 ||
    stats.orgsMissingDemo > 0;
  if (failed) {
    console.error(`[0096-verify] FAILED — migration produced unreadable or incomplete state`);
    process.exit(1);
  }
  console.log(`[0096-verify] OK`);
}

main().catch((err) => {
  console.error("[0096-verify] script crashed:", err);
  process.exit(1);
});
