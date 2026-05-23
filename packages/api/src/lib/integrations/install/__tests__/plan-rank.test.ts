/**
 * Unit tests for the unified plan-rank module (#2666). Pins the
 * comparator behavior so the three former consumers
 * (`workspace-install-gate.ts`, `integrations-catalog.ts`,
 * `admin-marketplace.ts`) stay in lockstep.
 */

import { describe, expect, it } from "bun:test";
import { PLAN_TIERS } from "@useatlas/types";
import { PLAN_RANK, isPlanEligible, planRank } from "../plan-rank";

describe("PLAN_RANK", () => {
  it("has an entry for every PLAN_TIERS value", () => {
    for (const tier of PLAN_TIERS) {
      expect(PLAN_RANK[tier]).toBeTypeOf("number");
    }
  });

  it("orders tiers free < trial < starter < pro < business", () => {
    expect(PLAN_RANK.free).toBeLessThan(PLAN_RANK.trial);
    expect(PLAN_RANK.trial).toBeLessThan(PLAN_RANK.starter);
    expect(PLAN_RANK.starter).toBeLessThan(PLAN_RANK.pro);
    expect(PLAN_RANK.pro).toBeLessThan(PLAN_RANK.business);
  });
});

describe("planRank", () => {
  it("returns a number for every known plan tier", () => {
    expect(planRank("free")).toBe(0);
    expect(planRank("trial")).toBe(1);
    expect(planRank("starter")).toBe(2);
    expect(planRank("pro")).toBe(3);
    expect(planRank("business")).toBe(4);
  });

  it("returns null for legacy / unknown values (post-#2666 vocabulary)", () => {
    expect(planRank("team")).toBeNull();
    expect(planRank("enterprise")).toBeNull();
    expect(planRank("ultimate")).toBeNull();
    expect(planRank("")).toBeNull();
  });

  it("returns null for null / undefined / non-string inputs", () => {
    expect(planRank(null)).toBeNull();
    expect(planRank(undefined)).toBeNull();
    // @ts-expect-error — defensive runtime guard for non-string inputs
    expect(planRank(42)).toBeNull();
  });
});

describe("isPlanEligible", () => {
  it("admits the workspace when its rank is at-or-above the required rank", () => {
    expect(isPlanEligible("business", "starter")).toBe(true);
    expect(isPlanEligible("starter", "starter")).toBe(true);
    expect(isPlanEligible("pro", "trial")).toBe(true);
  });

  it("denies the workspace when its rank is below the required rank", () => {
    expect(isPlanEligible("free", "starter")).toBe(false);
    expect(isPlanEligible("trial", "business")).toBe(false);
    expect(isPlanEligible("starter", "pro")).toBe(false);
  });

  it("fails closed on unknown requiredPlan (catalog drift must not widen access)", () => {
    expect(isPlanEligible("business", "ultimate")).toBe(false);
    expect(isPlanEligible("business", "team")).toBe(false);
    expect(isPlanEligible("business", "enterprise")).toBe(false);
  });

  it("treats unknown workspacePlan as rank 0 (most restrictive)", () => {
    // free catalog row: rank 0 — even a rank-0 workspace admits.
    expect(isPlanEligible("legacy-tier", "free")).toBe(true);
    // anything stricter denies.
    expect(isPlanEligible("legacy-tier", "starter")).toBe(false);
    expect(isPlanEligible(null, "starter")).toBe(false);
    expect(isPlanEligible(undefined, "starter")).toBe(false);
  });
});
