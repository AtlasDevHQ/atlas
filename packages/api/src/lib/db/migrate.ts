/**
 * Versioned migration runner for the internal database.
 *
 * Reads SQL files from the `migrations/` directory and executes them in order.
 * Tracks applied migrations in an `__atlas_migrations` table. Each migration
 * runs inside a transaction (DDL is transactional in PostgreSQL).
 *
 * Design decisions:
 *   - Hand-rolled (~60 lines) because we only need "read SQL files, run them
 *     in order, track what's applied". No need for the full drizzle-orm runtime.
 *   - Drizzle Kit generates the SQL files from `schema.ts` — this runner just
 *     executes them.
 *   - The baseline migration (0000_baseline.sql) is idempotent (IF NOT EXISTS)
 *     so it is safe on existing deployments that already have all tables.
 */

import * as fs from "fs";
import * as path from "path";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("db-migrate");

/** Minimal pool interface — matches pg.Pool. */
interface MigrationPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const MIGRATIONS_DIR = path.join(import.meta.dir, "migrations");

/**
 * Run all pending migrations against the given pool.
 *
 * 1. Creates the tracking table if it doesn't exist.
 * 2. Reads all `*.sql` files from the migrations directory, sorted by name.
 * 3. Skips files already recorded in `__atlas_migrations`.
 * 4. Executes each pending file inside a transaction.
 *
 * Returns the number of migrations applied (0 if already up-to-date).
 */
export async function runMigrations(pool: MigrationPool): Promise<number> {
  // Acquire an advisory lock so concurrent server instances don't race.
  // hashtext('atlas_migrations') produces a stable int4 key.
  await pool.query("SELECT pg_advisory_lock(hashtext('atlas_migrations'))");

  try {
    return await _runMigrationsLocked(pool);
  } finally {
    await pool.query("SELECT pg_advisory_unlock(hashtext('atlas_migrations'))").catch(() => {
      // intentionally ignored: unlock may fail if connection was broken
    });
  }
}

async function _runMigrationsLocked(pool: MigrationPool): Promise<number> {
  // Ensure tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS __atlas_migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Read migration files
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    log.warn("No migrations directory found — skipping");
    return 0;
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) return 0;

  // Get already-applied migrations
  const { rows } = await pool.query("SELECT name FROM __atlas_migrations ORDER BY name");
  const applied = new Set(rows.map((r) => r.name as string));

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(filePath, "utf-8");

    log.info({ migration: file }, "Applying migration");

    // Run inside a transaction — PostgreSQL DDL is transactional
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query(
        "INSERT INTO __atlas_migrations (name) VALUES ($1)",
        [file],
      );
      await pool.query("COMMIT");
      count++;
    } catch (err) {
      await pool.query("ROLLBACK").catch(() => {
        // intentionally ignored: ROLLBACK may fail if connection is broken
      });
      const detail = err instanceof Error ? err.message : String(err);
      log.error({ migration: file, err: detail }, "Migration failed");
      throw new Error(`Migration ${file} failed: ${detail}`, { cause: err });
    }
  }

  if (count > 0) {
    log.info({ applied: count, total: files.length }, "Migrations complete");
  }

  return count;
}

/**
 * Seed data that should run after the baseline migration.
 * Extracted from the old migrateInternalDB() — includes prompt library
 * seeding, SLA threshold defaults, and backup config defaults.
 *
 * Idempotent — checks for existing data before inserting.
 */
export async function runSeeds(pool: MigrationPool): Promise<void> {
  await seedPromptLibrary(pool);
  await seedSlaThresholdDefaults(pool);
  await seedBackupConfigDefaults(pool);
}

// ---------------------------------------------------------------------------
// Seed: prompt library
// ---------------------------------------------------------------------------

