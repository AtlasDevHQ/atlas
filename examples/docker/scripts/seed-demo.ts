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

interface Migration {
  /** Stable name for logging — keep these unique within a dataset. */
  name: string;
  /**
   * Idempotent SQL. MUST safely no-op against an already-aligned schema
   * AND apply the change against a stale one (use `ADD COLUMN IF NOT
   * EXISTS`, `IF NOT EXISTS` checks in DO blocks, conditional UPDATEs).
   * The seeder runs every migration on every boot; only the side-effect
   * branches should fire when actual drift exists.
   */
  sql: string;
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
  /**
   * Idempotent schema migrations applied AFTER the seed (or after the
   * "already seeded" skip). Lets a long-lived demo DB pick up additive
   * schema changes without a destructive re-seed. Catches the class of
   * drift where the seed SQL evolves but a previously-seeded prod DB
   * doesn't pick up new columns / constraints.
   */
  migrations?: Migration[];
}

const datasets: Dataset[] = [
  {
    name: "NovaMart (ecommerce)",
    file: "/app/data/demo.sql",
    sentinelTable: "customers",
    sentinelColumn: "acquisition_source",
    migrations: [
      {
        // Older seeds (pre-canonical-product_id) created order_items without
        // `product_id`. Backfill from product_variants.product_id and add
        // the FK so the canonical YAML's `order_items.product_id` dimension
        // resolves against a real column.
        name: "order_items.product_id alignment",
        sql: `
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'order_items'
                AND column_name = 'product_id'
            ) THEN
              ALTER TABLE order_items ADD COLUMN product_id INTEGER;
              UPDATE order_items oi
              SET product_id = pv.product_id
              FROM product_variants pv
              WHERE pv.id = oi.product_variant_id;
              ALTER TABLE order_items ALTER COLUMN product_id SET NOT NULL;
              ALTER TABLE order_items
                ADD CONSTRAINT order_items_product_id_fkey
                FOREIGN KEY (product_id) REFERENCES products(id);
            END IF;
          END
          $$;
        `,
      },
    ],
  },
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

    let alreadySeeded = false;
    if (tableCheck.rows[0]?.dataset_exists) {
      const count = await client.query(
        `SELECT count(*) AS n FROM ${ds.sentinelTable}`
      );
      if (parseInt(count.rows[0]?.n ?? "0", 10) > 0) {
        console.log(`seed-demo: ${ds.name} — already seeded, skipping initial seed`);
        alreadySeeded = true;
      }
    }

    if (!alreadySeeded) {
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

    // Apply schema migrations even when the seed is skipped — long-lived
    // demo DBs need to pick up additive schema changes (e.g. a new
    // canonical column the seed file added since first-seed). Each
    // migration must be idempotent; it runs on every boot.
    if (ds.migrations && ds.migrations.length > 0) {
      for (const mig of ds.migrations) {
        try {
          await client.query(mig.sql);
          console.log(`seed-demo: ${ds.name} — migration applied: ${mig.name}`);
        } catch (err) {
          console.error(
            `seed-demo: ${ds.name} — migration "${mig.name}" FAILED:`,
            err instanceof Error ? err.message : err,
          );
          try { await client.end(); } catch { /* connection close failed; exit anyway */ }
          process.exit(1);
        }
      }
    }
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
