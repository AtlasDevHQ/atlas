/**
 * runExpertSchedulerTick auto-approve invariant (#4486, #4506).
 *
 * The scheduler inserts every proposal `pending`, then hands each
 * auto-approve-eligible row to the single decide seam (`decideAmendment`). It no
 * longer applies or reverts directly — the seam owns claim-then-apply with
 * compensation. This pins the tick's mapping of insert + decide outcomes to the
 * result counters so a future edit that drops the seam call (or mis-maps an
 * outcome) ships red:
 *   - eligible + decide approved   → autoApproved
 *   - eligible + decide apply_failed → errors (the seam already reverted)
 *   - not eligible                 → queued, decide never called
 *   - rejected / already_pending    → suppressed at insert, decide never called
 *
 * A separate file from scheduler.test.ts (which only tests the config getters)
 * so the tick's module mocks don't leak into those tests.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import type { AnalysisResult } from "../types";

const proposal: AnalysisResult = {
  category: "coverage_gaps",
  entityName: "companies",
  group: "default",
  amendmentType: "add_dimension",
  amendment: { name: "region", type: "string", description: "Region" },
  rationale: "Adds region dimension",
  impact: 0.9,
  confidence: 0.95,
  staleness: 0,
  score: 0.85,
};

// One entity so the tick clears the `entities.length === 0` early return; the
// analyzer is mocked to return our proposal regardless of inputs.
void mock.module("../context-loader", () => ({
  loadEntitiesFromDisk: async () => [{ name: "companies" }],
  loadGlossaryFromDisk: async () => [],
  loadAuditPatterns: async () => [],
  loadRejectedKeys: async () => new Set<string>(),
}));

void mock.module("../profile-cache", () => ({
  loadCachedProfiles: () => [],
}));

let proposals: AnalysisResult[] = [proposal];
void mock.module("../analyzer", () => ({
  analyzeSemanticLayer: () => proposals,
}));

// The single decide seam (#4506): the tick calls it for every eligible row.
type DecideResult =
  | { outcome: "approved"; id: string }
  | { outcome: "rejected"; id: string }
  | { outcome: "already_reviewed" }
  | { outcome: "apply_failed"; id: string; reason: string; revertedToPending: boolean };
const mockDecideAmendment: Mock<(args: Record<string, unknown>) => Promise<DecideResult>> = mock(() =>
  Promise.resolve({ outcome: "approved", id: "sch-1" }),
);
void mock.module("../decide", () => ({
  decideAmendment: mockDecideAmendment,
}));

const mockInsertSemanticAmendment: Mock<
  () => Promise<{ outcome: string; id?: string; autoApproveEligible?: boolean }>
> = mock(() => Promise.resolve({ outcome: "inserted", id: "sch-1", autoApproveEligible: true }));
void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  insertSemanticAmendment: mockInsertSemanticAmendment,
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

void mock.module("@atlas/api/lib/settings", () => ({
  getSetting: () => undefined,
  // scheduler.ts reads this to force-disable on SaaS (#4487); the tick tests
  // exercise the self-hosted path, so keep it false (not SaaS).
  isSaasModeForGuard: () => false,
}));

const { runExpertSchedulerTick } = await import("../scheduler");

describe("runExpertSchedulerTick auto-approve → decide seam (#4486, #4506)", () => {
  beforeEach(() => {
    proposals = [proposal];
    mockDecideAmendment.mockClear();
    mockDecideAmendment.mockResolvedValue({ outcome: "approved", id: "sch-1" });
    mockInsertSemanticAmendment.mockClear();
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "inserted", id: "sch-1", autoApproveEligible: true });
  });

  it("routes an eligible proposal through the decide seam and counts it auto-approved", async () => {
    const result = await runExpertSchedulerTick();

    expect(mockDecideAmendment).toHaveBeenCalledTimes(1);
    // The seam is asked to APPROVE the freshly-inserted row under the auto
    // origin — self-hosted global scope.
    expect(mockDecideAmendment.mock.calls[0][0]).toMatchObject({
      id: "sch-1",
      orgId: null,
      decision: "approved",
      reviewedBy: "auto-approve",
    });
    expect(result.autoApproved).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("counts an errored (apply_failed) decide as an error — the seam owns the revert", async () => {
    mockDecideAmendment.mockResolvedValue({
      outcome: "apply_failed",
      id: "sch-1",
      reason: "entity not found",
      revertedToPending: true,
    });

    const result = await runExpertSchedulerTick();

    expect(mockDecideAmendment).toHaveBeenCalledTimes(1);
    expect(result.autoApproved).toBe(0);
    expect(result.errors).toBe(1);
  });

  it("counts an already_reviewed decide as queued (a racing decision moved the fresh row)", async () => {
    mockDecideAmendment.mockResolvedValue({ outcome: "already_reviewed" });

    const result = await runExpertSchedulerTick();

    expect(mockDecideAmendment).toHaveBeenCalledTimes(1);
    expect(result.autoApproved).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.queued).toBe(1);
  });

  it("does not call the seam when the proposal is not auto-approve-eligible", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "inserted", id: "sch-2", autoApproveEligible: false });

    const result = await runExpertSchedulerTick();

    expect(mockDecideAmendment).not.toHaveBeenCalled();
    expect(result.queued).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("counts a rejected identity as suppressed — no decide, no queue (#4507)", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "rejected", id: "rej-1" });

    const result = await runExpertSchedulerTick();

    expect(mockDecideAmendment).not.toHaveBeenCalled();
    expect(result.rejected).toBe(1);
    expect(result.queued).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("counts an already-pending identity as deduped — no decide, no queue (#4507)", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "already_pending", id: "pend-1" });

    const result = await runExpertSchedulerTick();

    expect(mockDecideAmendment).not.toHaveBeenCalled();
    expect(result.deduped).toBe(1);
    expect(result.queued).toBe(0);
    expect(result.errors).toBe(0);
  });
});
