/**
 * Pins `totalDraftCount`'s deploy-overlap tolerance — the reason the helper
 * exists. During a web-before-API overlap an older API omits a newer segment
 * (`useModeStatus` casts the JSON without a parse, so the hole reaches the
 * sum); the total must stay a finite count of the present fields, never NaN.
 */

import { describe, expect, it } from "bun:test";
import type { ModeDraftCounts } from "@useatlas/types/mode";
import { totalDraftCount } from "./draft-counts";

const FULL: ModeDraftCounts = {
  connections: 1,
  entities: 2,
  entityEdits: 3,
  entityDeletes: 4,
  prompts: 5,
  starterPrompts: 6,
  knowledgeDocuments: 7,
};

describe("totalDraftCount", () => {
  it("sums every segment of a complete counts object", () => {
    expect(totalDraftCount(FULL)).toBe(28);
  });

  it("stays a finite sum of the present fields when an older API omits a segment", () => {
    const { knowledgeDocuments: _kd, ...older } = FULL;
    const total = totalDraftCount(older as unknown as ModeDraftCounts);
    expect(total).toBe(21);
    expect(Number.isFinite(total)).toBe(true);
  });

  it("ignores a non-numeric segment instead of poisoning the total", () => {
    const poisoned = { ...FULL, entities: undefined } as unknown as ModeDraftCounts;
    expect(totalDraftCount(poisoned)).toBe(26);
  });

  it("returns 0 for an all-zero object (the hide-guard case)", () => {
    const zeros = Object.fromEntries(
      Object.keys(FULL).map((k) => [k, 0]),
    ) as unknown as ModeDraftCounts;
    expect(totalDraftCount(zeros)).toBe(0);
  });
});
