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
 *   - One trial per user (#3426): a creator who already owns a trialed
 *     org gets `'locked'` (+ `trial_ends_at = NOW()` consumed stamp)
 *     instead of a fresh trial. The eligibility key is owner membership
 *     of any OTHER org with `trial_ends_at` set — see
 *     `lib/billing/trial-eligibility.ts` for the recorded policy.
 *   - Self-hosted → no-op (free is the legitimate self-hosted tier).
 *   - No internal DB → no-op, no throw (auth should still work).
 *   - Already on a non-default tier → no-op (preserve platform-admin
 *     pre-seeded orgs and re-invocation safety).
 *   - SELECT or UPDATE throws → log + swallow (never block org creation).
 *
 * Caveat: this test exercises the function in isolation. It cannot catch a
 * refactor that deletes the `afterCreateOrganization` composition in
 * `buildPlugins()` — Better Auth closes over plugin options, so the wiring
 * isn't introspectable. The `databaseHooks-wiring.test.ts` wiring test covers
 * that gap by driving the composed hook.
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
  /** Eligibility lookup (#3426): creator already owns a trialed org. */
  trialConsumedElsewhere?: boolean;
  /** Eligibility lookup throws (DB blip mid-hook). */
  eligibilityThrows?: boolean;
}): MockPool {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      // The #3426 eligibility lookup joins member → organization on the
      // trial-consumed stamp. Dispatch it before the generic SELECT arm.
      if (/FROM\s+member/i.test(sql)) {
        if (opts.eligibilityThrows) throw new Error("eligibility lookup failed");
        return {
          rows: opts.trialConsumedElsewhere ? [{ consumed: 1 }] : [],
          rowCount: opts.trialConsumedElsewhere ? 1 : 0,
        };
      }
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

  it("flips a free SaaS workspace to trial with a 14-day expiry (first org — no trial consumed)", async () => {
    const { pool, queries } = makeMockPool({ selectTier: "free", trialConsumedElsewhere: false });
    _resetPool(pool);

    const before = Date.now();
    await assignSaasTrial({ user: USER, organization: ORG });
    const after = Date.now();

    expect(queries).toHaveLength(3);
    expect(queries[0].sql).toMatch(/SELECT plan_tier FROM organization/);
    // #3426 eligibility lookup: keyed on the CREATING user, excluding the
    // just-created org (its owner-member row already exists when the
    // afterCreateOrganization hook fires).
    expect(queries[1].sql).toMatch(/FROM member/);
    expect(queries[1].sql).toMatch(/trial_ends_at IS NOT NULL/);
    expect(queries[1].params).toEqual([USER.id, ORG.id]);
    expect(queries[2].sql).toMatch(
      /UPDATE organization SET plan_tier = 'trial', trial_ends_at/,
    );
    // Belt-and-suspenders: the UPDATE re-asserts the free guard.
    expect(queries[2].sql).toMatch(/AND plan_tier = 'free'/);

    const [trialEndsAtParam, orgIdParam] = queries[2].params ?? [];
    expect(orgIdParam).toBe(ORG.id);
    const trialEndsAt = new Date(String(trialEndsAtParam)).getTime();
    const target = before + TRIAL_DAYS * DAY_MS;
    expect(trialEndsAt).toBeGreaterThanOrEqual(target);
    expect(trialEndsAt).toBeLessThanOrEqual(after + TRIAL_DAYS * DAY_MS);
  });

  it("locks the workspace instead of granting a second trial (#3426 one trial per user)", async () => {
    const { pool, queries } = makeMockPool({ selectTier: "free", trialConsumedElsewhere: true });
    _resetPool(pool);

    const before = Date.now();
    await assignSaasTrial({ user: USER, organization: ORG });
    const after = Date.now();

    const lockedUpdate = queries.find((q) =>
      /UPDATE organization SET plan_tier = 'locked'/i.test(q.sql),
    );
    expect(lockedUpdate, "second org by a trial-consumed creator must land on 'locked'").toBeDefined();
    // The free guard still applies (pre-seeded tiers are never clobbered).
    expect(lockedUpdate?.sql).toMatch(/AND plan_tier = 'free'/);
    // trial_ends_at is stamped 'consumed now' so checkout's double-trial
    // suppression withholds the Stripe-side trial too.
    const [consumedAtParam, orgIdParam] = lockedUpdate?.params ?? [];
    expect(orgIdParam).toBe(ORG.id);
    const consumedAt = new Date(String(consumedAtParam)).getTime();
    expect(consumedAt).toBeGreaterThanOrEqual(before);
    expect(consumedAt).toBeLessThanOrEqual(after);

    // And crucially: NO fresh trial.
    expect(
      queries.some((q) => /plan_tier = 'trial'/i.test(q.sql) && /^\s*UPDATE/i.test(q.sql)),
      "a trial-consumed creator must never receive a second trial",
    ).toBe(false);
  });

  it("keys eligibility on the creating user — a different user still gets a trial", async () => {
    // The pool answers "no trial consumed" — what makes this a
    // *different-user* test is the param binding: eligibility is queried
    // for THIS creator's id, not globally.
    const { pool, queries } = makeMockPool({ selectTier: "free", trialConsumedElsewhere: false });
    _resetPool(pool);

    const otherUser = { id: "user_other_789" };
    await assignSaasTrial({ user: otherUser, organization: { id: "org_other_1" } });

    const eligibility = queries.find((q) => /FROM member/i.test(q.sql));
    expect(eligibility?.params).toEqual([otherUser.id, "org_other_1"]);
    expect(
      queries.some((q) => /UPDATE organization SET plan_tier = 'trial'/i.test(q.sql)),
      "a creator with no prior trial must still receive one",
    ).toBe(true);
  });

  it("leaves the org on 'free' when the eligibility lookup fails (backfill heals with the same rule)", async () => {
    const { pool, queries } = makeMockPool({ selectTier: "free", eligibilityThrows: true });
    _resetPool(pool);

    // Throwing would block org creation; granting a trial on an unknown
    // answer would reopen the farming hole. The org stays on 'free' and
    // the boot backfill (same eligibility rule) heals it.
    await expect(
      assignSaasTrial({ user: USER, organization: ORG }),
    ).resolves.toBeUndefined();

    expect(
      queries.some((q) => /^\s*UPDATE/i.test(q.sql)),
      "no tier write may happen when eligibility is unknown",
    ).toBe(false);
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
