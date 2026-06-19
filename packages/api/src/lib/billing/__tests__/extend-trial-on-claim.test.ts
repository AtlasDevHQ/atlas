/**
 * Tests for the claim flip (ADR-0018 / #3651): `extendTrialOnClaim`.
 *
 * When a user claims their account (completes the web OTP interstitial,
 * flipping `emailVerified`), the full 14-day trial clock starts. This pins:
 *   - The guarded UPDATE extends `trial_ends_at` to ~NOW() + TRIAL_DAYS.
 *   - It is scoped to the user's OWNED, `trial`-tier, still-in-grace
 *     Workspaces (owner role + grace-window guard), so a full-window web trial
 *     and an already-claimed trial are left untouched (idempotent).
 *   - It returns the extended org ids (for plan-cache invalidation).
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { TRIAL_DAYS, TRIAL_GRACE_HOURS } from "@atlas/api/lib/billing/plans";
import { extendTrialOnClaim } from "../trial-eligibility";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function makeMockPool(returnedIds: string[]): {
  pool: InternalPool;
  queries: Array<{ sql: string; params?: unknown[] }>;
} {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rows: returnedIds.map((id) => ({ id })), rowCount: returnedIds.length };
    },
  } as unknown as InternalPool;
  return { pool, queries };
}

describe("extendTrialOnClaim", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://test/test";
  });

  afterAll(() => {
    _resetPool(null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  });

  it("extends trial_ends_at to ~NOW() + TRIAL_DAYS, guarded on owner + trial + grace window", async () => {
    const { pool, queries } = makeMockPool(["org-1"]);
    _resetPool(pool);

    const before = Date.now();
    const extended = await extendTrialOnClaim("user-1");
    const after = Date.now();

    expect(extended).toEqual(["org-1"]);
    expect(queries).toHaveLength(1);

    const q = queries[0];
    // Guards: owner role, trial tier, grace-window upper bound.
    expect(q.sql).toMatch(/UPDATE\s+organization/i);
    expect(q.sql).toMatch(/role\s*=\s*'owner'/i);
    expect(q.sql).toMatch(/plan_tier\s*=\s*'trial'/i);
    expect(q.sql).toMatch(/trial_ends_at\s*<=\s*\$3/i);
    expect(q.sql).toMatch(/RETURNING\s+o\.id/i);

    const [userId, newEnds, graceHorizon] = q.params as [string, string, string];
    expect(userId).toBe("user-1");

    // New end ≈ NOW() + 14d.
    const newEndsMs = new Date(newEnds).getTime();
    expect(newEndsMs).toBeGreaterThanOrEqual(before + TRIAL_DAYS * DAY_MS - 1000);
    expect(newEndsMs).toBeLessThanOrEqual(after + TRIAL_DAYS * DAY_MS + 1000);

    // Grace horizon ≈ NOW() + 72h — the upper bound that scopes the extension
    // to still-unclaimed grace workspaces (web full-window trials sit above it).
    const graceMs = new Date(graceHorizon).getTime();
    expect(graceMs).toBeGreaterThanOrEqual(before + TRIAL_GRACE_HOURS * HOUR_MS - 1000);
    expect(graceMs).toBeLessThanOrEqual(after + TRIAL_GRACE_HOURS * HOUR_MS + 1000);
    // The grace horizon must be well below the new full-window end, or the
    // guard would re-extend already-claimed trials.
    expect(graceMs).toBeLessThan(newEndsMs);
  });

  it("returns an empty list when no owned grace-window trial matches (idempotent no-op)", async () => {
    const { pool, queries } = makeMockPool([]);
    _resetPool(pool);
    const extended = await extendTrialOnClaim("user-no-trial");
    expect(extended).toEqual([]);
    expect(queries).toHaveLength(1);
  });
});
