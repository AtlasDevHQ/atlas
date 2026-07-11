/**
 * runExpertSchedulerTick auto-approve invariant (#4486, #4506).
 *
 * Every proposal is inserted `pending`; eligible ones route through the decide
 * seam (`decideAmendment`), which owns claim → apply → stamp. This pins the
 * behaviors the invariant "status='approved' ⇒ applied" depends on, so a
 * future edit that bypasses the seam or mishandles its outcomes ships red:
 *   - eligible + seam approves     → autoApproved
 *   - eligible + seam throws       → counted as an error (the seam has already
 *                                     compensated the row back to pending)
 *   - eligible + already decided   → counted as queued, never a second apply
 *   - not eligible                 → queued, the seam never invoked
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

// The tick routes eligible inserts through the decide seam — mock it directly
// (its own claim/apply/stamp mechanics are unit-tested in decide.test.ts and
// the route suite).
type DecideOutcome = { kind: "approved" | "rejected" | "not_pending"; id: string };
const mockDecideAmendment: Mock<
  (params: { id: string; orgId: string | null; decision: string; reviewedBy: string; requestId: string }) => Promise<DecideOutcome>
> = mock(async (params) => ({ kind: "approved", id: params.id }));
void mock.module("../decide", () => ({
  decideAmendment: mockDecideAmendment,
}));

const mockInsertSemanticAmendment: Mock<() => Promise<{ id: string; autoApprove: boolean }>> = mock(() =>
  Promise.resolve({ id: "sch-1", autoApprove: true }),
);
void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  insertSemanticAmendment: mockInsertSemanticAmendment,
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

void mock.module("@atlas/api/lib/settings", () => ({
  getSetting: () => undefined,
  // scheduler.ts now reads this to force-disable on SaaS (#4487); the tick
  // tests exercise the self-hosted path, so keep it false (not SaaS).
  isSaasModeForGuard: () => false,
}));

const { runExpertSchedulerTick } = await import("../scheduler");

describe("runExpertSchedulerTick auto-approve → decide seam invariant (#4486, #4506)", () => {
  beforeEach(() => {
    proposals = [proposal];
    mockDecideAmendment.mockClear();
    mockDecideAmendment.mockImplementation(async (params) => ({ kind: "approved", id: params.id }));
    mockInsertSemanticAmendment.mockClear();
    mockInsertSemanticAmendment.mockResolvedValue({ id: "sch-1", autoApprove: true });
  });

  it("routes an eligible proposal through the decide seam with the insert's id", async () => {
    const result = await runExpertSchedulerTick();

    expect(mockDecideAmendment).toHaveBeenCalledTimes(1);
    const [params] = mockDecideAmendment.mock.calls[0];
    expect(params).toMatchObject({
      id: "sch-1",
      orgId: null,
      decision: "approved",
      reviewedBy: "expert-scheduler",
    });
    expect(result.autoApproved).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("counts an error when the seam's apply fails (row already compensated to pending)", async () => {
    mockDecideAmendment.mockImplementation(async () => {
      throw new Error("entity not found");
    });

    const result = await runExpertSchedulerTick();

    expect(mockDecideAmendment).toHaveBeenCalledTimes(1);
    expect(result.autoApproved).toBe(0);
    expect(result.errors).toBe(1);
  });

  it("counts queued (never autoApproved) when a concurrent decision beat the tick", async () => {
    mockDecideAmendment.mockImplementation(async (params) => ({ kind: "not_pending", id: params.id }));

    const result = await runExpertSchedulerTick();

    expect(result.autoApproved).toBe(0);
    expect(result.queued).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("does not invoke the seam when the proposal is not auto-approve eligible", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ id: "sch-2", autoApprove: false });

    const result = await runExpertSchedulerTick();

    expect(mockDecideAmendment).not.toHaveBeenCalled();
    expect(result.queued).toBe(1);
    expect(result.errors).toBe(0);
  });
});
