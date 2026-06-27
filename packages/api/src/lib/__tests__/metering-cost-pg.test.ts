/**
 * Real-Postgres coverage for the at-cost `costUsd` period aggregate (#4036).
 * Mirrors the `overage-meter-pg.test.ts` harness: skips cleanly when
 * `TEST_DATABASE_URL` is unset, runs every migration into a unique per-test
 * schema, and exercises the ACTUAL SQL against the real schema.
 *
 * What this catches that the mock-based `metering.test.ts` can't — the runtime
 * behavior of `getCurrentPeriodUsage`'s new
 * `COALESCE(SUM(CASE WHEN event_type = 'token' THEN gateway_cost_usd ELSE 0 END), 0)::float8`:
 *   - that `SUM(numeric)::float8` comes back from `pg` as a JS **number**, not a
 *     numeric string (the class `platform-demo-pg` was built to catch);
 *   - that NULL `gateway_cost_usd` rows (non-gateway turns) are SKIPPED by the
 *     SUM rather than poisoning it to NULL;
 *   - that non-`token` events never contribute to the cost basis;
 *   - the all-NULL → 0 floor.
 *
 * Opt in locally with:
 *   bun run db:up && export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "@atlas/api/lib/db/migrate";
import {
  MANAGED_AUTH_MIGRATIONS,
  _resetPool,
  type InternalPool,
} from "@atlas/api/lib/db/internal";
import { getCurrentPeriodUsage } from "@atlas/api/lib/metering";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeIfPg = TEST_DB_URL ? describe : describe.skip;

const PG_TEST_TIMEOUT_MS = 30_000;

describeIfPg("getCurrentPeriodUsage costUsd aggregate (real Postgres)", () => {
  let pool: Pool;
  const schemaName = `metering_cost_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO "${schemaName}"`).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`metering-cost-pg: SET search_path failed: ${message}`);
      });
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    // usage_events + subscription (the only tables getCurrentPeriodUsage touches)
    // are created by regular migrations; no Better-Auth tables are needed —
    // resolveBillingPeriod falls back to the UTC month when no subscription row
    // exists, which is exactly what we want here.
    await runMigrations(pool, { skip: MANAGED_AUTH_MIGRATIONS });

    process.env.DATABASE_URL = TEST_DB_URL;
    _resetPool(pool as unknown as InternalPool, null);
  }, PG_TEST_TIMEOUT_MS);

  afterAll(async () => {
    _resetPool(null, null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {});
    await pool.end();
  });

  async function insertEvent(
    workspaceId: string,
    eventType: "token" | "query",
    quantity: number,
    gatewayCostUsd: number | null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO usage_events (workspace_id, event_type, quantity, weighted_quantity, gateway_cost_usd)
       VALUES ($1, $2, $3, $4, $5)`,
      [workspaceId, eventType, quantity, eventType === "token" ? quantity : null, gatewayCostUsd],
    );
  }

  it("sums gateway_cost_usd over token rows, skips NULL + non-token, returns a JS number", async () => {
    const ws = `ws-cost-${Math.floor(Math.random() * 1e6)}`;
    await insertEvent(ws, "token", 1000, 0.1);
    await insertEvent(ws, "token", 2000, 0.2);
    await insertEvent(ws, "token", 500, null); // non-gateway turn — must be skipped, not poison the SUM
    await insertEvent(ws, "query", 1, 9.99); // non-token — must never contribute to cost

    const usage = await getCurrentPeriodUsage(ws);

    expect(typeof usage.costUsd).toBe("number"); // ::float8 → JS number, not a numeric string
    expect(usage.costUsd).toBeCloseTo(0.3, 6); // 0.1 + 0.2; NULL skipped, query excluded
    expect(usage.tokenCount).toBe(3500); // 1000 + 2000 + 500
    expect(usage.queryCount).toBe(1);
  });

  it("returns costUsd 0 when every token row has a NULL gateway_cost_usd", async () => {
    const ws = `ws-null-${Math.floor(Math.random() * 1e6)}`;
    await insertEvent(ws, "token", 1000, null);
    await insertEvent(ws, "token", 2000, null);

    const usage = await getCurrentPeriodUsage(ws);

    expect(usage.costUsd).toBe(0);
    expect(usage.tokenCount).toBe(3000);
  });
});
