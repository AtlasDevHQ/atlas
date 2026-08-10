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

/** Minimal query interface — shared by pool and client. */
interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Minimal pool interface — matches pg.Pool. */
interface MigrationPool extends Queryable {
  connect(): Promise<MigrationClient>;
}

/**
 * Minimal client interface — matches pg.PoolClient. Passing a truthy
 * `err` to `release` tells node-postgres to destroy the socket instead
 * of returning it to the pool.
 */
interface MigrationClient extends Queryable {
  release(err?: Error): void;
  /**
   * `node-postgres`' `EventEmitter` surface, narrowed to the one event this
   * module listens for (#5047).
   *
   * REQUIRED, and the first cut of this had them optional with a `debug` line
   * when absent — which reinstated the exact gap the listener closes, below the
   * production log level, under two docstrings claiming it could not happen.
   * A future pool wrapper or driver swap would have silently discarded every
   * migration breadcrumb again.
   *
   * `InternalPoolClient` keeps them OPTIONAL so the tree's hand-built
   * `{ query, release }` doubles still satisfy it (the count and the reason live
   * there, in the file that pays it). Passing such a pool straight to
   * `runMigrations` therefore fails to compile — which is why `migrateInternalDB`
   * builds a wrapper, and why that wrapper's `typeof` check plus
   * `MigrationClientContractError` is what turns a future driver swap into a loud
   * boot failure rather than a silently deaf migration.
   */
  on(event: "notice", listener: (notice: { readonly message?: string }) => void): unknown;
  off(event: "notice", listener: (notice: { readonly message?: string }) => void): unknown;
}

/**
 * Which migration a server notice should be attributed to.
 *
 * A box rather than a closure variable because the listener is attached in
 * {@link runMigrations} while the per-file loop runs one function down, and the
 * alternative — attributing every notice to whatever ran last — is worse than no
 * attribution at all.
 */
interface NoticeAttribution {
  migration: string;
}

const MIGRATIONS_DIR = path.join(import.meta.dir, "migrations");

/** Options for `runMigrations`. */
export interface RunMigrationsOptions {
  /**
   * Filenames to skip without recording in `__atlas_migrations`. Used to keep
   * migrations that depend on tables created by external systems (e.g. Better
   * Auth's `organization` table) out of deployments where those tables do not
   * exist. Skipped files are picked up automatically on a future boot once the
   * dependency is in place. See #1472.
   */
  skip?: string[];
}

/**
 * Advisory-lock key for the migration runner, evaluated server-side so it
 * always reflects the session's *effective* schema rather than anything the
 * caller believes it set.
 *
 * `coalesce` matters: `current_schema()` is NULL when the search_path names
 * only schemas that don't exist, and `pg_advisory_lock(NULL)` is strict — it
 * returns NULL and takes **no lock at all**. Without the coalesce a broken
 * search_path would silently run migrations unserialized instead of failing.
 */
export const ADVISORY_LOCK_KEY_SQL =
  "hashtext('atlas_migrations' || CASE WHEN coalesce(current_schema(), 'public') = 'public'" +
  " THEN '' ELSE ':' || current_schema() END)";

const ADVISORY_LOCK_SQL = `SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY_SQL})`;
const ADVISORY_UNLOCK_SQL = `SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY_SQL})`;

/**
 * Run all pending migrations against the given pool.
 *
 * 1. Creates the tracking table if it doesn't exist.
 * 2. Reads all `*.sql` files from the migrations directory, sorted by name.
 * 3. Skips files already recorded in `__atlas_migrations` and any in `options.skip`.
 * 4. Executes each pending file inside a transaction.
 *
 * Returns the number of migrations applied (0 if already up-to-date).
 */
