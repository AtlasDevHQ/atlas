/**
 * Idempotent demo data seeder for Railway production deployment.
 *
 * Seeds the canonical NovaMart e-commerce demo dataset (#2021 collapsed
 * the previous three-seed picker — `simple`/`cybersec`/`ecommerce` — to
 * the single ecommerce seed). The image bundles the seed at
 * `/app/data/demo.sql`.
 *
 * Idempotent: checks a sentinel table + column before seeding.
 *
 * When DATABASE_URL and ATLAS_DATASOURCE_URL point to the same database,
 * Atlas internal tables (auth, audit, settings) share the schema with
 * analytics data. The sentinel check uses a dataset-specific column to
 * distinguish analytics tables from Atlas internals. (#962)
 *
 * Exits 0 on success or "already seeded", exits 1 on failure.
 */

import { readFileSync, existsSync } from "fs";
import pg from "pg";

const url = process.env.ATLAS_DATASOURCE_URL;
if (!url) {
  console.error("seed-demo: ATLAS_DATASOURCE_URL not set — cannot seed");
  process.exit(1);
}

interface Dataset {
  name: string;
  file: string;
  /** Table to check for idempotency. */
  sentinelTable: string;
  /**
   * A column unique to this dataset's sentinel table. Prevents false
   * positives when an Atlas internal table (e.g. Better Auth's
   * "organization") shares the same database. The seed is only skipped
   * when BOTH the table and this column exist and the table has rows.
   */
  sentinelColumn: string;
}

const datasets: Dataset[] = [
  { name: "NovaMart (ecommerce)", file: "/app/data/demo.sql", sentinelTable: "customers", sentinelColumn: "acquisition_source" },
];

const client = new pg.Client({
  connectionString: url,
  connectionTimeoutMillis: 10_000,
  // Cybersec + ecommerce have large GENERATE_SERIES inserts
  statement_timeout: 120_000,
});

try {
  await client.connect();

  for (const ds of datasets) {
    // The canonical seed file is bundled into the image at build time
    // (Dockerfile:91). A missing file means the build is broken — fail
    // loudly rather than booting the API against an empty DB.
    if (!existsSync(ds.file)) {
      console.error(
        `seed-demo: ${ds.name} — ${ds.file} not found in the image. ` +
          `This indicates a broken build (the Dockerfile COPY of the canonical ` +
          `seed at packages/cli/data/seeds/ecommerce/seed.sql failed or drifted).`,
      );
      process.exit(1);
    }

    // Check if dataset already seeded.
    // We verify the sentinel table AND a dataset-specific column to avoid
    // false positives from Atlas internal tables that happen to share the
    // same database (e.g. Better Auth's "organization" table). (#962)
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = $2
      ) AS dataset_exists
    `, [ds.sentinelTable, ds.sentinelColumn]);

    if (tableCheck.rows[0]?.dataset_exists) {
      const count = await client.query(
        `SELECT count(*) AS n FROM ${ds.sentinelTable}`
      );
      if (parseInt(count.rows[0]?.n ?? "0", 10) > 0) {
        console.log(`seed-demo: ${ds.name} — already seeded, skipping`);
        continue;
      }
    }

    // Read and execute the seed SQL
    const sql = readFileSync(ds.file, "utf-8");
    console.log(`seed-demo: ${ds.name} — seeding...`);

    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(
        `seed-demo: ${ds.name} — FAILED:`,
        err instanceof Error ? err.message : err,
      );
      // With a single canonical seed, a SQL failure means the API will boot
      // against an empty database — fail loudly instead of exiting 0. (#2021)
      try { await client.end(); } catch { /* connection close failed; exit anyway */ }
      process.exit(1);
    }

    // Verify
    const verify = await client.query(
      `SELECT count(*) AS n FROM ${ds.sentinelTable}`
    );
    console.log(
      `seed-demo: ${ds.name} — seeded ${verify.rows[0]?.n ?? 0} rows in ${ds.sentinelTable}`,
    );
  }

  await client.end();
  process.exit(0);
} catch (err) {
  console.error(
    "seed-demo: failed —",
    err instanceof Error ? err.stack : err,
  );
  try { await client.end(); } catch {}
  process.exit(1);
}
