/**
 * The widget's copy of the tier vocabulary must equal the canonical one (#5451).
 *
 * `packages/react` is published to npm, resolves `@useatlas/types` to the
 * published tarball, and does not depend on `@useatlas/schemas` at all — so
 * `src/lib/trust-tier.ts` is a hand-written mirror of
 * `packages/schemas/src/trust-tier.ts`. A mirror nobody checks is two things to
 * keep true, and CLAUDE.md's own account of what went wrong with the
 * `intentionally ignored` marker is what a silently-diverged second copy costs:
 * the copies disagreed, and the one that mattered was the wrong one.
 *
 * This reaches ACROSS the package boundary by relative path, which a test may
 * do and the shipped bundle may not. If that import ever fails to resolve, the
 * fix is to restore the relation — not to delete the test.
 */
import { describe, expect, test } from "bun:test";

import * as canonical from "../../../../schemas/src/trust-tier";
import * as mirror from "../../lib/trust-tier";

describe("widget trust-tier mirror", () => {
  test("the tier tuple matches, in order", () => {
    expect([...mirror.ANSWER_TRUST_TIERS]).toEqual([...canonical.ANSWER_TRUST_TIERS]);
  });

  test("every presentation entry matches field for field", () => {
    expect(mirror.TRUST_TIER_PRESENTATION).toEqual(canonical.TRUST_TIER_PRESENTATION);
  });

  test("the resolver agrees on known and unknown values alike", () => {
    for (const tier of [...canonical.ANSWER_TRUST_TIERS, "episode", "", "fact "]) {
      expect(mirror.answerTrustTierPresentation(tier)).toEqual(
        canonical.answerTrustTierPresentation(tier),
      );
      expect(mirror.isAnswerTrustTier(tier)).toBe(canonical.isAnswerTrustTier(tier));
    }
  });
});
