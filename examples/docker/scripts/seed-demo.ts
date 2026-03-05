/**
 * Idempotent demo data seeder for Railway "Atlas Demo" template.
 *
 * Connects to ATLAS_DATASOURCE_URL, checks if `companies` table has rows,
 * and seeds from /app/data/demo.sql inside a transaction if not.
 * Exits 0 on success or "already seeded", exits 1 on failure.
 */

import { readFileSync } from "fs";
import pg from "pg";

const url = process.env.ATLAS_DATASOURCE_URL;
if (!url) {
  console.error(
    "seed-demo: ATLAS_DATASOURCE_URL not set — cannot seed demo data"
  );
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  connectionTimeoutMillis: 10_000,
});

try {
  await client.connect();

  // Check if demo data already exists (row count, not just table existence)
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
    console.log(
      "seed-demo: companies table exists but is empty, re-seeding..."
    );
  }

  // Read the seed SQL
  let sql: string;
  try {
    sql = readFileSync("/app/data/demo.sql", "utf-8");
  } catch (err) {
    throw new Error(
      `failed to read /app/data/demo.sql: ${err instanceof Error ? err.message : err}`
    );
  }

  // Execute inside a transaction so partial failures roll back
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  // Verify seeding worked
  const verify = await client.query("SELECT count(*) AS n FROM companies");
  console.log(
    `seed-demo: seeded ${verify.rows[0]?.n ?? 0} companies successfully`
  );

  await client.end();
  process.exit(0);
} catch (err) {
  console.error(
    "seed-demo: failed —",
    err instanceof Error ? err.stack : err
  );
  try {
    await client.end();
  } catch (cleanupErr) {
    console.error(
      "seed-demo: cleanup — failed to close db connection:",
      cleanupErr instanceof Error ? cleanupErr.message : cleanupErr
    );
  }
  process.exit(1);
}
