/**
 * Tests for the authoritative trial-state module (#4127).
 *
 * `deriveTrialState` is the single derivation of the two CONTEXT.md axes —
 * metered/full (claim) and expired/solvent (Gate 0) — plus the countdown.
 * The matrix here pins the semantics its four consumers (claim-gate,
 * enforcement, grace reaper, trial-eligibility) rely on; the SQL-fragment
 * tests pin the load-bearing atoms of the generated "unclaimed trial"
 * clauses so the SQL twin can't lose a guard silently.
 *
 * The effective-end / expiry cases were moved here from trial-expiry.test.ts
 * (#3434) when that module folded into trial-state: they pin that a
 * NULL-`trial_ends_at` workspace sees the same date in the banner/billing
 * page that enforcement uses to cut it off.
 */

import { describe, it, expect } from "bun:test";
import { TRIAL_DAYS, TRIAL_GRACE_HOURS } from "../plans";
import {
  deriveTrialState,
  effectiveTrialEndsAt,
  fullTrialEndsAtFrom,
  isTrialExpiredAt,
  isTrialTier,
  trialDaysRemaining,
  trialTierSql,
  unclaimedGraceHorizonFrom,
  unclaimedOwnerExistsSql,
} from "../trial-state";
import type { PlanTier } from "@atlas/api/lib/db/internal";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date("2026-06-12T12:00:00.000Z");

function trialWorkspace(overrides: {
  plan_tier?: PlanTier;
  trial_ends_at?: string | Date | null;
  createdAt?: string | Date;
}) {
  return {
    plan_tier: overrides.plan_tier ?? ("trial" as PlanTier),
    trial_ends_at:
      overrides.trial_ends_at === undefined
        ? new Date(NOW.getTime() + 3 * DAY).toISOString()
        : overrides.trial_ends_at,
    createdAt: overrides.createdAt ?? new Date(NOW.getTime() - 1 * DAY).toISOString(),
  };
}

const UNVERIFIED_OWNER = { emailVerified: false, email: "owner@acme.com" };
const VERIFIED_OWNER = { emailVerified: true, email: "owner@acme.com" };

describe("deriveTrialState — the metered/full and expired/solvent axes", () => {
  it("unclaimed trial → metered (the claim-gate predicate)", () => {
    const state = deriveTrialState(trialWorkspace({}), UNVERIFIED_OWNER, NOW);
    expect(state.tier).toBe("trial");
    expect(state.claimed).toBe(false);
    expect(state.metered).toBe(true);
    expect(state.expired).toBe(false);
  });

  it("claimed trial → full (not metered)", () => {
    const state = deriveTrialState(trialWorkspace({}), VERIFIED_OWNER, NOW);
    expect(state.claimed).toBe(true);
    expect(state.metered).toBe(false);
  });

  it("ownerless workspace is vacuously claimed — never metered", () => {
    const state = deriveTrialState(trialWorkspace({}), null, NOW);
    expect(state.claimed).toBe(true);
    expect(state.metered).toBe(false);
  });

  it("non-trial tiers are never metered, never trial-expired, and carry no countdown", () => {
    for (const tier of ["starter", "pro", "business", "locked", "free"] as PlanTier[]) {
      const state = deriveTrialState(
        // Even with an unverified owner and a lapsed trial_ends_at.
        trialWorkspace({ plan_tier: tier, trial_ends_at: new Date(NOW.getTime() - DAY) }),
        UNVERIFIED_OWNER,
        NOW,
      );
      expect(state.metered).toBe(false);
      expect(state.expired).toBe(false);
      expect(state.daysRemaining).toBeNull();
    }
  });

  it("lapsed trial → expired, independent of claim state, countdown floored at 0", () => {
    const ws = trialWorkspace({ trial_ends_at: new Date(NOW.getTime() - 2 * DAY) });
    for (const owner of [UNVERIFIED_OWNER, VERIFIED_OWNER, null]) {
      const state = deriveTrialState(ws, owner, NOW);
      expect(state.expired).toBe(true);
      expect(state.daysRemaining).toBe(0);
    }
  });

  it("an unclaimed-AND-expired trial is both metered and expired (gate ordering decides which block wins)", () => {
    const state = deriveTrialState(
      trialWorkspace({ trial_ends_at: new Date(NOW.getTime() - HOUR) }),
      UNVERIFIED_OWNER,
      NOW,
    );
    expect(state.metered).toBe(true);
    expect(state.expired).toBe(true);
  });

  it("counts whole days remaining (ceil) on a live trial", () => {
    const state = deriveTrialState(
      trialWorkspace({ trial_ends_at: new Date(NOW.getTime() + 5 * DAY - 1000) }),
      VERIFIED_OWNER,
      NOW,
    );
    expect(state.daysRemaining).toBe(5);
    expect(state.expired).toBe(false);
  });

  it("NULL trial_ends_at falls back to createdAt + TRIAL_DAYS on both axes (#3434)", () => {
    const fresh = deriveTrialState(
      trialWorkspace({ trial_ends_at: null, createdAt: new Date(NOW.getTime() - DAY) }),
      VERIFIED_OWNER,
      NOW,
    );
    expect(fresh.expired).toBe(false);
    expect(fresh.daysRemaining).toBe(TRIAL_DAYS - 1);

    const stale = deriveTrialState(
      trialWorkspace({
        trial_ends_at: null,
        createdAt: new Date(NOW.getTime() - (TRIAL_DAYS * DAY + 1)),
      }),
      VERIFIED_OWNER,
      NOW,
    );
    expect(stale.expired).toBe(true);
    expect(stale.daysRemaining).toBe(0);
  });
});

