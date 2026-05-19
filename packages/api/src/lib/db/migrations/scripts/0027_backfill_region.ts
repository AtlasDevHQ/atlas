/**
 * One-shot backfill — fills `organization.region` on the EU and APAC regional
 * Postgres clusters. Accompanies migration 0027_organization_saas_columns.sql
 * which adds the `region` column with a NULL default.
 *
 * Each regional cluster holds only orgs that live in that region (data-residency
 * split), so `WHERE region IS NULL` unambiguously targets the unbackfilled rows.
 * Includes a residency-drift guard that aborts when a region's DB already has
 * rows tagged with a different `region` value — that would mean cross-region
 * data and we shouldn't blindly stamp the label.
 *
 * Status: applied on prod 2026-05-12 (EU + APAC). Re-runs are idempotent.
 *
 * Invocation:
 *   EU_INT_DB_URL=... APAC_INT_DB_URL=... bun run packages/api/src/lib/db/migrations/scripts/0027_backfill_region.ts
 *   DRY_RUN=1 ... (counts only, no writes)
 *
 * Promoted from internal/backfill-region.ts on 2026-05-19 (#2635) so the script
 * is type-checked, version-controlled, and discoverable next to its migration.
 */
import { Client } from "pg";

const DRY_RUN = process.env.DRY_RUN === "1";

interface Target {
  label: "eu" | "apac";
  urlEnv: "EU_INT_DB_URL" | "APAC_INT_DB_URL";
}

const TARGETS: Target[] = [
  { label: "eu", urlEnv: "EU_INT_DB_URL" },
  { label: "apac", urlEnv: "APAC_INT_DB_URL" },
];

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function backfillOne(t: Target): Promise<void> {
  const url = requireEnv(t.urlEnv);
  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    // Safety check — confirm we're talking to a database that actually has
    // an `organization` table with both `region` + `deleted_at`. A typo'd
    // URL would otherwise silently update zero rows.
    const cols = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'organization'
         AND column_name IN ('region','deleted_at')`,
    );
    const present = new Set(cols.rows.map((r) => r.column_name));
    if (!present.has("region") || !present.has("deleted_at")) {
      throw new Error(
        `[${t.label}] organization table missing region/deleted_at columns — wrong DB? found: ${[...present].join(",") || "(none)"}`,
      );
    }

    const before = await client.query<{ total: number; null_region: number; non_null_region: number }>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE region IS NULL)::int AS null_region,
         COUNT(*) FILTER (WHERE region IS NOT NULL)::int AS non_null_region
       FROM organization
       WHERE deleted_at IS NULL`,
    );
    const row = before.rows[0]!;
    console.log(
      `[${t.label}] before: total=${row.total} null_region=${row.null_region} non_null_region=${row.non_null_region}`,
    );

    // Residency-drift guard — abort if there are non-null rows tagged with a
    // *different* region. That would mean cross-region data which violates
    // residency and we shouldn't blindly clobber.
    const drift = await client.query<{ region: string; n: number }>(
      `SELECT region, COUNT(*)::int AS n
       FROM organization
       WHERE deleted_at IS NULL AND region IS NOT NULL AND region <> $1
       GROUP BY region`,
      [t.label],
    );
    if (drift.rows.length > 0) {
      throw new Error(
        `[${t.label}] residency drift detected — found ${drift.rows
          .map((d) => `region='${d.region}' (${d.n} rows)`)
          .join(", ")}. Aborting before clobbering cross-region data.`,
      );
    }

    if (DRY_RUN) {
      console.log(`[${t.label}] DRY_RUN — would set region='${t.label}' on ${row.null_region} rows`);
      return;
    }

    const upd = await client.query(
      `UPDATE organization SET region = $1
       WHERE region IS NULL AND deleted_at IS NULL`,
      [t.label],
    );
    console.log(`[${t.label}] updated ${upd.rowCount} rows`);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  console.log(`[backfill] starting ${DRY_RUN ? "(DRY_RUN)" : ""}`);
  for (const t of TARGETS) {
    await backfillOne(t);
  }
  console.log("[backfill] ✓ done");
}

main().catch((err) => {
  console.error("[backfill] ✗ failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
