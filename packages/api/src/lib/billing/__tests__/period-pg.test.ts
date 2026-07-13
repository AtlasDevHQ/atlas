/**
 * Real-Postgres coverage for `resolveBillingPeriod` (#3431 follow-up).
 * Mirrors the `reconcile-plan-tiers-pg.test.ts` harness: skips cleanly when
 * `TEST_DATABASE_URL` is unset, runs every migration into a unique per-test
 * schema, and exercises the resolver's ACTUAL query against the real schema.
 *
 * What this catches that the mock-based `period.test.ts` can't:
 *   - `period.test.ts` scripts the result rows via a mocked `internalQuery`, so
 *     the resolver's SELECT is never executed. Ordering by a column that does
 *     not exist on Better Auth's `subscription` table — the shipped query used
 *     `ORDER BY "updatedAt"`, and the table has no updatedAt/createdAt — passes
 *     every mock test but throws `column "updatedAt" does not exist` (42703)
 *     here against the real table. That threw on EVERY call, so the resolver's
 *     best-effort read always hit its catch and silently fell back to the UTC
 *     month, un-anchoring every metered workspace from its real Stripe period.
 *     The `subscription` table has no creation timestamp; `periodStart` is the
 *     newest-subscription proxy (same fix as reconcile-plan-tiers.ts).
 *
 * `subscription` is created by migration 0153 (#4019 region-DB parity) during
 * `runMigrations` — the full @better-auth/stripe shape, still no updatedAt —
 * so this suite needs no hand-built fixture.
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
import { resolveBillingPeriod } from "@atlas/api/lib/billing/period";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

// The full migration set can take several seconds on shared CI runners
// (matches migrate-pg.test.ts's 30s budget).
const PG_TEST_TIMEOUT_MS = 30_000;

describeIfPg("resolveBillingPeriod (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `period_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`period-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });

    // Point the resolver's module pool (`internalQuery`/`hasInternalDB`) at
    // this scratch-schema pool, and make `hasInternalDB()` true.
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
  });

  async function seedSubscription(opts: {
    id: string;
    org: string;
    plan: string;
    status?: string;
    periodStart: string; // SQL expression, e.g. "now()" or "now() - interval '30 days'"
    periodEnd: string; // SQL expression
  }): Promise<void> {
    await pool.query(
      `INSERT INTO subscription (id, plan, "referenceId", status, "periodStart", "periodEnd")
       VALUES ($1, $2, $3, $4, ${opts.periodStart}, ${opts.periodEnd})`,
      [opts.id, opts.plan, opts.org, opts.status ?? "active"],
    );
  }

  it(
    "anchors on an active subscription's Stripe period (runs the real SELECT against the real schema)",
    async () => {
      const org = `org-anchor-${Date.now()}`;
      // A live period bracketing `now` — anchors instead of falling back.
      await seedSubscription({
        id: `s-${org}`,
        org,
        plan: "pro",
        periodStart: "now() - interval '5 days'",
        periodEnd: "now() + interval '25 days'",
      });

      const period = await resolveBillingPeriod(org, new Date());

      // If the resolver's ORDER BY named a non-existent column, the query would
      // throw 42703, the catch would fire, and source would be 'utc-month'.
      expect(period.source).toBe("stripe");
    },
    PG_TEST_TIMEOUT_MS,
  );

  it(
    "orders by periodStart — among multiple active subscriptions the newest period wins (guards the fixed ORDER BY)",
    async () => {
      const org = `org-multi-${Date.now()}`;
      // Older active period — must LOSE the LIMIT 1 ordering.
      await seedSubscription({
        id: `s-old-${org}`,
        org,
        plan: "starter",
        periodStart: "now() - interval '40 days'",
        periodEnd: "now() - interval '10 days'",
      });
      // Newer active period, bracketing now — must WIN (ORDER BY periodStart DESC).
      const newStart = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      const newEnd = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO subscription (id, plan, "referenceId", status, "periodStart", "periodEnd")
         VALUES ($1, 'pro', $2, 'active', $3, $4)`,
        [`s-new-${org}`, org, newStart.toISOString(), newEnd.toISOString()],
      );

      const period = await resolveBillingPeriod(org, new Date());

      // The newest-period subscription anchors the window, not the stale older row.
      expect(period.source).toBe("stripe");
      expect(period.start.toISOString()).toBe(newStart.toISOString());
      expect(period.end.toISOString()).toBe(newEnd.toISOString());
    },
    PG_TEST_TIMEOUT_MS,
  );
});
