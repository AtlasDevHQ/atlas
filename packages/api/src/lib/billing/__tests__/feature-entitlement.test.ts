/**
 * Unit tests for the FeatureEntitlement SSOT + pure predicate (WS1 of #3986).
 *
 * The tier × feature matrix is the correctness boundary for the entire feature
 * ladder: every gated feature must be denied below its minimum tier and allowed
 * at/above it, and `locked`/unknown tiers must fail closed. These assert
 * external behavior at the module boundary (given a tier and a feature, is it
 * entitled), not internal wiring — prior art: `plan-rank.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import type { PlanTier } from "@useatlas/types";
import {
  FEATURE_ENTITLEMENTS,
  isFeatureEntitled,
  type GatedFeature,
} from "../feature-entitlement";

const ALL_FEATURES = Object.keys(FEATURE_ENTITLEMENTS) as GatedFeature[];

// Tiers in ascending rank order. `locked` (rank -1) is below `free`.
const RANKED_TIERS: PlanTier[] = [
  "locked",
  "free",
  "trial",
  "starter",
  "pro",
  "business",
];

const TIER_RANK: Record<PlanTier, number> = {
  locked: -1,
  free: 0,
  trial: 1,
  starter: 2,
  pro: 3,
  business: 4,
};

describe("FEATURE_ENTITLEMENTS map", () => {
  it("defaults every gated feature to the Business tier (current pricing page)", () => {
    // The PRD locks the default tier line at Business for all ten EE features
    // plus proactive. A Pro+ override would be an intentional single-line
    // change here; until then the map must be uniformly Business.
    for (const feature of ALL_FEATURES) {
      expect(FEATURE_ENTITLEMENTS[feature]).toBe("business");
    }
  });

  it("enumerates the full advertised gated-feature set (not an ad-hoc subset)", () => {
    // The plan model must enumerate every advertised gated capability so a new
    // premium feature is gated by construction. This pins the membership so a
    // dropped feature is caught.
    const expected: GatedFeature[] = [
      "sso",
      "scim",
      "custom_roles",
      "ip_allowlist",
      "approvals",
      "audit_retention",
      "masking",
      "residency",
      "backups",
      "white_label",
      "proactive",
    ];
    expect(ALL_FEATURES.toSorted()).toEqual(expected.toSorted());
  });
});

describe("isFeatureEntitled — tier × feature matrix", () => {
  it("denies below the minimum tier and allows at/above it, for every feature", () => {
    for (const feature of ALL_FEATURES) {
      const requiredRank = TIER_RANK[FEATURE_ENTITLEMENTS[feature]];
      for (const tier of RANKED_TIERS) {
        const expected = TIER_RANK[tier] >= requiredRank;
        expect(isFeatureEntitled(tier, feature)).toBe(expected);
      }
    }
  });

  it("allows Business for every gated feature", () => {
    for (const feature of ALL_FEATURES) {
      expect(isFeatureEntitled("business", feature)).toBe(true);
    }
  });

  it("denies Starter and Pro every Business-gated feature", () => {
    for (const feature of ALL_FEATURES) {
      expect(isFeatureEntitled("starter", feature)).toBe(false);
      expect(isFeatureEntitled("pro", feature)).toBe(false);
    }
  });

  it("fails closed for the `locked` churn tier on every feature", () => {
    for (const feature of ALL_FEATURES) {
      expect(isFeatureEntitled("locked", feature)).toBe(false);
    }
  });

  it("fails closed for null / undefined tier (no billing context / legacy row)", () => {
    for (const feature of ALL_FEATURES) {
      expect(isFeatureEntitled(null, feature)).toBe(false);
      expect(isFeatureEntitled(undefined, feature)).toBe(false);
    }
  });

  it("treats SSO specifically as Business-gated (the WS1 proof feature)", () => {
    expect(isFeatureEntitled("free", "sso")).toBe(false);
    expect(isFeatureEntitled("trial", "sso")).toBe(false);
    expect(isFeatureEntitled("starter", "sso")).toBe(false);
    expect(isFeatureEntitled("pro", "sso")).toBe(false);
    expect(isFeatureEntitled("business", "sso")).toBe(true);
  });
});
