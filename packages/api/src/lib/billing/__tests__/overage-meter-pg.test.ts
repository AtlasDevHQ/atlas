/**
 * Real-Postgres coverage for the OverageMeter ledger + sweep (#3992).
 * Mirrors the `reconcile-plan-tiers-pg.test.ts` harness: skips cleanly when
 * `TEST_DATABASE_URL` is unset, runs every migration into a unique per-test
 * schema, and exercises the ACTUAL SQL against the real schema.
 *
 * What this catches that the mock-based `overage-meter.test.ts` can't:
 *   - The `recordOverageReport` upsert's `GREATEST(...)` MONOTONICITY — the
 *     property that makes a late/retried tick unable to regress the cumulative
 *     (and so unable to re-bill). The unit test only string-matches the SQL.
 *   - The `chk_overage_meter_reports_cost_cents_nonneg` CHECK (migration 0156)
 *     actually rejecting a negative cumulative.
 *   - The `reportPeriodOverages` scan SELECT, which reads `organization.byot`,
 *     `.plan_tier`, `."stripeCustomerId"` and joins `subscription` — exactly
 *     the `column "X" does not exist` class that broke the plan-tier reconcile
 *     in prod and passes every mock test. `organization` is Better-Auth-owned
 *     and skipped in this run (MANAGED_AUTH_MIGRATIONS), so the fixture builds
 *     the minimal columns the scan reads; `subscription` is created by 0153.
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
import {
  getReportedOverageCents,
  recordOverageReport,
  reportPeriodOverages,
  type OverageWorkspaceRow,
} from "@atlas/api/lib/billing/overage-meter";
import { _resetStripeClientCache } from "@atlas/api/lib/billing/stripe-client";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TEST_TIMEOUT_MS = 30_000;
const PERIOD = "2026-06-01T00:00:00.000Z";

describeIfPg("OverageMeter ledger + sweep (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `overage_meter_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
  const ORIGINAL_STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`overage-meter-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });

    // Minimal Better-Auth-owned `organization` — only the columns the sweep
    // scan reads (`plan_tier`, `byot`, `"stripeCustomerId"`). `subscription` is
    // created by migration 0153 during runMigrations; `overage_meter_reports`
    // by our migration 0154 (a regular migration, not BA-managed).
    await pool.query(
      `CREATE TABLE organization (
         id text PRIMARY KEY,
         name text,
         slug text,
         plan_tier text NOT NULL DEFAULT 'free',
         byot boolean,
         "stripeCustomerId" text
       )`,
    );

    process.env.DATABASE_URL = TEST_DB_URL;
    // A dummy test key makes getStripeClient() return a client (no network at
    // construction) so reportPeriodOverages reaches the scan; the injected
    // reportOne never touches Stripe.
    process.env.STRIPE_SECRET_KEY = "sk_test_overage_pg_dummy";
    _resetStripeClientCache();
    _resetPool(pool as unknown as InternalPool, null);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null, null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    if (ORIGINAL_STRIPE_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = ORIGINAL_STRIPE_KEY;
    _resetStripeClientCache();
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM overage_meter_reports`);
    await pool.query(`DELETE FROM subscription`);
    await pool.query(`DELETE FROM organization`);
  });

  async function seedOrg(opts: {
    id: string;
    planTier: string;
    byot?: boolean | null;
    stripeCustomerId?: string | null;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO organization (id, name, slug, plan_tier, byot, "stripeCustomerId")
       VALUES ($1, $1, $1, $2, $3, $4)`,
      [opts.id, opts.planTier, opts.byot ?? null, opts.stripeCustomerId ?? null],
    );
  }

  async function seedSubscription(opts: {
    org: string;
    status: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO subscription (id, plan, "referenceId", "stripeSubscriptionId", status, "periodStart")
       VALUES ($1, 'starter', $2, $1, $3, now())`,
      [`sub-${opts.org}`, opts.org, opts.status],
    );
  }

  it(
    "advances the cumulative cents monotonically — GREATEST keeps a late/retried lower tick from regressing it",
    async () => {
      const base = {
        orgId: "org_mono",
        periodStartISO: PERIOD,
        stripeCustomerId: "cus_mono",
      };
      await recordOverageReport({ ...base, reportedCents: 500, eventIdentifier: "id_0" });
      expect(await getReportedOverageCents("org_mono", PERIOD)).toBe(500);

      // A stale/retried tick carrying a LOWER cumulative must not regress it.
      await recordOverageReport({ ...base, reportedCents: 300, eventIdentifier: "id_stale" });
      expect(await getReportedOverageCents("org_mono", PERIOD)).toBe(500);

      // A genuine advance moves it forward.
      await recordOverageReport({ ...base, reportedCents: 700, eventIdentifier: "id_1" });
      expect(await getReportedOverageCents("org_mono", PERIOD)).toBe(700);
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "enforces the non-negative CHECK on reported_cost_cents",
    async () => {
      // Assert the SPECIFIC non-negative CHECK fired (not just any SQL error).
      await expect(
        pool.query(
          `INSERT INTO overage_meter_reports (org_id, period_start, stripe_customer_id, reported_cost_cents)
           VALUES ('org_neg', $1, 'cus', -1)`,
          [PERIOD],
        ),
      ).rejects.toThrow("chk_overage_meter_reports_cost_cents_nonneg");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "scans only paid, non-BYOT workspaces with a Stripe customer and an active subscription",
    async () => {
      // Included.
      await seedOrg({ id: "inc_starter", planTier: "starter", byot: false, stripeCustomerId: "cus_a" });
      await seedSubscription({ org: "inc_starter", status: "active" });
      await seedOrg({ id: "inc_pro_nullbyot", planTier: "pro", byot: null, stripeCustomerId: "cus_b" });
      await seedSubscription({ org: "inc_pro_nullbyot", status: "active" });
      // Excluded — BYOT.
      await seedOrg({ id: "exc_byot", planTier: "business", byot: true, stripeCustomerId: "cus_c" });
      await seedSubscription({ org: "exc_byot", status: "active" });
      // Excluded — no Stripe customer.
      await seedOrg({ id: "exc_nocus", planTier: "starter", byot: false, stripeCustomerId: null });
      await seedSubscription({ org: "exc_nocus", status: "active" });
      // Excluded — subscription not active.
      await seedOrg({ id: "exc_trialing", planTier: "starter", byot: false, stripeCustomerId: "cus_e" });
      await seedSubscription({ org: "exc_trialing", status: "trialing" });
      // Excluded — non-paid tier.
      await seedOrg({ id: "exc_trial_tier", planTier: "trial", byot: false, stripeCustomerId: "cus_f" });
      await seedSubscription({ org: "exc_trial_tier", status: "active" });
      // Excluded — no subscription row at all.
      await seedOrg({ id: "exc_nosub", planTier: "starter", byot: false, stripeCustomerId: "cus_g" });

      const seen: string[] = [];
      const result = await reportPeriodOverages(new Date(), async (_s, row: OverageWorkspaceRow) => {
        seen.push(row.org_id);
        return "skipped";
      });

      expect(seen.toSorted()).toEqual(["inc_pro_nullbyot", "inc_starter"]);
      expect(result.scanned).toBe(2);
    },
    PG_TEST_TIMEOUT_MS,
  );
});
