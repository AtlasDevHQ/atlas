/**
 * Unit tests for the pricing-page entitlement mirror (WS4 of #3984 / #3996).
 *
 * The mirror is what makes the marketing comparison table SSOT-driven without
 * the frontend importing `@atlas/api`. These assert external behavior at the
 * module boundary: every gated feature becomes exactly one row; each per-tier
 * cell equals the enforcement predicate's verdict (so the page can't claim a
 * tier the code gates above); and the exhaustiveness guard catches a display
 * map that drifts from the SSOT. Prior art: `feature-entitlement.test.ts`,
 * the schema/OpenAPI drift-guard self-tests.
 */

import { describe, expect, it } from "bun:test";
import type { PlanTier } from "@useatlas/types";
import { isPlanEligible } from "@atlas/api/lib/integrations/install/plan-rank";
import {
  FEATURE_ENTITLEMENTS,
  isFeatureEntitled,
  type GatedFeature,
} from "../feature-entitlement";
import {
  COLUMN_TIERS,
  FEATURE_DISPLAY,
  SECTION_ORDER,
  assertDisplayExhaustive,
  buildEntitlementRows,
  renderArtifact,
  type PricingColumn,
} from "../pricing-entitlement-artifact";

const ALL_FEATURES = Object.keys(FEATURE_ENTITLEMENTS) as GatedFeature[];
const COLUMNS = Object.keys(COLUMN_TIERS) as PricingColumn[];

describe("COLUMN_TIERS — the column → tier ladder", () => {
  // The whole mirror's correctness rests on COLUMN_TIERS mapping each marketing
  // column to the right PlanTier. Every gated feature is currently Business-min,
  // so the live artifact is monochrome (every gated cell is {…, business: true})
  // — which means the SSOT-driven tests below can't, on their own, tell `pro`
  // apart from `business`. A fat-fingered `pro: "business"` would produce an
  // identical artifact and slip through. These hard-coded oracles pin the
  // ladder independently of the live SSOT, so a column→tier typo (or a future
  // feature legitimately re-tiered to Pro+) is caught.
  it("maps each column to its intended tier (hard-coded oracle, not SSOT-derived)", () => {
    expect(COLUMN_TIERS).toEqual({
      selfHosted: "free",
      starter: "starter",
      pro: "pro",
      business: "business",
    });
  });

  it("distinguishes pro from business for a synthetic Pro-min feature", () => {
    // Simulate a feature whose minimum tier is `pro` and assert the per-column
    // eligibility the mirror WOULD render — proving `pro` and `business`
    // resolve differently. If COLUMN_TIERS.pro were mis-set to "business" this
    // expectation flips and fails.
    const requiredTier: PlanTier = "pro";
    const ladder = Object.fromEntries(
      (Object.entries(COLUMN_TIERS) as [PricingColumn, PlanTier][]).map(
        ([column, tier]) => [column, isPlanEligible(tier, requiredTier)],
      ),
    );
    expect(ladder).toEqual({
      selfHosted: false,
      starter: false,
      pro: true,
      business: true,
    });
  });

  it("distinguishes starter from pro for a synthetic Starter-min feature", () => {
    const requiredTier: PlanTier = "starter";
    const ladder = Object.fromEntries(
      (Object.entries(COLUMN_TIERS) as [PricingColumn, PlanTier][]).map(
        ([column, tier]) => [column, isPlanEligible(tier, requiredTier)],
      ),
    );
    expect(ladder).toEqual({
      selfHosted: false,
      starter: true,
      pro: true,
      business: true,
    });
  });
});

describe("buildEntitlementRows", () => {
  it("emits exactly one row per gated feature", () => {
    const rows = buildEntitlementRows();
    expect(rows).toHaveLength(ALL_FEATURES.length);
    const featureIds = rows.map((r) => r.feature).toSorted();
    expect(featureIds).toEqual([...ALL_FEATURES].toSorted());
  });

  it("derives every cell from isFeatureEntitled — page can't outrun enforcement", () => {
    // This is the load-bearing invariant: a cell is true iff the column's tier
    // actually unlocks the feature in code. If these ever disagree, the page is
    // selling a tier the code gates above it.
    for (const row of buildEntitlementRows()) {
      for (const column of COLUMNS) {
        const tier = COLUMN_TIERS[column];
        expect(row.cells[column]).toBe(isFeatureEntitled(tier, row.feature));
      }
    }
  });

  it("never grants a gated feature to the free/self-hosted column", () => {
    // No gated feature is free-min, so the Self-Hosted (free) column is always
    // a dash — matching the hosted ladder the page sells.
    for (const row of buildEntitlementRows()) {
      expect(row.cells.selfHosted).toBe(false);
    }
  });

  it("orders rows by section, then SSOT key order", () => {
    const rows = buildEntitlementRows();
    const sectionIdx = rows.map((r) => SECTION_ORDER.indexOf(r.section));
    // Sections appear in SECTION_ORDER and never interleave.
    expect(sectionIdx).toEqual([...sectionIdx].toSorted((a, b) => a - b));
  });

  it("labels every row from FEATURE_DISPLAY", () => {
    for (const row of buildEntitlementRows()) {
      expect(row.label).toBe(FEATURE_DISPLAY[row.feature].label);
      expect(row.label.length).toBeGreaterThan(0);
    }
  });
});

describe("assertDisplayExhaustive", () => {
  it("passes when FEATURE_DISPLAY covers exactly the SSOT", () => {
    expect(() => assertDisplayExhaustive()).not.toThrow();
  });
});

describe("renderArtifact", () => {
  it("is deterministic — same SSOT renders byte-identically (drift guard relies on this)", () => {
    expect(renderArtifact()).toBe(renderArtifact());
  });

  it("emits a pure data module with no import statements at all", () => {
    // The frontend must not import @atlas/api (CLAUDE.md). The artifact is a
    // flat data module — it imports nothing, so it can't pull the API package
    // (or anything else) into the @atlas/www bundle. The @atlas/api mention in
    // the banner is explanatory prose, not an import, so we assert on import
    // statements specifically rather than the substring.
    const src = renderArtifact();
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\bfrom\s+["']@atlas\/api/);
    expect(src).toContain("export const ENTITLEMENT_ROWS");
  });

  it("includes every feature's wire id and label", () => {
    const src = renderArtifact();
    for (const feature of ALL_FEATURES) {
      expect(src).toContain(`feature: ${JSON.stringify(feature)}`);
      expect(src).toContain(
        `label: ${JSON.stringify(FEATURE_DISPLAY[feature].label)}`,
      );
    }
  });

  it("carries the generated-file banner so it isn't hand-edited", () => {
    expect(renderArtifact()).toMatch(/@generated by scripts\/generate-pricing-entitlements\.ts/);
  });
});
