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
import type { MinPlanTier, PlanTier } from "@useatlas/types";
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

// Features whose minimum tier intentionally overrides the Business default.
// `custom_domain` sits at Pro+ (#3988): the custom-domain route has always
// documented "Pro or Business plan … required to create a domain". `proactive`
// sits at `trial` (#3999): a hosted-SaaS feature available to all paid plans,
// not a Business-tier differentiator. Every other gated feature must remain at
// the Business default.
const TIER_OVERRIDES: Partial<Record<GatedFeature, MinPlanTier>> = {
  custom_domain: "pro",
  proactive: "trial",
  // All-paid: region choice is universal at signup; residency management is
  // included at every active paid tier (not a Business differentiator).
  residency: "trial",
};

describe("FEATURE_ENTITLEMENTS map", () => {
  it("defaults every gated feature to Business except the recorded overrides", () => {
    // The PRD locks the default tier line at Business. An override (Pro+ for
    // custom_domain, all-paid `trial` for proactive + residency) is an
    // intentional single-line change in the SSOT; this pins the exact override
    // set so a stray re-tier is caught.
    for (const feature of ALL_FEATURES) {
      const expected = TIER_OVERRIDES[feature] ?? "business";
      expect(FEATURE_ENTITLEMENTS[feature]).toBe(expected);
    }
  });

  it("pins custom_domain to Pro (the one Pro+ override)", () => {
    expect(FEATURE_ENTITLEMENTS.custom_domain).toBe("pro");
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
      "custom_domain",
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
      if (FEATURE_ENTITLEMENTS[feature] !== "business") continue;
      expect(isFeatureEntitled("starter", feature)).toBe(false);
      expect(isFeatureEntitled("pro", feature)).toBe(false);
    }
  });

  it("treats custom_domain as Pro-gated: denied below Pro, allowed at Pro and Business", () => {
    expect(isFeatureEntitled("free", "custom_domain")).toBe(false);
    expect(isFeatureEntitled("trial", "custom_domain")).toBe(false);
    expect(isFeatureEntitled("starter", "custom_domain")).toBe(false);
    expect(isFeatureEntitled("pro", "custom_domain")).toBe(true);
    expect(isFeatureEntitled("business", "custom_domain")).toBe(true);
  });

  it("treats proactive as all-paid (trial-gated): denied for locked/free, allowed for every active SaaS plan", () => {
    // #3999: proactive unlocks on every paying plan, not just Business. `trial`
    // (starter-equivalent, the lowest active SaaS tier) and up are entitled;
    // only the churn tier `locked` and the no-billing `free` floor are denied.
    // SaaS-exclusivity (self-hosted denied) is a deploy-mode gate, not this
    // predicate — see ProactiveGate / admin-proactive `gateProactiveAvailable`.
    expect(isFeatureEntitled("locked", "proactive")).toBe(false);
    expect(isFeatureEntitled("free", "proactive")).toBe(false);
    expect(isFeatureEntitled("trial", "proactive")).toBe(true);
    expect(isFeatureEntitled("starter", "proactive")).toBe(true);
    expect(isFeatureEntitled("pro", "proactive")).toBe(true);
    expect(isFeatureEntitled("business", "proactive")).toBe(true);
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
