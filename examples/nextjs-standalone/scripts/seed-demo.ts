/**
 * Build-time demo data seeder for Vercel deployments.
 *
 * When ATLAS_DEMO_DATA=true, seeds the Neon-provisioned database with the
 * canonical NovaMart e-commerce dataset (#2021 collapsed the previous
 * three-seed picker — `simple`/`cybersec`/`ecommerce` — to one seed). The
 * seed SQL is read from `packages/cli/data/seeds/ecommerce/seed.sql`.
 *
 * Idempotent: skips if data already exists. Runs during `next build` on Vercel.
 *
 * Resolves the database URL from DATABASE_URL_UNPOOLED or DATABASE_URL
 * (set automatically by Neon's Vercel integration).
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import pg from "pg";

if (process.env.ATLAS_DEMO_DATA !== "true") {
  console.log("seed-demo: ATLAS_DEMO_DATA is not 'true' — skipping");
  process.exit(0);
}

// Prefer unpooled for DDL/migrations (PgBouncer can interfere with multi-statement transactions)
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("seed-demo: no DATABASE_URL or DATABASE_URL_UNPOOLED — cannot seed");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  connectionTimeoutMillis: 10_000,
  // The ecommerce seed has large GENERATE_SERIES inserts (~480K rows).
  statement_timeout: 120_000,
});

// Sentinel column distinguishes the analytics `customers` table from any
// internal Better Auth table that might happen to share the same database.
const SENTINEL_TABLE = "customers";
const SENTINEL_COLUMN = "acquisition_source";

try {
  await client.connect();

  // Check if the canonical seed has already been applied.
  // We verify the sentinel table AND a dataset-specific column to avoid
  // false positives from internal tables that happen to share the schema. (#962)
  const tableCheck = await client.query(
    `
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
    ) AS dataset_exists
  `,
    [SENTINEL_TABLE, SENTINEL_COLUMN],
  );

  if (tableCheck.rows[0]?.dataset_exists) {
    const count = await client.query(`SELECT count(*) AS n FROM ${SENTINEL_TABLE}`);
    if (parseInt(count.rows[0]?.n ?? "0", 10) > 0) {
      console.log("seed-demo: demo data already exists, skipping");
      await client.end();
      process.exit(0);
    }
    console.log(`seed-demo: ${SENTINEL_TABLE} table exists but is empty, re-seeding...`);
  }

  // Read the seed SQL from the CLI package
  const sqlPath = resolve(import.meta.dirname, "../../../packages/cli/data/seeds/ecommerce/seed.sql");
  let sql: string;
  try {
    sql = readFileSync(sqlPath, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read ${sqlPath}: ${err instanceof Error ? err.message : err}`);
  }

  // Execute inside a transaction
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (rollbackErr) {
      console.warn("seed-demo: ROLLBACK failed —", rollbackErr instanceof Error ? rollbackErr.message : rollbackErr);
    }
    throw err;
  }

  const verify = await client.query(`SELECT count(*) AS n FROM ${SENTINEL_TABLE}`);
  console.log(`seed-demo: seeded ${verify.rows[0]?.n ?? 0} customers successfully`);

  await client.end();
  process.exit(0);
} catch (err) {
  console.error("seed-demo: failed —", err instanceof Error ? err.stack : err);
  try { await client.end(); } catch (cleanupErr) {
    console.warn("seed-demo: cleanup failed —", cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
  }
  process.exit(1);
}