export async function runMigrations(pool: MigrationPool, options: RunMigrationsOptions = {}): Promise<number> {
  // Use a dedicated connection so the advisory lock, all transactions,
  // and the unlock all happen on the same session. Without this, pg pool
  // could dispatch queries to different connections, breaking lock and
  // transaction semantics.
  const client = await pool.connect();

  // ⚠️ WITHOUT THIS, EVERY `RAISE NOTICE` IN EVERY MIGRATION IS DISCARDED (#5047).
  //
  // Migrations 0032, 0034, 0055, 0072 and 0085 all emit one as a deliberate
  // operator breadcrumb — 0032's header even names the mistake it was written to
  // stop: *"so operators have a post-mortem breadcrumb instead of silent
  // rewrites (0031 shipped without this — don't repeat that gap)"*. `node-postgres`
  // delivers server notices on a `notice` event and drops them when nothing is
  // listening, and nothing was, so five files' worth of breadcrumbs had been
  // going nowhere. 0194 adds a sixth (its tombstone count) and is what surfaced
  // it.
  //
  // Attached to the DEDICATED client rather than the pool, matching every other
  // statement here: the notice arrives on the session that raised it, and this is
  // the only session migrations run on. Detached in `finally` with the same
  // reference, so a pooled client cannot accumulate a listener per call — the
  // shape that turns a long-lived pool into a `MaxListenersExceededWarning` and
  // then a leak.
  //
  // `migration` is bound per statement below rather than captured here, so a
  // notice names the file that raised it instead of whatever ran last.
  //
  // ⚠️ ROUTINE notices come through too — `CREATE TABLE IF NOT EXISTS` and
  // `DROP … IF EXISTS` both raise one — and they are NOT filtered, because
  // Postgres does not offer a discriminator that works. Measured on this repo's
  // PG 16: a deliberate `RAISE NOTICE` reports SQLSTATE `00000`, and so does
  // *"table … does not exist, skipping"*; only `CREATE TABLE IF NOT EXISTS`
  // differs (`42P07`). A code filter would therefore drop nothing useful and
  // keep half the noise.
  //
  // The volume is bounded by what already exists: this function logs "Applying
  // migration" once per file at `info`, so a fresh install's few dozen extra
  // lines sit beside ~195 of those, and an incremental deploy only runs the new
  // files. Noise was the wrong thing to optimize against here — the failure this
  // closes is a deliberate breadcrumb reaching nobody.
  const noticeFrom: NoticeAttribution = { migration: "(before any migration)" };
  const onNotice = (notice: { readonly message?: string }): void => {
    log.info(
      { migration: noticeFrom.migration, notice: notice.message ?? "(no message)" },
      "Migration notice",
    );
  };
  client.on("notice", onNotice);

  // A failed per-migration ROLLBACK propagates here via the callback so
  // the client gets destroyed on release instead of pooled dirty.
  let rollbackErr: Error | null = null;

  try {
    // Acquire an advisory lock so concurrent server instances don't race.
    // hashtext(...) produces a stable int4 key.
    //
    // The key is scoped to the schema the migrations actually write into,
    // because that — specifically its `__atlas_migrations` table — is the
    // resource being protected. A bare constant key is database-wide, which
    // made every `-pg` test suite serialize on one lock even though each runs
    // into its own private scratch schema: 8 concurrent suites took 30.5s wall
    // versus 0.9s for one, landing exactly on the suites' 30s `beforeAll`
    // budget and failing a random one per run (#4844).
    //
    // `public` deliberately keeps the original bare key rather than
    // `atlas_migrations:public`. Production only ever migrates `public`, so the
    // key stays bit-identical and a rolling deploy can't end up with old and
    // new instances holding *different* keys — which would let them migrate
    // concurrently, the exact race this lock exists to prevent.
    await client.query(ADVISORY_LOCK_SQL);

    try {
      return await _runMigrationsLocked(
        client,
        options.skip ?? [],
        (err) => {
          rollbackErr = err;
        },
        noticeFrom,
      );
    } finally {
      await client.query(ADVISORY_UNLOCK_SQL).catch((err: unknown) => {
        // Unlock may legitimately fail if the connection is broken (in
        // which case the client is about to be destroyed anyway). Debug
        // so a genuine SQL-level failure still leaves a trace.
        log.debug(
          { err: err instanceof Error ? err.message : String(err) },
          "pg_advisory_unlock failed — continuing to release",
        );
      });
    }
  } finally {
    // Anything raised after the loop — `ADVISORY_UNLOCK_SQL` — is not the last
    // migration's doing, and attributing it there would be a small lie in the
    // one field this line exists to get right.
    noticeFrom.migration = "(after the last migration)";
    // Same reference, so the client goes back to the pool with no more listeners
    // than it arrived with. `off` and not `removeAllListeners`: the pool's own
    // internals may have their own.
    //
    // ⚠️ `runSeeds` runs on a DIFFERENT connection, after this returns, so seed
    // notices are still discarded. Out of scope here and stated so the next
    // reader does not assume coverage.
    client.off("notice", onNotice);
    client.release(rollbackErr ?? undefined);
  }
}

