/**
 * Tests for the boot-time SaaS trial backfill (`backfillSaasTrial`).
 *
 * Pairs with the signup-time `assignSaasTrial` hook (#2465): the hook
 * handles every new org, the backfill retires legacy 'free' rows the
 * hook didn't run for. PRD #2464. Since #3426 it applies the same
 * one-trial-per-user rule: free orgs with a trial-consumed owner are
 * demoted to 'locked' (statement 1) before the promote arm runs
 * (statement 2), so a hook failure + reboot can't mint a second trial.
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
  /** Rows returned by the lock-first #3426 arm (plan_tier = 'locked'). */
  lockedIds?: string[];
  updateThrows?: boolean;
}): MockPool {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (opts.updateThrows) throw new Error("UPDATE failed");
      const ids = /plan_tier = 'locked'/.test(sql)
        ? opts.lockedIds ?? []
        : opts.updatedIds ?? [];
      const rows = ids.map((id) => ({ id }));
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
    expect(result.lockedOrgIds).toEqual([]);
    expect(queries).toHaveLength(2);

    // Statement 1 — the #3426 lock arm runs FIRST so the promote arm can
    // never see a trial-consumed owner's org.
    expect(queries[0].sql).toMatch(/plan_tier = 'locked'/);
    expect(queries[0].sql).toMatch(/trial_ends_at IS NOT NULL/);
    // Eligibility keys on owner membership, mirroring trial-eligibility.ts.
    expect(queries[0].sql).toMatch(/role = 'owner'/);

    // Statement 2 — the promote arm.
    expect(queries[1].sql).toMatch(/UPDATE organization/);
    // The idempotency guards must survive any future rewrite.
    expect(queries[1].sql).toMatch(/plan_tier = 'free'/);
    expect(queries[1].sql).toMatch(/trial_ends_at IS NULL/);

    const [trialEndsAtParam] = queries[1].params ?? [];
    const trialEndsAt = new Date(String(trialEndsAtParam)).getTime();
    const target = before + TRIAL_DAYS * DAY_MS;
    expect(trialEndsAt).toBeGreaterThanOrEqual(target);
    expect(trialEndsAt).toBeLessThanOrEqual(after + TRIAL_DAYS * DAY_MS);
  });

  it("locks free orgs whose owner already consumed a trial instead of promoting them (#3426)", async () => {
    const { pool, queries } = makeMockPool({
      lockedIds: ["org_second"],
      updatedIds: ["org_first"],
    });
    _resetPool(pool);

    const result = await backfillSaasTrial();

    expect(result.lockedOrgIds).toEqual(["org_second"]);
    expect(result.updatedCount).toBe(1);
    expect(result.orgIds).toEqual(["org_first"]);
    // The lock arm stamps the trial as consumed-now so checkout's
    // double-trial suppression holds for the locked org too.
    expect(queries[0].sql).toMatch(/trial_ends_at = NOW\(\)/);
  });

  it("returns 0 with no error when there's nothing to backfill", async () => {
    const { pool, queries } = makeMockPool({ updatedIds: [] });
    _resetPool(pool);

    const result = await backfillSaasTrial();

    expect(result.updatedCount).toBe(0);
    expect(result.orgIds).toEqual([]);
    expect(result.lockedOrgIds).toEqual([]);
    // Both UPDATEs still run — RETURNING is what tells us there were
    // zero candidates. Re-running on the next boot is the same no-op
    // call shape.
    expect(queries).toHaveLength(2);
  });

  it("is idempotent across two boots — second call promotes zero rows", async () => {
    // Simulates the real Postgres behaviour: first boot finds the
    // legacy 'free' rows and updates them; second boot's UPDATEs see
    // `trial_ends_at IS NOT NULL` and the WHERE clauses match nothing,
    // so RETURNING is empty. End-to-end check on the PRD's hard
    // idempotency requirement — the WHERE-clause regex elsewhere only
    // asserts the clause is *present*.
    let promoteCalls = 0;
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (/plan_tier = 'locked'/.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        promoteCalls += 1;
        const rows = promoteCalls === 1
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

    expect(queries).toHaveLength(4);
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
