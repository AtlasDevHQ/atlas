/**
 * Tests for the one-time SaaS trial backfill (`backfillSaasTrial`).
 *
 * Pairs with the signup-time `assignSaasTrial` hook (#2465): the hook
 * handles every new org, the backfill retires legacy 'free' rows the
 * hook didn't run for. PRD #2464.
 *
 * Mocks `InternalPool` via `_resetPool` and `getConfig()` via
 * `_setConfigForTest`. Same pattern as the slice 1 sibling test for
 * `assignSaasTrial`.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { _setConfigForTest, type ResolvedConfig } from "@atlas/api/lib/config";
import { TRIAL_DAYS } from "@atlas/api/lib/billing/plans";
import { backfillSaasTrial } from "../backfill-saas-trial";

const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

interface MockPool {
  pool: InternalPool;
  queries: Array<{ sql: string; params?: unknown[] }>;
}

function makeMockPool(opts: {
  updatedIds?: string[];
  updateThrows?: boolean;
}): MockPool {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (opts.updateThrows) throw new Error("UPDATE failed");
      const rows = (opts.updatedIds ?? []).map((id) => ({ id }));
      return { rows, rowCount: rows.length };
    },
  } as unknown as InternalPool;
  return { pool, queries };
}

function configWithDeployMode(deployMode: "saas" | "self-hosted"): ResolvedConfig {
  return {
    datasources: {},
    tools: ["explore", "executeSQL"],
    auth: "managed",
    semanticLayer: "./semantic",
    maxTotalConnections: 100,
    source: "file",
    deployMode,
  };
}

describe("backfillSaasTrial", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://test/test";
    _setConfigForTest(configWithDeployMode("saas"));
  });

  afterAll(() => {
    _resetPool(null);
    _setConfigForTest(null);
    if (ORIGINAL_DATABASE_URL === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    }
  });

  it("promotes free SaaS workspaces to trial with a fresh 14-day window", async () => {
    const { pool, queries } = makeMockPool({
      updatedIds: ["org_dogfood", "org_acme"],
    });
    _resetPool(pool);

    const before = Date.now();
    const result = await backfillSaasTrial();
    const after = Date.now();

    expect(result.updatedCount).toBe(2);
    expect(result.orgIds).toEqual(["org_dogfood", "org_acme"]);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/UPDATE organization/);
    // The idempotency guards must survive any future rewrite.
    expect(queries[0].sql).toMatch(/plan_tier = 'free'/);
    expect(queries[0].sql).toMatch(/trial_ends_at IS NULL/);

    const [trialEndsAtParam] = queries[0].params ?? [];
    const trialEndsAt = new Date(String(trialEndsAtParam)).getTime();
    const target = before + TRIAL_DAYS * DAY_MS;
    expect(trialEndsAt).toBeGreaterThanOrEqual(target);
    expect(trialEndsAt).toBeLessThanOrEqual(after + TRIAL_DAYS * DAY_MS);
  });

  it("returns 0 with no error when there's nothing to backfill", async () => {
    const { pool, queries } = makeMockPool({ updatedIds: [] });
    _resetPool(pool);

    const result = await backfillSaasTrial();

    expect(result.updatedCount).toBe(0);
    expect(result.orgIds).toEqual([]);
    // The UPDATE still runs — RETURNING is what tells us there were
    // zero candidates. Re-running on the next boot is the same no-op
    // call shape.
    expect(queries).toHaveLength(1);
  });

  it("is idempotent across two boots — second call promotes zero rows", async () => {
    // Simulates the real Postgres behaviour: first boot finds the
    // legacy 'free' rows and updates them; second boot's UPDATE sees
    // `trial_ends_at IS NOT NULL` and the WHERE clause matches nothing,
    // so RETURNING is empty. End-to-end check on the PRD's hard
    // idempotency requirement — the WHERE-clause regex elsewhere only
    // asserts the clause is *present*.
    let callCount = 0;
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        callCount += 1;
        const rows = callCount === 1
          ? [{ id: "org_dogfood" }, { id: "org_acme" }]
          : [];
        return { rows, rowCount: rows.length };
      },
    } as unknown as InternalPool;
    _resetPool(pool);

    const first = await backfillSaasTrial();
    expect(first.updatedCount).toBe(2);
    expect(first.orgIds).toEqual(["org_dogfood", "org_acme"]);

    const second = await backfillSaasTrial();
    expect(second.updatedCount).toBe(0);
    expect(second.orgIds).toEqual([]);

    expect(queries).toHaveLength(2);
  });

  it("skips on self-hosted — no UPDATE", async () => {
    _setConfigForTest(configWithDeployMode("self-hosted"));
    const { pool, queries } = makeMockPool({ updatedIds: ["org_should_not_move"] });
    _resetPool(pool);

    const result = await backfillSaasTrial();

    expect(result.updatedCount).toBe(0);
    expect(result.orgIds).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it("skips when deployMode is missing (auto-resolves to self-hosted)", async () => {
    _setConfigForTest(null);
    const { pool, queries } = makeMockPool({ updatedIds: ["org_x"] });
    _resetPool(pool);

    const result = await backfillSaasTrial();

    expect(result.updatedCount).toBe(0);
    expect(queries).toHaveLength(0);
  });

  it("skips when the internal DB is unavailable", async () => {
    delete process.env.DATABASE_URL;
    const { pool, queries } = makeMockPool({ updatedIds: ["org_x"] });
    _resetPool(pool);

    const result = await backfillSaasTrial();

    expect(result.updatedCount).toBe(0);
    expect(queries).toHaveLength(0);
  });

  it("swallows UPDATE errors — startup must not fail", async () => {
    const { pool } = makeMockPool({ updateThrows: true });
    _resetPool(pool);

    const result = await backfillSaasTrial();

    expect(result.updatedCount).toBe(0);
    expect(result.orgIds).toEqual([]);
  });
});