async function _runMigrationsLocked(
  client: MigrationClient,
  skip: string[],
  onRollbackFailure: (err: Error) => void,
  noticeFrom: NoticeAttribution,
): Promise<number> {
  const skipSet = new Set(skip);
  // Ensure tracking table exists
  await client.query(`
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

  // Surface stale skip entries — a typo here would silently no-op a guard,
  // letting a migration that should have been skipped fall through to a
  // misleading SQL failure. This is exactly the failure mode #1472 invented
  // the skip list to prevent.
  const filesSet = new Set(files);
  for (const name of skipSet) {
    if (!filesSet.has(name)) {
      log.warn(
        { migration: name },
        "Skip-list entry does not match any migration file — typo or stale reference?",
      );
    }
  }

  // Get already-applied migrations
  const { rows } = await client.query("SELECT name FROM __atlas_migrations ORDER BY name");
  const applied = new Set(rows.map((r) => r.name as string));

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    if (skipSet.has(file)) {
      log.debug({ migration: file }, "Skipping migration (caller-supplied skip list)");
      continue;
    }

    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(filePath, "utf-8");

    log.info({ migration: file }, "Applying migration");
    // So a `RAISE NOTICE` raised below is attributed to THIS file.
    noticeFrom.migration = file;

    // Run inside a transaction — PostgreSQL DDL is transactional.
    // All queries use the same dedicated client (not the pool) so
    // BEGIN/COMMIT/ROLLBACK are guaranteed to hit the same connection.
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO __atlas_migrations (name) VALUES ($1)",
        [file],
      );
      await client.query("COMMIT");
      count++;
    } catch (err) {
      await client.query("ROLLBACK").catch((rbErr: unknown) => {
        // A failed ROLLBACK means the socket is dirty — propagate the
        // error so the shared client gets destroyed on release.
        const normalized =
          rbErr instanceof Error ? rbErr : new Error(String(rbErr));
        log.warn(
          { migration: file, err: normalized.message },
          "ROLLBACK failed during migration — client will be destroyed",
        );
        onRollbackFailure(normalized);
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
export async function runSeeds(pool: Queryable): Promise<void> {
  await seedPromptLibrary(pool);
  await seedSlaThresholdDefaults(pool);
  await seedBackupConfigDefaults(pool);
}

// ---------------------------------------------------------------------------
// Seed: prompt library
// ---------------------------------------------------------------------------

async function seedPromptLibrary(pool: Queryable): Promise<void> {
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
    // Scope the existence probe to the global namespace (org_id IS NULL).
    // Pre-#2169 deployments could have org-scoped builtin copies with the
    // same name; without this filter, those would short-circuit the insert
    // and the global builtin would never get seeded on a fresh install
    // that runs alongside legacy data. Note that the unique index added
    // in migration 0054 (`prompt_collections_org_name_uniq`) makes a
    // future regression here impossible to silently introduce — a
    // duplicate-creating loosening of this filter would fail-fast on
    // INSERT instead of producing two visible rows.
    const existing = await pool.query(
      "SELECT id FROM prompt_collections WHERE name = $1 AND is_builtin = true AND org_id IS NULL",
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

async function seedSlaThresholdDefaults(pool: Queryable): Promise<void> {
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

async function seedBackupConfigDefaults(pool: Queryable): Promise<void> {
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
