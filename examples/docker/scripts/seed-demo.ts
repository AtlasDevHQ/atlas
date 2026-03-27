/**
 * Idempotent demo data seeder for Railway production deployment.
 *
 * Seeds all three demo datasets into the same database:
 *   1. demo.sql     — Simple SaaS CRM (companies, people, accounts) ~330 rows
 *   2. cybersec.sql — Sentinel Security cybersecurity SaaS ~500K rows
 *   3. ecommerce.sql — NovaMart DTC e-commerce ~480K rows
 *
 * Each dataset uses unique table names so they coexist without conflicts.
 * Idempotent: checks a sentinel table per dataset before seeding.
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
  sentinelTable: string;
}

const datasets: Dataset[] = [
  { name: "SaaS CRM (demo)",          file: "/app/data/demo.sql",      sentinelTable: "companies" },
  { name: "Sentinel Security (cybersec)", file: "/app/data/cybersec.sql",  sentinelTable: "organizations" },
  { name: "NovaMart (ecommerce)",      file: "/app/data/ecommerce.sql", sentinelTable: "customers" },
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
    // Check if this dataset's SQL file exists in the image
    if (!existsSync(ds.file)) {
      console.log(`seed-demo: ${ds.name} — ${ds.file} not found, skipping`);
      continue;
    }

    // Check if dataset already seeded (sentinel table has rows)
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
      ) AS table_exists
    `, [ds.sentinelTable]);

    if (tableCheck.rows[0]?.table_exists) {
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
      // Continue to next dataset instead of aborting entirely
      continue;
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
