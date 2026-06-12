/**
 * Unit tests for the unified plan-rank module (#2666). Pins the
 * comparator behavior so the three former consumers
 * (`workspace-install-gate.ts`, `integrations-catalog.ts`,
 * `admin-marketplace.ts`) stay in lockstep.
 */

import { describe, expect, it } from "bun:test";
import { PLAN_TIERS } from "@useatlas/types";
import {
  PLAN_RANK,
  isPlanEligible,
  parsePlanTier,
  planRank,
} from "../plan-rank";

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

describe("parsePlanTier", () => {
  it("narrows known plan tiers to their PlanTier value", () => {
    expect(parsePlanTier("free")).toBe("free");
    expect(parsePlanTier("trial")).toBe("trial");
    expect(parsePlanTier("starter")).toBe("starter");
    expect(parsePlanTier("pro")).toBe("pro");
    expect(parsePlanTier("business")).toBe("business");
  });

  it("returns null for legacy / unknown plan strings (post-#2666 vocabulary)", () => {
    // The whole point of the narrowing helper: a bogus tier from a DB
    // drift, OpenAPI request, or seed file fails closed here so internal
    // callers can rely on the `PlanTier | null` shape.
    expect(parsePlanTier("team")).toBeNull();
    expect(parsePlanTier("enterprise")).toBeNull();
    expect(parsePlanTier("ultimate")).toBeNull();
    expect(parsePlanTier("")).toBeNull();
  });

  it("returns null for null / undefined / non-string inputs", () => {
    expect(parsePlanTier(null)).toBeNull();
    expect(parsePlanTier(undefined)).toBeNull();
    expect(parsePlanTier(42)).toBeNull();
    expect(parsePlanTier({})).toBeNull();
  });

  it("rejects inherited Object.prototype keys (Codex P2 regression)", () => {
    // The pre-fix implementation used `value in PLAN_RANK`, which
    // matches inherited keys. `"toString"` / `"constructor"` / etc.
    // would have falsely admitted as a PlanTier and downstream
    // responses would emit those strings as `required_plan`.
    expect(parsePlanTier("toString")).toBeNull();
    expect(parsePlanTier("constructor")).toBeNull();
    expect(parsePlanTier("hasOwnProperty")).toBeNull();
    expect(parsePlanTier("__proto__")).toBeNull();
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

  it("returns null for null / undefined inputs", () => {
    expect(planRank(null)).toBeNull();
    expect(planRank(undefined)).toBeNull();
  });

  // ── Negative-type tests (#2715 acceptance criterion) ──────────────
  // Passing a non-PlanTier string is a compile error post-#2715. The
  // directives below pin that contract — if the signature widens back
  // to `string` these become unused-`@ts-expect-error` errors.
  it("refuses untyped strings at compile time", () => {
    // @ts-expect-error — "team" is not a PlanTier; callers must
    // narrow via parsePlanTier() at the trust boundary first.
    planRank("team");
    // @ts-expect-error — same for any other untyped string.
    planRank("enterprise");
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

  it("treats null / undefined workspace plan as rank-of-free (no billing context)", () => {
    // null = self-hosted sentinel / pre-migration row, NOT a churned org:
    // free-min rows stay installable (routes/integrations.ts depends on
    // this for self-hosted no-auth deploys); anything stricter denies.
    expect(isPlanEligible(null, "free")).toBe(true);
    expect(isPlanEligible(undefined, "free")).toBe(true);
    expect(isPlanEligible(null, "starter")).toBe(false);
    expect(isPlanEligible(undefined, "starter")).toBe(false);
  });

  it("locked workspaces satisfy no min_plan gate, and locked is never a valid requirement", () => {
    expect(isPlanEligible("locked", "free")).toBe(false);
    expect(isPlanEligible("locked", "starter")).toBe(false);
    // A drifted catalog row demanding "locked" fails closed instead of
    // admitting every workspace via the -1 rank.
    expect(isPlanEligible("business", "locked")).toBe(false);
    expect(isPlanEligible("locked", "locked")).toBe(false);
  });

  it("fails closed on missing requiredPlan (catalog drift must not widen access)", () => {
    expect(isPlanEligible("business", null)).toBe(false);
    expect(isPlanEligible("business", undefined)).toBe(false);
  });

  // ── Negative-type tests (#2715 acceptance criterion) ──────────────
  it("refuses untyped strings at compile time", () => {
    // @ts-expect-error — workspacePlan must be a PlanTier or null.
    isPlanEligible("legacy-tier", "starter");
    // @ts-expect-error — requiredPlan must be a PlanTier or null.
    isPlanEligible("business", "ultimate");
  });
});
