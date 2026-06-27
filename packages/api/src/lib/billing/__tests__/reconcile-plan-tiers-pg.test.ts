/**
 * Real-Postgres coverage for the plan-tier reconciliation sweep (#3423).
 * Mirrors the `chat-cap-pg.test.ts` harness: skips cleanly when
 * `TEST_DATABASE_URL` is unset, runs every migration into a unique per-test
 * schema, and exercises the sweep's ACTUAL query against the real schema.
 *
 * What this catches that the mock-based `reconcile-plan-tiers.test.ts` can't:
 *   - The sweep's main SELECT is never executed by the unit test (it scripts
 *     the result rows via a mocked `internalQuery`). A column that doesn't
 *     exist on Better Auth's `subscription` table — e.g. ordering by a
 *     non-existent `s."createdAt"` (PG: `column s.createdAt does not exist`,
 *     which silently broke EVERY reconcile pass and 503'd staging's health
 *     when surfaced through the datasource probe) — passes every unit test but
 *     throws here against the real table. The `subscription` table has no
 *     creation timestamp; `periodStart` is the newest-subscription proxy.
 *
 * `organization` is owned by Better Auth in production, so it is not in our
 * migration set — the fixture creates the minimal columns the sweep's query and
 * heal-write read (mirrors chat-cap-pg's `organization` fixture). `subscription`
 * IS now created by `runMigrations` (migration 0152, #4019 region-DB parity), so
 * this suite no longer hand-builds it: 0152's shape already has every column the
 * sweep reads and, crucially, still no `createdAt`. `stripe_webhook_events`
 * (0128) + `stripe_purged_subscriptions` (0129) are likewise regular migrations.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  MANAGED_AUTH_MIGRATIONS,
  _resetPool,
  type InternalPool,
} from "@atlas/api/lib/db/internal";
import { reconcilePlanTiers } from "@atlas/api/lib/billing/reconcile-plan-tiers";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

// The full migration set can take several seconds on shared CI runners
// (matches migrate-pg.test.ts's 30s budget).
const PG_TEST_TIMEOUT_MS = 30_000;

describeIfPg("reconcilePlanTiers (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `reconcile_pt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`reconcile-plan-tiers-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });

    // Minimal Better-Auth-owned `organization` — only the columns the sweep's
    // SELECT (`plan_tier`, `plan_override_until`) and `updateWorkspacePlanTier`
    // write read. Nullable `plan_override_until` mirrors migration 0132.
    await pool.query(
      `CREATE TABLE organization (
         id text PRIMARY KEY,
         name text,
         slug text,
         plan_tier text NOT NULL DEFAULT 'free',
         plan_override_until timestamptz
       )`,
    );
    // `subscription` is created by migration 0152 (#4019 region-DB parity)
    // during `runMigrations` above — the full @better-auth/stripe shape, and
    // (the property this suite guards) still NO `createdAt` column, so the
    // sweep's newest-period proxy remains `periodStart`. No hand-built fixture.

    // Point the sweep's module pool (`internalQuery`/`updateWorkspacePlanTier`)
    // at this scratch-schema pool, and make `hasInternalDB()` true.
    process.env.DATABASE_URL = TEST_DB_URL;
    _resetPool(pool as unknown as InternalPool, null);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null, null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM subscription`);
    await pool.query(`DELETE FROM organization`);
  });

  async function seedOrg(id: string, planTier: string): Promise<void> {
    await pool.query(
      `INSERT INTO organization (id, name, slug, plan_tier) VALUES ($1, $1, $1, $2)`,
      [id, planTier],
    );
  }

  async function seedSubscription(opts: {
    id: string;
    org: string;
    plan: string;
    stripeSubscriptionId: string;
    status?: string;
    periodStart: string; // SQL expression, e.g. "now()" or "now() - interval '30 days'"
  }): Promise<void> {
    await pool.query(
      `INSERT INTO subscription (id, plan, "referenceId", "stripeSubscriptionId", status, "periodStart")
       VALUES ($1, $2, $3, $4, $5, ${opts.periodStart})`,
      [opts.id, opts.plan, opts.org, opts.stripeSubscriptionId, opts.status ?? "active"],
    );
  }

  it(
    "heals an org whose plan_tier drifted below its active subscription (runs the real SELECT against the real schema)",
    async () => {
      const org = `org-heal-${Date.now()}`;
      await seedOrg(org, "free"); // drifted: org says free
      await seedSubscription({
        id: `s-${org}`,
        org,
        plan: "pro", // subscription says pro
        stripeSubscriptionId: "sub_heal_1",
        periodStart: "now()",
      });

      const result = await reconcilePlanTiers();
      expect(result.healed).toBe(1);

      const { rows } = await pool.query<{ plan_tier: string }>(
        `SELECT plan_tier FROM organization WHERE id = $1`,
        [org],
      );
      expect(rows[0]?.plan_tier).toBe("pro");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "orders by periodStart — among multiple active subscriptions the newest period's plan wins (guards the fixed ORDER BY)",
    async () => {
      const org = `org-multi-${Date.now()}`;
      await seedOrg(org, "free");
      // Older period — starter — must LOSE the LIMIT 1 ordering.
      await seedSubscription({
        id: `s-old-${org}`,
        org,
        plan: "starter",
        stripeSubscriptionId: "sub_old",
        periodStart: "now() - interval '30 days'",
      });
      // Newer period — pro — must WIN (ORDER BY periodStart DESC).
      await seedSubscription({
        id: `s-new-${org}`,
        org,
        plan: "pro",
        stripeSubscriptionId: "sub_new",
        periodStart: "now()",
      });

      const result = await reconcilePlanTiers();
      expect(result.healed).toBe(1);

      const { rows } = await pool.query<{ plan_tier: string }>(
        `SELECT plan_tier FROM organization WHERE id = $1`,
        [org],
      );
      // The newest-period subscription (pro) drives the heal, not the older starter.
      expect(rows[0]?.plan_tier).toBe("pro");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "leaves a paid-tier org with no active subscription untouched (flag-don't-heal)",
    async () => {
      const org = `org-flag-${Date.now()}`;
      await seedOrg(org, "pro"); // paid tier, but no subscription row

      const result = await reconcilePlanTiers();
      expect(result.healed).toBe(0);
      expect(result.flagged).toBe(1);

      const { rows } = await pool.query<{ plan_tier: string }>(
        `SELECT plan_tier FROM organization WHERE id = $1`,
        [org],
      );
      expect(rows[0]?.plan_tier).toBe("pro"); // unchanged
    },
    PG_TEST_TIMEOUT_MS,
  );
});
