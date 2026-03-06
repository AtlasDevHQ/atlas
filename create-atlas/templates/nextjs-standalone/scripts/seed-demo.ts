/**
 * Build-time demo data seeder for Vercel deployments.
 *
 * When ATLAS_DEMO_DATA=true, seeds the Neon-provisioned database with demo
 * data (companies, people, accounts — ~30KB). Idempotent: skips if data
 * already exists. Runs during `next build` on Vercel.
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
});

try {
  await client.connect();

  // Check if demo data already exists
  const result = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'companies'
    ) AS table_exists
  `);

  if (result.rows[0]?.table_exists) {
    const count = await client.query("SELECT count(*) AS n FROM companies");
    if (parseInt(count.rows[0]?.n ?? "0", 10) > 0) {
      console.log("seed-demo: demo data already exists, skipping");
      await client.end();
      process.exit(0);
    }
    console.log("seed-demo: companies table exists but is empty, re-seeding...");
  }

  // Read the seed SQL
  const sqlPath = resolve(import.meta.dirname, "../data/demo.sql");
  let sql: string;
  try {
    sql = readFileSync(sqlPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read ${sqlPath}: ${err instanceof Error ? err.message : err}`
    );
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

  const verify = await client.query("SELECT count(*) AS n FROM companies");
  console.log(`seed-demo: seeded ${verify.rows[0]?.n ?? 0} companies successfully`);

  await client.end();
  process.exit(0);
} catch (err) {
  console.error("seed-demo: failed —", err instanceof Error ? err.stack : err);
  try { await client.end(); } catch (cleanupErr) {
    console.warn("seed-demo: cleanup failed —", cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
  }
  process.exit(1);
}
