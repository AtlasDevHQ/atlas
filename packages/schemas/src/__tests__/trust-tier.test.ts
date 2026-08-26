/**
 * The tier-label invariant, as something that can FAIL (#5451).
 *
 * ADR-0036 requires every UI surface to carry the tier label. The compile pins
 * in `trust-tier.ts` cover the type direction; these cover the two runtime
 * gaps a type cannot see — a wire tier with no presentation entry, and a
 * presentation entry that is present but blank. Both would render as an empty
 * chip, which is the invariant failing while every gate stays green.
 */
import { describe, expect, test } from "bun:test";
import { BRAIN_RESULT_TIERS } from "../brain";
import {
  ANSWER_TRUST_TIERS,
  TRUST_TIER_PRESENTATION,
  answerTrustTierPresentation,
  isAnswerTrustTier,
} from "../trust-tier";

describe("trust tier presentation", () => {
  test("every searchBrain wire tier has a presentation entry", () => {
    for (const tier of BRAIN_RESULT_TIERS) {
      expect(answerTrustTierPresentation(tier)).not.toBeNull();
    }
  });

  test("the warehouse tier is present — SURVEYED does not come from searchBrain", () => {
    // AC: "SURVEYED is handled explicitly. It does not come from `searchBrain`
    // at all — it is `executeSQL` — so a UI that only labels brain results
    // leaves the tier the wedge most depends on unlabelled."
    expect(BRAIN_RESULT_TIERS as readonly string[]).not.toContain("warehouse");
    expect(answerTrustTierPresentation("warehouse")).not.toBeNull();
  });

  test("the table's keys are exactly the tier tuple — no orphan, no gap", () => {
    expect(Object.keys(TRUST_TIER_PRESENTATION).sort()).toEqual(
      [...ANSWER_TRUST_TIERS].sort(),
    );
  });

  test("no entry is blank — an empty label is an unlabelled chip", () => {
    for (const tier of ANSWER_TRUST_TIERS) {
      const entry = TRUST_TIER_PRESENTATION[tier];
      expect(entry.tier).toBe(tier);
      expect(entry.label.trim().length).toBeGreaterThan(0);
      expect(entry.meaning.trim().length).toBeGreaterThan(0);
    }
  });

  test("labels are distinct — three tiers that read the same are one tier", () => {
    const labels = ANSWER_TRUST_TIERS.map((t) => TRUST_TIER_PRESENTATION[t].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("document stays outside the trust ordering", () => {
    // Not an invented 4: a KB document is descriptive prose, not a claim.
    expect(TRUST_TIER_PRESENTATION.document.trustTier).toBeNull();
    expect(TRUST_TIER_PRESENTATION.warehouse.trustTier).toBe(1);
    expect(TRUST_TIER_PRESENTATION.fact.trustTier).toBe(2);
    expect(TRUST_TIER_PRESENTATION["raw-episode"].trustTier).toBe(3);
  });

  test("an unrecognized tier resolves to null rather than a silent default", () => {
    expect(isAnswerTrustTier("episode")).toBe(false);
    expect(answerTrustTierPresentation("episode")).toBeNull();
    expect(answerTrustTierPresentation(undefined)).toBeNull();
    expect(answerTrustTierPresentation(2)).toBeNull();
  });
});
