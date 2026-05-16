/**
 * Regression coverage for the SaaS-signup trial assignment hook
 * ({@link assignSaasTrial}).
 *
 * Without this hook, every SaaS workspace lands on `plan_tier='free'`
 * (the DB column default) and `/admin/model-config` renders the literal
 * `"user-configured"` sentinel from `plans.ts`. The hook's contract:
 *
 *   - SaaS + new org with default tier → flip to `'trial'` + set
 *     `trial_ends_at = NOW() + 14d`.
 *   - Self-hosted → no-op (free is the legitimate self-hosted tier).
 *   - No internal DB → no-op, no throw (auth should still work).
 *   - Already on a non-default tier → no-op (preserve platform-admin
 *     pre-seeded orgs and re-invocation safety).
 *   - SELECT or UPDATE throws → log + swallow (mirror
 *     `promoteOrgOwnerToAdmin`; never block org creation).
 *
 * Same caveat as `org-owner-promotion.test.ts`: this test exercises the
 * function in isolation. It cannot catch a refactor that deletes the
 * `afterCreateOrganization` composition in `buildPlugins()` — Better
 * Auth closes over plugin options, so the wiring isn't introspectable.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { _setConfigForTest, type ResolvedConfig } from "@atlas/api/lib/config";
import { TRIAL_DAYS } from "@atlas/api/lib/billing/plans";
import { assignSaasTrial } from "../server";

const USER = { id: "user_test_123" };
const ORG = { id: "org_test_456" };
const DAY_MS = 24 * 60 * 60 * 1000;

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

interface MockPool {
  pool: InternalPool;
  queries: Array<{ sql: string; params?: unknown[] }>;
}

function makeMockPool(opts: {
  selectTier?: string | null;
  selectThrows?: boolean;
  updateThrows?: boolean;
}): MockPool {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      const isSelect = /^\s*SELECT\b/i.test(sql);
      if (isSelect) {
        if (opts.selectThrows) throw new Error("connection refused");
        return {
          rows: opts.selectTier === undefined
            ? [{ plan_tier: "free" }]
            : opts.selectTier === null
              ? []
              : [{ plan_tier: opts.selectTier }],
          rowCount: 1,
        };
      }
      if (opts.updateThrows) throw new Error("UPDATE failed");
      return { rows: [], rowCount: 1 };
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

describe("assignSaasTrial — body", () => {
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

  it("flips a free SaaS workspace to trial with a 14-day expiry", async () => {
    const { pool, queries } = makeMockPool({ selectTier: "free" });
    _resetPool(pool);

    const before = Date.now();
    await assignSaasTrial({ user: USER, organization: ORG });
    const after = Date.now();

    expect(queries).toHaveLength(2);
    expect(queries[0].sql).toMatch(/SELECT plan_tier FROM organization/);
    expect(queries[1].sql).toMatch(
      /UPDATE organization SET plan_tier = 'trial', trial_ends_at/,
    );
    // Belt-and-suspenders: the UPDATE re-asserts the free guard.
    expect(queries[1].sql).toMatch(/AND plan_tier = 'free'/);

    const [trialEndsAtParam, orgIdParam] = queries[1].params ?? [];
    expect(orgIdParam).toBe(ORG.id);
    const trialEndsAt = new Date(String(trialEndsAtParam)).getTime();
    const target = before + TRIAL_DAYS * DAY_MS;
    expect(trialEndsAt).toBeGreaterThanOrEqual(target);
    expect(trialEndsAt).toBeLessThanOrEqual(after + TRIAL_DAYS * DAY_MS);
  });

  it("skips on self-hosted — no SELECT, no UPDATE", async () => {
    _setConfigForTest(configWithDeployMode("self-hosted"));
    const { pool, queries } = makeMockPool({ selectTier: "free" });
    _resetPool(pool);

    await assignSaasTrial({ user: USER, organization: ORG });

    expect(queries).toHaveLength(0);
  });

  it("skips when deployMode is missing (auto-resolves to self-hosted)", async () => {
    _setConfigForTest(null);
    const { pool, queries } = makeMockPool({ selectTier: "free" });
    _resetPool(pool);

    await assignSaasTrial({ user: USER, organization: ORG });

    expect(queries).toHaveLength(0);
  });

  it("skips when the internal DB is unavailable", async () => {
    delete process.env.DATABASE_URL;
    const { pool, queries } = makeMockPool({ selectTier: "free" });
    _resetPool(pool);

    await assignSaasTrial({ user: USER, organization: ORG });

    expect(queries).toHaveLength(0);
  });

  it("is idempotent — does not re-assign an existing trial", async () => {
    const { pool, queries } = makeMockPool({ selectTier: "trial" });
    _resetPool(pool);

    await assignSaasTrial({ user: USER, organization: ORG });

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/SELECT/);
  });

  it("does not clobber a paid tier (platform-admin pre-seeded org)", async () => {
    const { pool, queries } = makeMockPool({ selectTier: "pro" });
    _resetPool(pool);

    await assignSaasTrial({ user: USER, organization: ORG });

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/SELECT/);
  });

  it("does not throw when the SELECT fails — failure is logged, signup continues", async () => {
    const { pool } = makeMockPool({ selectThrows: true });
    _resetPool(pool);

    // Throwing here would block org creation — strictly worse than
    // landing in a recoverable state where plan_tier stays "free".
    await expect(
      assignSaasTrial({ user: USER, organization: ORG }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when the UPDATE fails", async () => {
    const { pool } = makeMockPool({ selectTier: "free", updateThrows: true });
    _resetPool(pool);

    await expect(
      assignSaasTrial({ user: USER, organization: ORG }),
    ).resolves.toBeUndefined();
  });
});