async function seedPromptLibrary(pool: MigrationPool): Promise<void> {
  const collections = [
    {
      name: "SaaS Metrics",
      industry: "saas",
      description: "Key metrics for SaaS businesses including revenue, churn, and growth indicators.",
      items: [
        { question: "What is our current MRR and how has it trended over the last 12 months?", description: "Monthly recurring revenue trend", category: "Revenue" },
        { question: "What is our monthly churn rate by plan type?", description: "Customer churn segmented by subscription tier", category: "Churn" },
        { question: "What is the average customer lifetime value (LTV) by acquisition channel?", description: "LTV breakdown by how customers were acquired", category: "Revenue" },
        { question: "What is our customer acquisition cost (CAC) by channel?", description: "Cost to acquire customers across marketing channels", category: "Growth" },
        { question: "What is the LTV to CAC ratio by plan type?", description: "Unit economics health check", category: "Revenue" },
        { question: "What is our net revenue retention rate?", description: "Expansion revenue minus churn and contraction", category: "Retention" },
        { question: "What is the average revenue per user (ARPU) trend?", description: "Revenue per user over time", category: "Revenue" },
        { question: "How many trials converted to paid subscriptions this month?", description: "Trial-to-paid conversion rate", category: "Growth" },
        { question: "What is the expansion revenue from upsells and cross-sells?", description: "Revenue growth from existing customers", category: "Revenue" },
        { question: "What are the top reasons for customer cancellation?", description: "Churn reason analysis", category: "Churn" },
        { question: "What is our monthly active user (MAU) trend?", description: "Product engagement over time", category: "Engagement" },
        { question: "What is the average time to first value for new customers?", description: "Onboarding speed metric", category: "Engagement" },
      ],
    },
    {
      name: "E-commerce KPIs",
      industry: "ecommerce",
      description: "Essential KPIs for e-commerce businesses covering sales, conversion, and inventory.",
      items: [
        { question: "What is our gross merchandise volume (GMV) this month vs last month?", description: "Total sales volume comparison", category: "Sales" },
        { question: "What is our average order value (AOV) by product category?", description: "AOV segmented by category", category: "Sales" },
        { question: "What is our cart abandonment rate and at which step do most users drop off?", description: "Checkout funnel analysis", category: "Conversion" },
        { question: "What are the top 10 products by revenue this quarter?", description: "Best-selling products ranked by revenue", category: "Products" },
        { question: "What is our conversion rate from visit to purchase by traffic source?", description: "Conversion funnel by acquisition channel", category: "Conversion" },
        { question: "What is the return rate by product category?", description: "Product return analysis", category: "Operations" },
        { question: "What is the average delivery time by region?", description: "Fulfillment speed by geography", category: "Operations" },
        { question: "What is the customer repeat purchase rate?", description: "Percentage of customers who buy again", category: "Retention" },
        { question: "Which product categories have the highest profit margins?", description: "Margin analysis by category", category: "Profitability" },
        { question: "What is the inventory turnover rate by product?", description: "How quickly inventory sells", category: "Inventory" },
        { question: "What is the customer satisfaction score (CSAT) trend?", description: "Customer satisfaction over time", category: "Experience" },
        { question: "What are the peak sales hours and days of the week?", description: "Sales timing patterns", category: "Sales" },
      ],
    },
    {
      name: "Cybersecurity Compliance",
      industry: "cybersecurity",
      description: "Security and compliance metrics for cybersecurity monitoring and reporting.",
      items: [
        { question: "How many open vulnerabilities do we have by severity level?", description: "Vulnerability count by critical/high/medium/low", category: "Vulnerabilities" },
        { question: "What is our average time to patch critical vulnerabilities?", description: "Mean time to remediate critical findings", category: "Vulnerabilities" },
        { question: "What is the compliance score across our security frameworks?", description: "Overall compliance posture", category: "Compliance" },
        { question: "How many security incidents occurred this month by type?", description: "Incident count segmented by category", category: "Incidents" },
        { question: "What is our mean time to detect (MTTD) and mean time to respond (MTTR)?", description: "Incident response speed metrics", category: "Incidents" },
        { question: "What percentage of endpoints have up-to-date security agents?", description: "Endpoint protection coverage", category: "Assets" },
        { question: "What is the phishing simulation click rate trend?", description: "Security awareness training effectiveness", category: "Training" },
        { question: "How many failed login attempts occurred by user and region?", description: "Brute force and credential stuffing detection", category: "Access" },
        { question: "What is the status of our third-party vendor risk assessments?", description: "Vendor security review completion", category: "Compliance" },
        { question: "What percentage of systems are compliant with our patching policy?", description: "Patch compliance rate", category: "Vulnerabilities" },
        { question: "What are the top firewall-blocked threats this week?", description: "Network threat intelligence summary", category: "Network" },
        { question: "What is the data classification breakdown across our storage systems?", description: "Sensitive data inventory", category: "Data" },
      ],
    },
  ];

  for (let ci = 0; ci < collections.length; ci++) {
    const collection = collections[ci];
    const existing = await pool.query(
      "SELECT id FROM prompt_collections WHERE name = $1 AND is_builtin = true",
      [collection.name],
    );
    if (existing.rows.length > 0) continue;

    const result = await pool.query(
      `INSERT INTO prompt_collections (name, industry, description, is_builtin, sort_order)
       VALUES ($1, $2, $3, true, $4) RETURNING id`,
      [collection.name, collection.industry, collection.description, ci],
    );
    if (!result.rows[0]) {
      log.warn({ collection: collection.name }, "INSERT INTO prompt_collections returned no rows — skipping item seeding");
      continue;
    }
    const collectionId = result.rows[0].id as string;

    for (let i = 0; i < collection.items.length; i++) {
      const item = collection.items[i];
      await pool.query(
        `INSERT INTO prompt_items (collection_id, question, description, category, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [collectionId, item.question, item.description, item.category, i],
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Seed: SLA threshold defaults
// ---------------------------------------------------------------------------

async function seedSlaThresholdDefaults(pool: MigrationPool): Promise<void> {
  try {
    const rawLatency = parseFloat(process.env.ATLAS_SLA_LATENCY_P99_MS ?? "");
    const rawErrorRate = parseFloat(process.env.ATLAS_SLA_ERROR_RATE_PCT ?? "");
    const defaultLatency = isNaN(rawLatency) ? 5000 : rawLatency;
    const defaultErrorRate = isNaN(rawErrorRate) ? 5 : rawErrorRate;
    await pool.query(
      `INSERT INTO sla_thresholds (workspace_id, latency_p99_ms, error_rate_pct)
       VALUES ('_default', $1, $2)
       ON CONFLICT (workspace_id) DO NOTHING`,
      [defaultLatency, defaultErrorRate],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist")) {
      log.debug("sla_thresholds table not present — skipping SLA seed (expected in non-EE)");
    } else {
      log.warn({ err: msg }, "Failed to seed SLA threshold defaults");
    }
  }
}

// ---------------------------------------------------------------------------
// Seed: backup config defaults
// ---------------------------------------------------------------------------

async function seedBackupConfigDefaults(pool: MigrationPool): Promise<void> {
  try {
    const envSchedule = process.env.ATLAS_BACKUP_SCHEDULE ?? "0 3 * * *";
    const envRetention = parseInt(process.env.ATLAS_BACKUP_RETENTION_DAYS ?? "30", 10) || 30;
    const envStorage = process.env.ATLAS_BACKUP_STORAGE_PATH ?? "./backups";
    await pool.query(
      `INSERT INTO backup_config (id, schedule, retention_days, storage_path)
       VALUES ('_default', $1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [envSchedule, envRetention, envStorage],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist")) {
      log.debug("backup_config table not present — skipping backup seed (expected in non-EE)");
    } else {
      log.warn({ err: msg }, "Failed to seed backup config defaults");
    }
  }
}