describe("isTrialTier", () => {
  it("only the trial tier is a member", () => {
    expect(isTrialTier("trial")).toBe(true);
    for (const tier of ["starter", "pro", "business", "locked", "free"] as PlanTier[]) {
      expect(isTrialTier(tier)).toBe(false);
    }
  });
});

describe("effectiveTrialEndsAt (moved from trial-expiry, #3434)", () => {
  it("returns trial_ends_at verbatim when set", () => {
    const end = effectiveTrialEndsAt({
      trial_ends_at: "2026-06-20T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(end?.toISOString()).toBe("2026-06-20T00:00:00.000Z");
  });

  it("falls back to createdAt + TRIAL_DAYS when trial_ends_at is null", () => {
    const createdAt = "2026-06-01T00:00:00.000Z";
    const end = effectiveTrialEndsAt({ trial_ends_at: null, createdAt });
    expect(end?.getTime()).toBe(Date.parse(createdAt) + TRIAL_DAYS * DAY);
  });

  it("accepts Date inputs (pg returns Date for timestamptz)", () => {
    const createdAt = new Date("2026-06-01T00:00:00.000Z");
    const end = effectiveTrialEndsAt({ trial_ends_at: null, createdAt });
    expect(end?.getTime()).toBe(createdAt.getTime() + TRIAL_DAYS * DAY);
  });

  it("returns null when both inputs are unparseable", () => {
    expect(
      effectiveTrialEndsAt({ trial_ends_at: "not-a-date", createdAt: "garbage" }),
    ).toBeNull();
  });

  it("falls back to createdAt when trial_ends_at is unparseable", () => {
    const createdAt = "2026-06-01T00:00:00.000Z";
    const end = effectiveTrialEndsAt({ trial_ends_at: "not-a-date", createdAt });
    expect(end?.getTime()).toBe(Date.parse(createdAt) + TRIAL_DAYS * DAY);
  });
});

describe("isTrialExpiredAt", () => {
  it("trial_ends_at in the past → expired", () => {
    const end = effectiveTrialEndsAt({
      trial_ends_at: new Date(NOW.getTime() - 1).toISOString(),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(isTrialExpiredAt(end, NOW)).toBe(true);
  });

  it("trial_ends_at in the future → not expired", () => {
    const end = effectiveTrialEndsAt({
      trial_ends_at: new Date(NOW.getTime() + DAY).toISOString(),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(isTrialExpiredAt(end, NOW)).toBe(false);
  });

  it("fallback clock: created more than TRIAL_DAYS ago → expired", () => {
    const end = effectiveTrialEndsAt({
      trial_ends_at: null,
      createdAt: new Date(NOW.getTime() - (TRIAL_DAYS * DAY + 1)).toISOString(),
    });
    expect(isTrialExpiredAt(end, NOW)).toBe(true);
  });

  it("fallback clock: created less than TRIAL_DAYS ago → not expired", () => {
    const end = effectiveTrialEndsAt({
      trial_ends_at: null,
      createdAt: new Date(NOW.getTime() - (TRIAL_DAYS - 1) * DAY).toISOString(),
    });
    expect(isTrialExpiredAt(end, NOW)).toBe(false);
  });

  it("null effective end (unparseable inputs) → not expired", () => {
    expect(isTrialExpiredAt(null, NOW)).toBe(false);
  });
});

describe("trialDaysRemaining", () => {
  it("floors a lapsed trial at 0 (never negative)", () => {
    expect(
      trialDaysRemaining(
        { trial_ends_at: new Date(NOW.getTime() - 2 * DAY), createdAt: NOW },
        NOW,
      ),
    ).toBe(0);
  });

  it("returns null when neither date input parses", () => {
    expect(
      trialDaysRemaining({ trial_ends_at: "not-a-date", createdAt: "garbage" }, NOW),
    ).toBeNull();
  });
});

describe("trial clock stamps", () => {
  it("fullTrialEndsAtFrom is exactly TRIAL_DAYS out", () => {
    expect(Date.parse(fullTrialEndsAtFrom(NOW.getTime()))).toBe(
      NOW.getTime() + TRIAL_DAYS * DAY,
    );
  });

  it("unclaimedGraceHorizonFrom is exactly TRIAL_GRACE_HOURS out", () => {
    expect(Date.parse(unclaimedGraceHorizonFrom(NOW.getTime()))).toBe(
      NOW.getTime() + TRIAL_GRACE_HOURS * HOUR,
    );
  });

  it("the grace horizon is strictly inside the full trial window (what makes claim extension idempotent)", () => {
    expect(Date.parse(unclaimedGraceHorizonFrom(NOW.getTime()))).toBeLessThan(
      Date.parse(fullTrialEndsAtFrom(NOW.getTime())),
    );
  });
});

describe("SQL fragments — the SQL twin of the unclaimed-trial predicate", () => {
  it("trialTierSql pins tier membership over the given alias", () => {
    expect(trialTierSql("o")).toBe("o.plan_tier = 'trial'");
  });

  it("unclaimedOwnerExistsSql carries every load-bearing guard", () => {
    const sql = unclaimedOwnerExistsSql("o.id");
    // Correlated to the outer org row.
    expect(sql).toContain('m."organizationId" = o.id');
    // Only the OWNER's verification counts.
    expect(sql).toContain("m.role = 'owner'");
    // Unclaimed = the owner's user row is still unverified.
    expect(sql).toContain('u."emailVerified" = false');
    // Set form: EXISTS, not a row-returning join.
    expect(sql).toMatch(/EXISTS\s*\(/);
  });
});
